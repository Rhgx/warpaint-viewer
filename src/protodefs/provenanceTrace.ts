// Provenance tracing for resolved recipe values. Runs beside the resolver, never inside it.
import { many, type ItemDefinitionMsg, type ItemMsg, type Many, type OperationMsg, type OperationNodeMsg, type PaintkitDefinitionMsg, type VarDefMsg, type VarFieldMsg } from './messages';
import type { ResolveCtx } from './resolve';
import { manyEntryPath, slotSourcePath } from './decoderShared';
import { varFieldValue, type VarEntry } from './values';
import type { ProtoDefValueProvenance, ProtoDefValueTrace } from './types';

// Provenance tracing runs beside the resolver, not inside it, so the recipe path is unchanged.

interface TracedVarEntry extends VarEntry {
  provenance: ProtoDefValueProvenance;
}

type TracedDict = Map<string, TracedVarEntry>;

function literalFieldValue(field: VarFieldMsg | undefined): string | undefined {
  return varFieldValue(field && { ...field, variable: undefined }, new Map());
}

function buildTracedVarDict(
  variables: Many<VarDefMsg>,
  sourceRoot: string[],
): TracedDict {
  const dict: TracedDict = new Map();
  many(variables).forEach((variable, index) => {
    const variablePath = manyEntryPath(sourceRoot, variables, index);
    dict.set(variable.name, {
      value: variable.value ?? '',
      canOverride: variable.inherit !== false,
      provenance: {
        variableName: variable.name,
        effectiveValue: variable.value ?? '',
        sourcePath: [...variablePath, 'value'],
        editableSourcePath: [...variablePath, 'value'],
        scope: 'global',
        canOverride: variable.inherit !== false,
      },
    });
  });
  return dict;
}

function applyTracedFieldOverrides(
  dict: TracedDict,
  fields: Many<VarFieldMsg>,
  sourceRoot: string[],
  scope: 'weapon' | 'wear',
): void {
  many(fields).forEach((field, index) => {
    const fieldPath = manyEntryPath(sourceRoot, fields, index);
    const entry = field.variable == null ? undefined : dict.get(field.variable);
    const value = literalFieldValue(field);
    if (!entry || !entry.canOverride || value === undefined) return;
    entry.value = value;
    entry.provenance = {
      variableName: field.variable,
      effectiveValue: value,
      sourcePath: fieldPath,
      // Weapon-slot overrides are editable, scoped to one weapon. Wear and item-definition
      // overrides live in the shared base container and cannot be written safely.
      ...(sourceRoot[0] === 'definition' ? { editableSourcePath: fieldPath } : {}),
      scope,
      canOverride: entry.canOverride,
    };
  });
}

function applyTracedDefOverrides(
  dict: TracedDict,
  definitions: Many<VarDefMsg>,
  sourceRoot: string[],
): void {
  many(definitions).forEach((definition, index) => {
    const definitionPath = manyEntryPath(sourceRoot, definitions, index);
    const entry = dict.get(definition.name);
    if (!entry?.canOverride) return;
    const value = definition.value ?? '';
    entry.value = value;
    entry.provenance = {
      variableName: definition.name,
      effectiveValue: value,
      sourcePath: [...definitionPath, 'value'],
      scope: 'weapon',
      canOverride: entry.canOverride,
    };
  });
}

function traceField(
  field: VarFieldMsg | undefined,
  fieldPath: string[],
  dict: TracedDict,
  output: ProtoDefValueTrace[],
): void {
  if (!field) return;
  const variable = field.variable;
  const entry = variable === undefined ? undefined : dict.get(variable);
  if (entry) {
    output.push({ fieldPath, provenance: { ...entry.provenance, effectiveValue: entry.value } });
    return;
  }
  output.push({
    fieldPath,
    provenance: {
      ...(variable === undefined ? {} : { variableName: variable }),
      effectiveValue: literalFieldValue(field),
      sourcePath: fieldPath,
      scope: 'literal',
      canOverride: false,
    },
  });
}

function traceCommonTransforms(
  stage: {
    adjust_black?: VarFieldMsg; adjust_offset?: VarFieldMsg; adjust_gamma?: VarFieldMsg;
    rotation?: VarFieldMsg; translate_u?: VarFieldMsg; translate_v?: VarFieldMsg;
    scale_uv?: VarFieldMsg; flip_u?: VarFieldMsg; flip_v?: VarFieldMsg;
  },
  path: string[],
  dict: TracedDict,
  output: ProtoDefValueTrace[],
): void {
  for (const name of ['adjust_black', 'adjust_offset', 'adjust_gamma', 'rotation', 'translate_u', 'translate_v', 'scale_uv', 'flip_u', 'flip_v'] as const) {
    traceField(stage[name], [...path, name], dict, output);
  }
}

function traceNodes(
  nodes: Many<OperationNodeMsg>,
  ctx: ResolveCtx,
  dict: TracedDict,
  team: 'red' | 'blu',
  path: string[],
  output: ProtoDefValueTrace[],
  seenTemplates: Set<number>,
): void {
  many(nodes).forEach((node, index) => {
    const nodePath = manyEntryPath(path, nodes, index);
    if (node.operation_template) {
      const templateId = node.operation_template.defindex;
      const template = ctx.opByIdx.get(templateId);
      if (template && !seenTemplates.has(templateId)) {
        const nextSeen = new Set(seenTemplates);
        nextSeen.add(templateId);
        traceNodes(template.operation_node, ctx, dict, team, ['operationTemplate', String(templateId), 'operation_node'], output, nextSeen);
      }
      return;
    }
    const stage = node.stage;
    if (!stage) return;
    const stagePath = [...nodePath, 'stage'];
    if (stage.texture_lookup) {
      const value = stage.texture_lookup;
      const textureName = team === 'blu' && value.texture_blue ? 'texture_blue' : team === 'red' && value.texture_red ? 'texture_red' : 'texture';
      traceField(value[textureName], [...stagePath, 'texture_lookup', textureName], dict, output);
      traceCommonTransforms(value, [...stagePath, 'texture_lookup'], dict, output);
    } else if (stage.combine_multiply || stage.combine_add || stage.combine_lerp) {
      const name = stage.combine_multiply ? 'combine_multiply' : stage.combine_add ? 'combine_add' : 'combine_lerp';
      const value = stage[name];
      if (!value) return;
      traceCommonTransforms(value, [...stagePath, name], dict, output);
      traceNodes(value.operation_node, ctx, dict, team, [...stagePath, name, 'operation_node'], output, seenTemplates);
    } else if (stage.select) {
      traceField(stage.select.groups, [...stagePath, 'select', 'groups'], dict, output);
      const selectFields = stage.select.select;
      many(selectFields).forEach((field, selectIndex) => traceField(
        field,
        manyEntryPath([...stagePath, 'select', 'select'], selectFields, selectIndex),
        dict,
        output,
      ));
    } else if (stage.apply_sticker) {
      const value = stage.apply_sticker;
      const stickers = value.sticker;
      many(stickers).forEach((sticker, stickerIndex) => {
        const stickerPath = manyEntryPath([...stagePath, 'apply_sticker', 'sticker'], stickers, stickerIndex);
        for (const name of ['base', 'weight', 'spec'] as const) traceField(sticker[name], [...stickerPath, name], dict, output);
      });
      for (const name of ['dest_tl', 'dest_tr', 'dest_bl', 'adjust_black', 'adjust_offset', 'adjust_gamma'] as const) {
        traceField(value[name], [...stagePath, 'apply_sticker', name], dict, output);
      }
      traceNodes(value.operation_node, ctx, dict, team, [...stagePath, 'apply_sticker', 'operation_node'], output, seenTemplates);
    }
  });
}

export function traceResolvedValues(
  paintkitDef: PaintkitDefinitionMsg,
  slotItem: ItemMsg,
  itemDef: ItemDefinitionMsg,
  wearIdx: number,
  team: 'red' | 'blu',
  ctx: ResolveCtx,
): ProtoDefValueTrace[] {
  let operationMsg: OperationMsg | null = null;
  let headerVariables = paintkitDef.header.variables;
  let headerPath = ['definition', 'header', 'variables'];
  if (paintkitDef.operation_template) operationMsg = ctx.opByIdx.get(paintkitDef.operation_template.defindex) ?? null;
  const definitions = many(itemDef.definition);
  const clampedIdx = Math.max(0, Math.min(wearIdx, definitions.length - 1));
  const perWearDef = definitions[clampedIdx];
  if (perWearDef?.operation_template) {
    const override = ctx.opByIdx.get(perWearDef.operation_template.defindex);
    if (override) {
      operationMsg = override;
      headerVariables = override.header.variables;
      headerPath = ['operation', 'header', 'variables'];
    }
  }
  if (!operationMsg) return [];

  const dict = buildTracedVarDict(headerVariables, headerPath);
  const slotPath = slotSourcePath(paintkitDef, slotItem);
  applyTracedFieldOverrides(dict, slotItem.data?.variable, [...slotPath, 'data', 'variable'], 'weapon');
  applyTracedDefOverrides(dict, itemDef.header?.variables, ['itemDefinition', String(itemDef.header.defindex), 'header', 'variables']);
  if (perWearDef) {
    const wearPath = manyEntryPath(
      ['itemDefinition', String(itemDef.header.defindex), 'definition'],
      itemDef.definition,
      clampedIdx,
    );
    applyTracedFieldOverrides(dict, perWearDef.variable, [...wearPath, 'variable'], 'wear');
  }

  const output: ProtoDefValueTrace[] = [];
  traceNodes(operationMsg.operation_node, ctx, dict, team, ['operation', 'operation_node'], output, new Set([operationMsg.header.defindex]));
  return output;
}

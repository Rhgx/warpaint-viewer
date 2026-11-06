import type { ProtoDefKitMessages, ProtoDefValueTrace } from '../../protodefs/types';
import {
  many,
  type Many,
  type OperationNodeMsg,
  type SelectStageMsg,
  type TextureStageMsg,
  type VarDefMsg,
  type VarFieldMsg,
} from '../../protodefs/messages';
import type {
  TextureTransformFieldFactMap,
  TextureTransformFieldFacts,
  TextureTransformFlipField,
  TextureTransformRangeField,
  TextureTransformTarget,
} from './transformMutations';
import { collectVariables } from '../layers/groupTargets';

/** Proto defaults for the four range fields, mirrored from the resolver for parsing. */
const RANGE_DEFAULTS: Record<TextureTransformRangeField, readonly [number, number]> = {
  rotation: [0, 0],
  scale_uv: [1, 1],
  translate_u: [0, 0],
  translate_v: [0, 0],
};

type TextureTransformFieldBlocker = 'unresolved-value' | 'invalid-value';

export interface TextureTransformRangeFieldState {
  readonly mode: 'fixed' | 'varies';
  readonly min: number;
  readonly max: number;
  /** The authored stage field names a variable rather than a literal. */
  readonly variable: boolean;
  /** The field's header variable is unique and does not opt out of inheritance. */
  readonly headerInherits: boolean;
  readonly blockers: readonly TextureTransformFieldBlocker[];
}

interface TextureTransformFlipFieldState {
  readonly allowed: boolean;
  /** The authored stage field names a variable rather than a literal. */
  readonly variable: boolean;
  /** The field's header variable is unique and does not opt out of inheritance. */
  readonly headerInherits: boolean;
  readonly blockers: readonly TextureTransformFieldBlocker[];
}

type TextureTransformTargetBlocker =
  | 'no-texture-lookup-stage'
  | 'ambiguous-source-stage'
  | TextureTransformFieldBlocker;

export interface TextureTransformTargetInfo {
  readonly target: TextureTransformTarget;
  /** The authored texture this stage samples, when it resolves to a single literal. */
  readonly textureRef?: string;
  readonly rotation: TextureTransformRangeFieldState;
  readonly scaleUv: TextureTransformRangeFieldState;
  readonly translateU: TextureTransformRangeFieldState;
  readonly translateV: TextureTransformRangeFieldState;
  readonly flipU: TextureTransformFlipFieldState;
  readonly flipV: TextureTransformFlipFieldState;
  /** Empty when every field on this layer is safely editable. */
  readonly blockers: readonly TextureTransformTargetBlocker[];
  /** Set when the layer masks a combine: the index of the combine child whose texture this edits. */
  readonly layerChildIndex?: number;
}

export interface TextureTransformDiscovery {
  /** Aligned by position with discoverGroupSelectTargets().targets (same traversal order). Never null in practice. */
  targets: (TextureTransformTargetInfo | null)[];
}

export interface BaseTextureTransformTarget {
  readonly label: string;
  readonly textureRef: string;
  readonly transform: TextureTransformTargetInfo;
  /** Weapon albedo is visible for assignment context but its placement is authored by the model. */
  readonly transformLocked: boolean;
}

function literalFieldValue(field: VarFieldMsg): string | undefined {
  for (const key of ['string', 'float', 'double', 'uint32', 'uint64', 'sint32', 'sint64', 'bool'] as const) {
    if (field[key] !== undefined) return String(field[key]);
  }
  return undefined;
}

/**
 * Weapon-local variable collection where a new override can be written for the active weapon.
 * Every weapon-scoped trace shares one source root, so this is undefined when traces disagree.
 */
function findWeaponOverrideCollectionPath(
  provenance: readonly ProtoDefValueTrace[] | undefined,
): readonly string[] | undefined {
  if (!provenance) return undefined;
  const seen = new Set<string>();
  let candidate: readonly string[] | undefined;
  for (const entry of provenance) {
    if (entry.provenance.scope !== 'weapon') continue;
    const path = entry.provenance.editableSourcePath;
    if (!path || path[0] !== 'definition' || path[1] === 'header') continue;
    let collection: readonly string[] | undefined;
    if (path.at(-1) === 'variable') collection = path;
    else if (path.at(-2) === 'variable' && /^\d+$/.test(path.at(-1) ?? '')) collection = path.slice(0, -1);
    if (!collection) continue;
    const marker = collection.join('\0');
    if (!seen.has(marker)) {
      seen.add(marker);
      candidate = collection;
    }
  }
  return seen.size === 1 ? candidate : undefined;
}

/** Whether the field's header variable is unique and inherits. Only then can a weapon override leave other weapons unchanged. */
function headerInherits(
  field: VarFieldMsg | undefined,
  variables: ReadonlyMap<string, VarDefMsg[]>,
): boolean {
  if (!field?.variable) return false;
  const matches = variables.get(field.variable);
  return matches?.length === 1 && matches[0].inherit !== false;
}

function parseAuthoredRange(
  raw: string | undefined,
  fallback: readonly [number, number],
): { mode: 'fixed' | 'varies'; min: number; max: number } | null {
  if (raw === undefined) return { mode: 'fixed', min: fallback[0], max: fallback[1] };
  const numbers = raw.trim().split(/\s+/).filter(Boolean).map(Number);
  if (numbers.length === 0 || numbers.some((value) => !Number.isFinite(value))) return null;
  if (numbers.length === 1) return { mode: 'fixed', min: numbers[0], max: numbers[0] };
  return { mode: 'varies', min: numbers[0], max: numbers[1] };
}

function parseAuthoredBool(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const value = raw.trim().toLowerCase();
  return value === '1' || value === 'true';
}

interface ResolvedFieldValue {
  value?: string;
  /** Exact weapon-local source, when this field's variable already has one. */
  sourcePath?: readonly string[];
}

function weaponOverrideValue(
  messages: ProtoDefKitMessages,
  collectionPath: readonly string[] | undefined,
  variableName: string | undefined,
): { value: string; sourcePath: readonly string[] } | null {
  if (!collectionPath || !variableName || collectionPath[0] !== 'definition') return null;
  let cursor: unknown = messages.definition;
  for (const part of collectionPath.slice(1)) {
    if (Array.isArray(cursor)) {
      const index = Number(part);
      cursor = Number.isInteger(index) ? cursor[index] : undefined;
    } else if (cursor && typeof cursor === 'object') {
      cursor = (cursor as Record<string, unknown>)[part];
    } else {
      return null;
    }
  }
  const fields = many(cursor as Many<VarFieldMsg>);
  const matches = fields.flatMap((field, index) => field.variable === variableName ? [{ field, index }] : []);
  if (matches.length !== 1) return null;
  const value = literalFieldValue(matches[0].field);
  if (value === undefined) return null;
  return {
    value,
    sourcePath: Array.isArray(cursor) ? [...collectionPath, String(matches[0].index)] : collectionPath,
  };
}

/** Reads a field's effective value: the active weapon's traced value when available, else the shared header default. */
function resolveFieldValue(
  field: VarFieldMsg | undefined,
  fieldPath: readonly string[],
  variables: ReadonlyMap<string, VarDefMsg[]>,
  provenance: readonly ProtoDefValueTrace[] | undefined,
): ResolvedFieldValue {
  if (!field) return {};
  if (!field.variable) return { value: literalFieldValue(field) };

  const marker = fieldPath.join('\0');
  const trace = provenance?.find((entry) => entry.fieldPath.join('\0') === marker);
  const matches = variables.get(field.variable);
  if (trace) {
    const editable = trace.provenance.editableSourcePath;
    const sourcePath = editable && editable[0] === 'definition' && editable[1] !== 'header' ? editable : undefined;
    return { value: trace.provenance.effectiveValue, sourcePath };
  }
  return { value: matches?.length === 1 ? matches[0].value : undefined };
}

function buildRangeField(
  messages: ProtoDefKitMessages,
  field: VarFieldMsg | undefined,
  stagePath: readonly string[],
  fieldName: TextureTransformRangeField,
  variables: ReadonlyMap<string, VarDefMsg[]>,
  provenance: readonly ProtoDefValueTrace[] | undefined,
  weaponOverridePath: readonly string[] | undefined,
): { state: TextureTransformRangeFieldState; sourcePath?: readonly string[] } {
  const fallback = RANGE_DEFAULTS[fieldName];
  const traced = resolveFieldValue(field, [...stagePath, fieldName], variables, provenance);
  const resolved = weaponOverrideValue(messages, weaponOverridePath, field?.variable) ?? traced;
  const parsed = field === undefined ? { mode: 'fixed' as const, min: fallback[0], max: fallback[1] } : parseAuthoredRange(resolved.value, fallback);
  const blockers: TextureTransformFieldBlocker[] = [];
  if (field !== undefined && parsed === null) blockers.push('invalid-value');
  if (field?.variable !== undefined && resolved.value === undefined) blockers.push('unresolved-value');
  return {
    state: {
      mode: parsed?.mode ?? 'fixed',
      min: parsed?.min ?? fallback[0],
      max: parsed?.max ?? fallback[1],
      variable: Boolean(field?.variable),
      headerInherits: headerInherits(field, variables),
      blockers,
    },
    sourcePath: resolved.sourcePath,
  };
}

function buildFlipField(
  messages: ProtoDefKitMessages,
  field: VarFieldMsg | undefined,
  stagePath: readonly string[],
  fieldName: TextureTransformFlipField,
  variables: ReadonlyMap<string, VarDefMsg[]>,
  provenance: readonly ProtoDefValueTrace[] | undefined,
  weaponOverridePath: readonly string[] | undefined,
): { state: TextureTransformFlipFieldState; sourcePath?: readonly string[] } {
  const traced = resolveFieldValue(field, [...stagePath, fieldName], variables, provenance);
  const resolved = weaponOverrideValue(messages, weaponOverridePath, field?.variable) ?? traced;
  const blockers: TextureTransformFieldBlocker[] = [];
  if (field?.variable !== undefined && resolved.value === undefined) blockers.push('unresolved-value');
  return {
    state: {
      allowed: parseAuthoredBool(resolved.value),
      variable: Boolean(field?.variable),
      headerInherits: headerInherits(field, variables),
      blockers,
    },
    sourcePath: resolved.sourcePath,
  };
}

function textureRefOf(stage: TextureStageMsg, variables: ReadonlyMap<string, VarDefMsg[]>): string | undefined {
  const field = stage.texture;
  if (!field) return undefined;
  if (!field.variable) return field.string;
  const matches = variables.get(field.variable);
  return matches?.length === 1 ? matches[0].value : undefined;
}

function textureFieldRef(field: VarFieldMsg, variables: ReadonlyMap<string, VarDefMsg[]>): string | undefined {
  if (!field.variable) return field.string;
  const matches = variables.get(field.variable);
  return matches?.length === 1 ? matches[0].value : field.string;
}

function blockedTarget(reason: TextureTransformTargetBlocker): TextureTransformTargetInfo {
  const emptyRange: TextureTransformRangeFieldState = {
    mode: 'fixed', min: 0, max: 0, variable: false, headerInherits: false, blockers: [],
  };
  const emptyFlip: TextureTransformFlipFieldState = { allowed: false, variable: false, headerInherits: false, blockers: [] };
  return {
    target: { stagePath: [] },
    rotation: emptyRange,
    scaleUv: { ...emptyRange, min: 1, max: 1 },
    translateU: emptyRange,
    translateV: emptyRange,
    flipU: emptyFlip,
    flipV: emptyFlip,
    blockers: [reason],
  };
}

function buildTarget(
  messages: ProtoDefKitMessages,
  precedingNode: OperationNodeMsg | undefined,
  precedingPath: readonly string[] | undefined,
  variables: ReadonlyMap<string, VarDefMsg[]>,
  provenance: readonly ProtoDefValueTrace[] | undefined,
  weaponOverridePath: readonly string[] | undefined,
): TextureTransformTargetInfo {
  if (!precedingNode || !precedingPath) return blockedTarget('no-texture-lookup-stage');
  const authoredStage = precedingNode.stage;
  if (!authoredStage) return blockedTarget('ambiguous-source-stage');
  const transformStage = authoredStage.texture_lookup;
  if (!transformStage) return blockedTarget('ambiguous-source-stage');

  const stagePath = [...precedingPath, 'stage', 'texture_lookup'];
  const rotation = buildRangeField(messages, transformStage.rotation, stagePath, 'rotation', variables, provenance, weaponOverridePath);
  const scaleUv = buildRangeField(messages, transformStage.scale_uv, stagePath, 'scale_uv', variables, provenance, weaponOverridePath);
  const translateU = buildRangeField(messages, transformStage.translate_u, stagePath, 'translate_u', variables, provenance, weaponOverridePath);
  const translateV = buildRangeField(messages, transformStage.translate_v, stagePath, 'translate_v', variables, provenance, weaponOverridePath);
  const flipU = buildFlipField(messages, transformStage.flip_u, stagePath, 'flip_u', variables, provenance, weaponOverridePath);
  const flipV = buildFlipField(messages, transformStage.flip_v, stagePath, 'flip_v', variables, provenance, weaponOverridePath);

  const fieldSourcePaths: TextureTransformTarget['fieldSourcePaths'] = {};
  const fields: [TextureTransformRangeField | TextureTransformFlipField, { sourcePath?: readonly string[] }][] = [
    ['rotation', rotation], ['scale_uv', scaleUv], ['translate_u', translateU], ['translate_v', translateV],
    ['flip_u', flipU], ['flip_v', flipV],
  ];
  for (const [key, built] of fields) {
    if (built.sourcePath) fieldSourcePaths[key] = built.sourcePath;
  }

  const blockers = [...new Set([
    ...rotation.state.blockers, ...scaleUv.state.blockers, ...translateU.state.blockers, ...translateV.state.blockers,
    ...flipU.state.blockers, ...flipV.state.blockers,
  ])];

  return {
    target: {
      stagePath,
      ...(Object.keys(fieldSourcePaths).length > 0 ? { fieldSourcePaths } : {}),
      ...(weaponOverridePath ? { weaponOverridePath } : {}),
    },
    textureRef: textureRefOf(transformStage, variables),
    rotation: rotation.state,
    scaleUv: scaleUv.state,
    translateU: translateU.state,
    translateV: translateV.state,
    flipU: flipU.state,
    flipV: flipV.state,
    blockers,
  };
}

/**
 * TF2 ignores a combine's UV fields, so a multiply layer's transform lives on the child its
 * selector names (`texture_layer_4_select_1` names `texture_layer_4`). Null unless exactly one child matches.
 */
function combineLayerChild(
  combineNode: OperationNodeMsg,
  combinePath: readonly string[],
  select: SelectStageMsg,
): { node: OperationNodeMsg; path: readonly string[]; index: number } | null {
  const stage = combineNode.stage;
  const key = stage?.combine_multiply ? 'combine_multiply' : stage?.combine_add ? 'combine_add' : stage?.combine_lerp ? 'combine_lerp' : null;
  const stem = many(select.select).find((field) => field.variable)?.variable?.replace(/_select_\d+$/i, '');
  if (!stage || !key || !stem) return null;
  const children = stage[key]?.operation_node;
  const isArray = Array.isArray(children);
  const matches = many(children).flatMap((child, index) => {
    const lookup = child.stage?.texture_lookup;
    const names = [lookup?.texture, lookup?.texture_red, lookup?.texture_blue].map((field) => field?.variable);
    return names.some((name) => name === stem || name?.startsWith(`${stem}_`)) ? [{ child, index }] : [];
  });
  if (matches.length !== 1) return null;
  const { child, index } = matches[0];
  const childrenPath = [...combinePath, 'stage', key, 'operation_node'];
  return { node: child, path: isArray ? [...childrenPath, String(index)] : childrenPath, index };
}

/** Visits select stages in the same order as discoverGroupSelectTargets(), keeping the two index-aligned. */
function walk(
  nodes: Many<OperationNodeMsg>,
  path: readonly string[],
  visit: (
    precedingNode: OperationNodeMsg | undefined,
    precedingPath: readonly string[] | undefined,
    select: SelectStageMsg,
  ) => void,
): void {
  const entries = many(nodes);
  const isArray = Array.isArray(nodes);
  for (let index = 0; index < entries.length; index += 1) {
    const node = entries[index];
    const nodePath = isArray ? [...path, String(index)] : path;
    const stage = node.stage;
    if (!stage) continue;
    if (stage.select) {
      const precedingIndex = index - 1;
      const precedingNode = precedingIndex >= 0 ? entries[precedingIndex] : undefined;
      const precedingPath = precedingIndex >= 0 ? (isArray ? [...path, String(precedingIndex)] : path) : undefined;
      visit(precedingNode, precedingPath, stage.select);
    }
    for (const [key, combine] of [
      ['combine_multiply', stage.combine_multiply],
      ['combine_add', stage.combine_add],
      ['combine_lerp', stage.combine_lerp],
    ] as const) {
      if (combine) walk(combine.operation_node, [...nodePath, 'stage', key, 'operation_node'], visit);
    }
    if (stage.apply_sticker) walk(stage.apply_sticker.operation_node, [...nodePath, 'stage', 'apply_sticker', 'operation_node'], visit);
  }
}

function textureLabel(textureRef: string): string {
  const base = textureRef.replace(/\\/g, '/').split('/').at(-1)?.replace(/^p_/i, '') ?? 'Base Texture';
  const words = base.split(/[_\-\s]+/).filter(Boolean);
  if (words.length > 1 && /^\d{6,}$/.test(words[0])) words.shift();
  return words.map((word) => (
    /^\d+$/.test(word) ? word : word[0].toUpperCase() + word.slice(1)
  )).join(' ');
}

/** Discover the unmasked texture stage that forms the recipe's base coat. */
export function discoverBaseTextureTransformTarget(
  messages: ProtoDefKitMessages,
  provenance?: readonly ProtoDefValueTrace[],
): BaseTextureTransformTarget | null {
  const variables = collectVariables(messages);
  const weaponOverridePath = findWeaponOverrideCollectionPath(provenance);
  const layerOneMatches: BaseTextureTransformTarget[] = [];
  const fallbackMatches: BaseTextureTransformTarget[] = [];
  const visit = (nodes: Many<OperationNodeMsg>, path: readonly string[]): void => {
    const entries = many(nodes);
    const isArray = Array.isArray(nodes);
    entries.forEach((node, index) => {
      const nodePath = isArray ? [...path, String(index)] : path;
      const stage = node.stage;
      if (!stage) return;
      const textureLookup = stage.texture_lookup;
      if (textureLookup) {
        const fields = [
          ['texture', textureLookup.texture],
          ['texture_red', textureLookup.texture_red],
          ['texture_blue', textureLookup.texture_blue],
        ] as const;
        const traced = fields.flatMap(([fieldName, field]) => {
          if (!field) return [];
          const fieldPath = [...nodePath, 'stage', 'texture_lookup', fieldName];
          const trace = provenance?.find((entry) => entry.fieldPath.join('\0') === fieldPath.join('\0'));
          return [{ field, trace }];
        });
        const layerOne = traced.find(({ field, trace }) => (
          trace !== undefined && (field.variable === 'texture_layer_1' || field.variable === 'texture_layer_1_blue')
        )) ?? traced.find(({ field }) => field.variable === 'texture_layer_1')
          ?? traced.find(({ field }) => field.variable === 'texture_layer_1_blue');
        const fallback = traced.find(({ field, trace }) => (
          trace !== undefined && (field.variable === 'weapon_albedo' || field.variable === 'custom_painted')
        )) ?? traced.find(({ field }) => field.variable === 'custom_painted')
          ?? traced.find(({ field }) => field.variable === 'weapon_albedo');
        const candidate = layerOne ?? fallback;
        const effectiveRef = candidate?.trace?.provenance.effectiveValue
          ?? (candidate ? textureFieldRef(candidate.field, variables) : undefined);
        if (candidate && effectiveRef) (layerOne ? layerOneMatches : fallbackMatches).push({
          label: textureLabel(effectiveRef),
          textureRef: effectiveRef,
          transform: buildTarget(messages, node, nodePath, variables, provenance, weaponOverridePath),
          transformLocked: candidate.field.variable === 'weapon_albedo',
        });
      }
      for (const [key, combine] of [
        ['combine_multiply', stage.combine_multiply],
        ['combine_add', stage.combine_add],
        ['combine_lerp', stage.combine_lerp],
      ] as const) {
        if (combine) visit(combine.operation_node, [...nodePath, 'stage', key, 'operation_node']);
      }
      if (stage.apply_sticker) visit(stage.apply_sticker.operation_node, [...nodePath, 'stage', 'apply_sticker', 'operation_node']);
    });
  };
  const operation = messages.operation as { operation_node?: Many<OperationNodeMsg> };
  visit(operation.operation_node, ['operation', 'operation_node']);
  const matches = layerOneMatches.length > 0 ? layerOneMatches : fallbackMatches;
  return matches.findLast((match) => match.transform.blockers.length === 0) ?? matches.at(-1) ?? null;
}

/** Per paint layer, the texture stage its selector masks: the preceding texture sibling, or the combine child the selector names. */
export function discoverTextureTransformTargets(
  messages: ProtoDefKitMessages,
  provenance?: readonly ProtoDefValueTrace[],
): TextureTransformDiscovery {
  const operation = messages.operation as { operation_node?: Many<OperationNodeMsg> };
  const variables = collectVariables(messages);
  const weaponOverridePath = findWeaponOverrideCollectionPath(provenance);
  const targets: (TextureTransformTargetInfo | null)[] = [];
  walk(operation.operation_node, ['operation', 'operation_node'], (precedingNode, precedingPath, select) => {
    const child = precedingNode && precedingPath ? combineLayerChild(precedingNode, precedingPath, select) : null;
    targets.push(child
      ? { ...buildTarget(messages, child.node, child.path, variables, provenance, weaponOverridePath), layerChildIndex: child.index }
      : buildTarget(messages, precedingNode, precedingPath, variables, provenance, weaponOverridePath));
  });
  return { targets };
}

function fieldFacts(
  state: Pick<TextureTransformRangeFieldState, 'variable' | 'headerInherits' | 'blockers'>,
): TextureTransformFieldFacts {
  return {
    variable: state.variable,
    editable: state.blockers.length === 0,
    headerInherits: state.headerInherits,
  };
}

/** Per-field facts that decide whether a weapon-scoped edit is weapon-local and whether it is editable. */
export function transformFieldFacts(info: TextureTransformTargetInfo): TextureTransformFieldFactMap {
  return {
    rotation: fieldFacts(info.rotation),
    scale_uv: fieldFacts(info.scaleUv),
    translate_u: fieldFacts(info.translateU),
    translate_v: fieldFacts(info.translateV),
    flip_u: fieldFacts(info.flipU),
    flip_v: fieldFacts(info.flipV),
  };
}

/** Both discoveries for one definition, so callers memoize them together. */
export function discoverLayerTransforms(
  messages: ProtoDefKitMessages,
  provenance?: readonly ProtoDefValueTrace[],
) {
  return {
    layers: discoverTextureTransformTargets(messages, provenance),
    base: discoverBaseTextureTransformTarget(messages, provenance),
  };
}

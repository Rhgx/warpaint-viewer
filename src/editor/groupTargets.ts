import type { ProtoDefKitMessages, ProtoDefValueTrace } from '../protodefs/types';
import { many, type Many, type OperationNodeMsg, type OperationStageMsg, type VarDefMsg, type VarFieldMsg } from '../protodefs/messages';
import type { SelectGroupTarget } from './mutations';

/**
 * A literal select stage that the editor can associate with a decoded groups
 * texture. `target` deliberately has the same identity shape accepted by
 * toggleSelectGroupId(): occurrence is counted only among select stages with
 * the identical authored `groupsValue`.
 */
export interface GroupSelectTargetInfo {
  target: SelectGroupTarget;
  /** The unmodified literal string from CMsgPaintKit_Operation_SelectStage.groups. */
  groupsRef: string;
  /** Distinct non-zero group ids that can be read without resolving variables. */
  selectedGroupIds: number[];
  /** The authored texture reference this selector masks, when it is unambiguous. */
  textureRef?: string;
  /** Human-readable name of the texture this selector masks. */
  label: string;
  /** Same key means two graph nodes are driven by the same authored slots. */
  sourceKey: string;
  /** True while at least one selector slot can still be overridden by a weapon or wear definition. */
  hasInheritedVariableValues: boolean;
  /** False when a select value is variable-backed or not a valid raw group id. */
  canToggle: boolean;
  /** Why this target is read-only. Empty for a directly editable target. */
  blockers: GroupSelectTargetBlocker[];
}

export type GroupSelectTargetBlocker =
  | 'variable-select-value'
  | 'invalid-select-value'
  | 'uneditable-weapon-select-value';

export interface GroupSelectDiscovery {
  /** Select stages with a literal groups-texture reference. */
  targets: GroupSelectTargetInfo[];
  /** True when an operation template stops traversal at an external operation. */
  hasUnexpandedOperationTemplates: boolean;
  /** True when a select stage's groups field is not a direct literal string. */
  hasUnresolvedGroupsReferences: boolean;
}

export interface ChooseGroupTargetOptions {
  /**
   * Restrict to a particular raw groups reference when the picked texture is
   * known. Supplying this avoids guessing when a paint uses multiple maps.
   */
  groupsRef?: string;
}

const LITERAL_KEYS = ['string', 'float', 'double', 'uint32', 'uint64', 'sint32', 'sint64', 'bool'] as const;

function directLiteralValue(field: VarFieldMsg | undefined): string | undefined {
  if (!field || field.variable !== undefined) return undefined;
  const present = LITERAL_KEYS.filter((key) => field[key] !== undefined);
  if (present.length !== 1) return undefined;
  return String(field[present[0]]);
}

function directLiteralGroupRef(field: VarFieldMsg | undefined): string | undefined {
  // A group texture reference is semantically a string. Treat number/bool
  // fields as unresolved rather than manufacturing a filename from them.
  if (!field || typeof field.string !== 'string') return undefined;
  const present = LITERAL_KEYS.filter((key) => field[key] !== undefined);
  return present.length === 1 ? field.string : undefined;
}

function literalGroupId(field: VarFieldMsg): number | undefined {
  const literal = directLiteralValue(field);
  if (literal === undefined) return undefined;
  // Unlike the compositor's permissive atoi compatibility path, editor
  // targeting only accepts complete integer literals. toggleSelectGroupId()
  // makes the same conservative choice before mutating an authored message.
  if (!/^(?:0|[1-9]\d*)$/.test(literal)) return undefined;
  const value = Number(literal);
  return Number.isSafeInteger(value) && value >= 0 && value <= 255 ? value : undefined;
}

function singleVariableValue(variableName: string, variables: ReadonlyMap<string, VarDefMsg[]>): string | undefined {
  const matches = variables.get(variableName);
  return matches?.length === 1 ? matches[0].value : undefined;
}

/** Resolve a texture field only when its authored value has one clear source. */
function textureReference(
  field: VarFieldMsg | undefined,
  variables: ReadonlyMap<string, VarDefMsg[]>,
): string | undefined {
  const literal = directLiteralGroupRef(field);
  if (literal !== undefined) return literal;
  if (!field?.variable) return undefined;
  return singleVariableValue(field.variable, variables);
}

/**
 * Make a Source texture reference readable without pretending to know a name
 * the definition did not provide. The basename is the stable authored texture
 * identity; its folder is deliberately omitted from the compact editor UI.
 */
function textureLabel(textureRef: string): string | undefined {
  const clean = textureRef.replace(/[?#].*$/, '').replace(/\\/g, '/').replace(/\/+$/, '');
  const base = clean.split('/').pop()
    ?.replace(/\.(?:vtf|tga|png|webp)$/i, '')
    // Source paint textures commonly use `p_` as a technical filename
    // prefix. It is not part of the texture's useful display name.
    .replace(/^p_/i, '');
  if (!base) return undefined;
  const words = base.split(/[_\-\s]+/).filter(Boolean);
  if (words.length === 0) return undefined;
  return words.map((word) => {
    if (/^\d+$/.test(word) || /^[A-Z0-9]+$/.test(word)) return word;
    return word[0].toUpperCase() + word.slice(1);
  }).join(' ');
}

function textureReferencesInNode(
  node: OperationNodeMsg | undefined,
  variables: ReadonlyMap<string, VarDefMsg[]>,
): string[] {
  if (!node?.stage) return [];
  const stage = node.stage;
  if (stage.texture_lookup) {
    const ref = textureReference(stage.texture_lookup.texture, variables);
    return ref === undefined ? [] : [ref];
  }
  const nested = stage.combine_multiply ?? stage.combine_add ?? stage.combine_lerp;
  if (nested) return many(nested.operation_node).flatMap((child) => textureReferencesInNode(child, variables));
  if (stage.apply_sticker) return many(stage.apply_sticker.operation_node)
    .flatMap((child) => textureReferencesInNode(child, variables));
  return [];
}

/**
 * A select stage is the final input of a combine operation; the sibling just
 * before it is the texture (or nested texture result) it masks. Keep this
 * deliberately conservative: a multi-texture sibling has no single honest
 * display name, so callers fall back to the selector variable name.
 */
function selectTextureReferences(
  nodes: Many<OperationNodeMsg>,
  visit: (stage: OperationStageMsg, textureRef: string | undefined) => void,
  variables: ReadonlyMap<string, VarDefMsg[]>,
  state: { hasUnexpandedOperationTemplates: boolean },
): void {
  const entries = many(nodes);
  for (let index = 0; index < entries.length; index += 1) {
    const node = entries[index];
    if (node.operation_template) state.hasUnexpandedOperationTemplates = true;
    const stage = node.stage;
    if (!stage) continue;
    if (stage.select) {
      const refs = textureReferencesInNode(entries[index - 1], variables);
      const unique = [...new Set(refs)];
      visit(stage, unique.length === 1 ? unique[0] : undefined);
    }
    for (const combine of [stage.combine_multiply, stage.combine_add, stage.combine_lerp]) {
      if (combine) selectTextureReferences(combine.operation_node, visit, variables, state);
    }
    if (stage.apply_sticker) selectTextureReferences(stage.apply_sticker.operation_node, visit, variables, state);
  }
}

/**
 * Find direct, literal group-map select stages inside the editable operation.
 * The traversal covers nested combine and sticker branches, retains authored
 * singleton/array forms, and never resolves or guesses variable values.
 */
export function discoverGroupSelectTargets(
  messages: ProtoDefKitMessages,
  provenance?: readonly ProtoDefValueTrace[],
): GroupSelectDiscovery {
  const targets: GroupSelectTargetInfo[] = [];
  const occurrences = new Map<string, number>();
  const state = { hasUnexpandedOperationTemplates: false, hasUnresolvedGroupsReferences: false };
  const operation = messages.operation as { operation_node?: Many<OperationNodeMsg> };
  const variables = new Map<string, VarDefMsg[]>();
  for (const message of [messages.definition, messages.operation]) {
    const header = message.header as { variables?: Many<VarDefMsg> } | undefined;
    for (const variable of many(header?.variables)) {
      if (variables.has(variable.name)) continue;
      const sameHeader = many(header?.variables).filter((entry) => entry.name === variable.name);
      variables.set(variable.name, sameHeader);
    }
  }

  selectTextureReferences(operation.operation_node, (stage, textureRef) => {
    const select = stage.select;
    if (!select) return;
    const groupsRef = directLiteralGroupRef(select.groups);
    if (groupsRef === undefined) {
      state.hasUnresolvedGroupsReferences = true;
      return;
    }

    const occurrence = occurrences.get(groupsRef) ?? 0;
    occurrences.set(groupsRef, occurrence + 1);
    const blockers = new Set<GroupSelectTargetBlocker>();
    const ids = new Set<number>();
    const selectFields = many(select.select);
    const headerInheritedSelectFields = selectFields.map((field) => {
      if (!field.variable) return false;
      const matches = variables.get(field.variable);
      return matches?.length === 1 && matches[0].inherit !== false;
    });
    const variableNames = selectFields.map((field) => field.variable).filter((name): name is string => Boolean(name));
    const variableStem = selectFields.find((field) => field.variable)?.variable
      ?.replace(/_select_\d+$/i, '')
      .replace(/_/g, ' ');
    for (const field of selectFields) {
      let id: number | undefined;
      if (field.variable !== undefined) {
        const matches = variables.get(field.variable);
        const value = matches?.length === 1 ? matches[0].value : undefined;
        id = value === undefined ? undefined : literalGroupId({ string: value });
        if (id === undefined) blockers.add('variable-select-value');
      } else {
        id = literalGroupId(field);
      }
      if (id === undefined) {
        if (field.variable === undefined) blockers.add('invalid-select-value');
        continue;
      }
      if (id !== 0) ids.add(id);
    }
    const valueSourcePaths = selectFields.map((field) => {
      if (!field.variable) return undefined;
      const candidates = provenance?.filter((trace) => (
        trace.provenance.variableName === field.variable
        && trace.provenance.editableSourcePath?.[0] === 'definition'
        && trace.provenance.editableSourcePath?.[1] !== 'header'
      )).map((trace) => trace.provenance.editableSourcePath!);
      const unique = [...new Map(candidates?.map((path) => [path.join('\0'), path]) ?? []).values()];
      return unique.length === 1 ? unique[0] : undefined;
    });
    const overrideParents = [...new Map(valueSourcePaths.filter((path): path is string[] => Boolean(path)).map((path) => {
      const parent = path.slice(0, -1);
      return [parent.join('\0'), parent];
    })).values()];
    const valueOverridePath = overrideParents.length === 1 ? overrideParents[0] : undefined;
    // An inherited operation slot may resolve from either this weapon's
    // editable override or the shared header default. Shared zero-padding is
    // not part of the weapon's layer capacity and must not make the complete
    // layer read-only. Without provenance, retain the conservative behavior.
    const inheritedSelectFields = headerInheritedSelectFields.map((inherits, index) => (
      inherits && (provenance === undefined || valueSourcePaths[index] !== undefined)
    ));
    const hasInheritedVariableValues = inheritedSelectFields.some(Boolean);
    if (headerInheritedSelectFields.some(Boolean) && !hasInheritedVariableValues) {
      blockers.add('uneditable-weapon-select-value');
    }
    targets.push({
      target: {
        groupsValue: groupsRef,
        occurrence,
        ...(valueSourcePaths.some(Boolean) ? { valueSourcePaths } : {}),
        ...(hasInheritedVariableValues ? { inheritedSelectValues: inheritedSelectFields } : {}),
        ...(valueOverridePath ? { valueOverridePath } : {}),
      },
      groupsRef,
      selectedGroupIds: [...ids].sort((a, b) => a - b),
      textureRef,
      label: textureRef && textureLabel(textureRef)
        ? textureLabel(textureRef)!
        : variableStem
        ? variableStem.replace(/\b\w/g, (letter) => letter.toUpperCase())
        : `Paint layer ${targets.length + 1}`,
      sourceKey: variableNames.length === selectFields.length
        ? `variables:${variableNames.join('|')}`
        : `literal:${groupsRef}:${occurrence}`,
      hasInheritedVariableValues,
      canToggle: blockers.size === 0,
      blockers: [...blockers],
    });
  }, variables, state);

  return { targets, ...state };
}

/**
 * Choose an unambiguous literal select stage for a sampled compositor bucket.
 * Prefer an editable stage that already contains the bucket; if none does,
 * fall back to the sole editable stage in the chosen groups texture. Returns
 * null instead of guessing whenever those rules leave multiple candidates.
 */
export function chooseBestSelectTargetForBucket(
  discovery: GroupSelectDiscovery,
  bucket: number,
  options: ChooseGroupTargetOptions = {},
): GroupSelectTargetInfo | null {
  if (!Number.isInteger(bucket) || bucket < 1 || bucket > 255) return null;
  const eligible = discovery.targets.filter((target) => (
    target.canToggle && (options.groupsRef === undefined || target.groupsRef === options.groupsRef)
  ));
  const selected = eligible.filter((target) => target.selectedGroupIds.includes(bucket));
  if (selected.length === 1) return selected[0];
  if (selected.length > 1) return null;
  return eligible.length === 1 ? eligible[0] : null;
}

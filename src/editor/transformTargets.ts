import type { ProtoDefKitMessages, ProtoDefValueTrace } from '../protodefs/types';
import { many, type Many, type OperationNodeMsg, type TextureStageMsg, type VarDefMsg, type VarFieldMsg } from '../protodefs/messages';
import type { TextureTransformFlipField, TextureTransformRangeField, TextureTransformTarget } from './mutations';

/** Proto defaults for the four range fields (tools/lib/resolve.mjs DEFAULTS, mirrored here for parsing). */
const RANGE_DEFAULTS: Record<TextureTransformRangeField, readonly [number, number]> = {
  rotation: [0, 0],
  scale_uv: [1, 1],
  translate_u: [0, 0],
  translate_v: [0, 0],
};

export type TextureTransformFieldBlocker = 'unresolved-value' | 'invalid-value';

export interface TextureTransformRangeFieldState {
  readonly mode: 'fixed' | 'varies';
  readonly min: number;
  readonly max: number;
  readonly isVariable: boolean;
  /** True while a weapon/wear scope could still override this field's shared default. */
  readonly inheritable: boolean;
  readonly blockers: readonly TextureTransformFieldBlocker[];
}

export interface TextureTransformFlipFieldState {
  readonly allowed: boolean;
  readonly isVariable: boolean;
  readonly inheritable: boolean;
  readonly blockers: readonly TextureTransformFieldBlocker[];
}

export type TextureTransformTargetBlocker =
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
}

export interface TextureTransformDiscovery {
  /**
   * Aligned by position with discoverGroupSelectTargets()'s own `targets`
   * array: both walk the same operation tree in the same left-to-right,
   * depth-first order, so `targets[i]` here describes the stage masked by the
   * select stage at `targets[i]` there. Never null in practice (every select
   * stage encountered produces exactly one entry); kept nullable defensively.
   */
  targets: (TextureTransformTargetInfo | null)[];
}

function literalFieldValue(field: VarFieldMsg): string | undefined {
  for (const key of ['string', 'float', 'double', 'uint32', 'uint64', 'sint32', 'sint64', 'bool'] as const) {
    if (field[key] !== undefined) return String(field[key]);
  }
  return undefined;
}

/** Same collection shape discoverGroupSelectTargets() builds, duplicated here rather than imported since it is a private detail of that module. */
function collectVariables(messages: ProtoDefKitMessages): Map<string, VarDefMsg[]> {
  const variables = new Map<string, VarDefMsg[]>();
  for (const message of [messages.definition, messages.operation]) {
    const header = message.header as { variables?: Many<VarDefMsg> } | undefined;
    for (const variable of many(header?.variables)) {
      if (variables.has(variable.name)) continue;
      const sameHeader = many(header?.variables).filter((entry) => entry.name === variable.name);
      variables.set(variable.name, sameHeader);
    }
  }
  return variables;
}

/**
 * A weapon-local variable override collection, valid for any field on the
 * active weapon regardless of which specific variable it names: decoder.ts's
 * traceResolvedValues() gives every weapon-scoped variable on one weapon the
 * identical sourceRoot (`[...slotPath, 'data', 'variable']`), so any trace
 * with that shape reveals where a brand new override can be written even when
 * the particular transform field being edited has never been overridden.
 * Left undefined when the traces disagree, rather than guessing between them.
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
  inheritable: boolean;
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

/**
 * Reads one transform field's currently effective value. A variable-backed
 * field prefers the resolved value the active weapon is actually showing
 * (from provenance, matched by the same fieldPath convention decoder.ts's
 * traceNodes() writes), and falls back to the shared header default when no
 * per-weapon trace is available (e.g. the harness path with no provenance).
 */
function resolveFieldValue(
  field: VarFieldMsg | undefined,
  fieldPath: readonly string[],
  variables: ReadonlyMap<string, VarDefMsg[]>,
  provenance: readonly ProtoDefValueTrace[] | undefined,
): ResolvedFieldValue {
  if (!field) return { inheritable: false };
  if (!field.variable) return { value: literalFieldValue(field), inheritable: false };

  const marker = fieldPath.join('\0');
  const trace = provenance?.find((entry) => entry.fieldPath.join('\0') === marker);
  const matches = variables.get(field.variable);
  const inheritable = matches?.length === 1 && matches[0].inherit !== false;
  if (trace) {
    const editable = trace.provenance.editableSourcePath;
    const sourcePath = editable && editable[0] === 'definition' && editable[1] !== 'header' ? editable : undefined;
    return { value: trace.provenance.effectiveValue, inheritable, sourcePath };
  }
  return { value: matches?.length === 1 ? matches[0].value : undefined, inheritable };
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
  const local = weaponOverrideValue(messages, weaponOverridePath, field?.variable);
  const resolved = local
    ? { value: local.value, inheritable: traced.inheritable, sourcePath: local.sourcePath }
    : traced;
  const parsed = field === undefined ? { mode: 'fixed' as const, min: fallback[0], max: fallback[1] } : parseAuthoredRange(resolved.value, fallback);
  const blockers: TextureTransformFieldBlocker[] = [];
  if (field !== undefined && parsed === null) blockers.push('invalid-value');
  if (field?.variable !== undefined && resolved.value === undefined) blockers.push('unresolved-value');
  return {
    state: {
      mode: parsed?.mode ?? 'fixed',
      min: parsed?.min ?? fallback[0],
      max: parsed?.max ?? fallback[1],
      isVariable: field?.variable !== undefined,
      inheritable: resolved.inheritable,
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
  const local = weaponOverrideValue(messages, weaponOverridePath, field?.variable);
  const resolved = local
    ? { value: local.value, inheritable: traced.inheritable, sourcePath: local.sourcePath }
    : traced;
  const blockers: TextureTransformFieldBlocker[] = [];
  if (field?.variable !== undefined && resolved.value === undefined) blockers.push('unresolved-value');
  return {
    state: {
      allowed: parseAuthoredBool(resolved.value),
      isVariable: field?.variable !== undefined,
      inheritable: resolved.inheritable,
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

function blockedTarget(reason: TextureTransformTargetBlocker): TextureTransformTargetInfo {
  const emptyRange: TextureTransformRangeFieldState = { mode: 'fixed', min: 0, max: 0, isVariable: false, inheritable: false, blockers: [] };
  const emptyFlip: TextureTransformFlipFieldState = { allowed: false, isVariable: false, inheritable: false, blockers: [] };
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
  const textureLookup = precedingNode.stage?.texture_lookup;
  if (!textureLookup) return blockedTarget('ambiguous-source-stage');

  const stagePath = [...precedingPath, 'stage', 'texture_lookup'];
  const rotation = buildRangeField(messages, textureLookup.rotation, stagePath, 'rotation', variables, provenance, weaponOverridePath);
  const scaleUv = buildRangeField(messages, textureLookup.scale_uv, stagePath, 'scale_uv', variables, provenance, weaponOverridePath);
  const translateU = buildRangeField(messages, textureLookup.translate_u, stagePath, 'translate_u', variables, provenance, weaponOverridePath);
  const translateV = buildRangeField(messages, textureLookup.translate_v, stagePath, 'translate_v', variables, provenance, weaponOverridePath);
  const flipU = buildFlipField(messages, textureLookup.flip_u, stagePath, 'flip_u', variables, provenance, weaponOverridePath);
  const flipV = buildFlipField(messages, textureLookup.flip_v, stagePath, 'flip_v', variables, provenance, weaponOverridePath);

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
    textureRef: textureRefOf(textureLookup, variables),
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
 * Visits select stages in exactly the traversal order
 * discoverGroupSelectTargets()'s selectTextureReferences() uses (array order,
 * combine children before the next sibling, sticker children last), so the
 * two discoveries stay index-aligned without sharing state.
 */
function walk(
  nodes: Many<OperationNodeMsg>,
  path: readonly string[],
  visit: (precedingNode: OperationNodeMsg | undefined, precedingPath: readonly string[] | undefined) => void,
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
      visit(precedingNode, precedingPath);
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

/**
 * Per paint layer, find the texture_lookup stage whose rotation/scale/offset/
 * flip fields the layer's selector masks. Mirrors discoverGroupSelectTargets():
 * a select stage's transform source is its immediately preceding sibling node,
 * and only a direct texture_lookup sibling is a safe, unambiguous edit
 * surface. A combine or sticker sibling (multiple textures folded together)
 * has no single stage to attribute a rotation/scale to, so it is refused
 * rather than guessed at.
 */
export function discoverTextureTransformTargets(
  messages: ProtoDefKitMessages,
  provenance?: readonly ProtoDefValueTrace[],
): TextureTransformDiscovery {
  const operation = messages.operation as { operation_node?: Many<OperationNodeMsg> };
  const variables = collectVariables(messages);
  const weaponOverridePath = findWeaponOverrideCollectionPath(provenance);
  const targets: (TextureTransformTargetInfo | null)[] = [];
  walk(operation.operation_node, ['operation', 'operation_node'], (precedingNode, precedingPath) => {
    targets.push(buildTarget(messages, precedingNode, precedingPath, variables, provenance, weaponOverridePath));
  });
  return { targets };
}

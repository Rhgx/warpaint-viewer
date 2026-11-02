import type { ProtoDefKitMessages } from '../../protodefs/types';
import {
  many, type Many, type OperationNodeMsg, type TextureStageMsg, type VarDefMsg, type VarFieldMsg,
} from '../../protodefs/messages';
import {
  EditorMutationAmbiguityError, cloneMessages, collectStages, literalFieldValue, replaceMany, setSelectFieldValue,
} from '../mutationCore';

// Texture transform, flip, and team-color mutations.

export type TextureTransformRangeField = 'rotation' | 'scale_uv' | 'translate_u' | 'translate_v';
export type TextureTransformFlipField = 'flip_u' | 'flip_v';

export interface TextureTransformRangeValue {
  mode: 'fixed' | 'varies';
  min: number;
  max: number;
}

export interface TextureTransformTarget {
  /** Exact authored path from the operation root to a texture or combine stage. */
  stagePath: readonly string[];
  /** Per-field exact weapon-local override, when one already exists for that field's variable. */
  fieldSourcePaths?: Partial<Record<TextureTransformRangeField | TextureTransformFlipField, readonly string[]>>;
  /** Weapon-local variable collection that can receive a brand new override, when unambiguous. */
  weaponOverridePath?: readonly string[];
}

export type TextureTransformField = TextureTransformRangeField | TextureTransformFlipField;

const TEXTURE_TRANSFORM_FIELDS: readonly TextureTransformField[] = [
  'rotation', 'scale_uv', 'translate_u', 'translate_v', 'flip_u', 'flip_v',
];

export interface TextureTransformFieldFacts {
  /** The authored stage field names a variable rather than holding a literal. */
  readonly variable: boolean;
  /** Discovery found a resolvable value for this field. */
  readonly editable: boolean;
  /** The header variable is unique and inherits, so a weapon override write leaves other weapons unchanged. */
  readonly headerInherits: boolean;
}

export type TextureTransformFieldFactMap = Readonly<Record<TextureTransformField, TextureTransformFieldFacts>>;

/**
 * Whether a weapon-scoped write of one field lands on the active weapon. Mirrors
 * setSelectFieldValue: literal or absent fields write the shared header, and a
 * variable field is weapon-local only through its own weapon source or an override collection.
 */
function isWeaponWritableField(
  target: TextureTransformTarget,
  field: TextureTransformField,
  facts: TextureTransformFieldFacts,
): boolean {
  if (!facts.variable) return false;
  const sourcePath = target.fieldSourcePaths?.[field];
  if (sourcePath) return sourcePath[0] === 'definition' && sourcePath[1] !== 'header';
  // An override write sets the header's inherit to true, which would activate overrides on other weapons when it was false.
  return target.weaponOverridePath !== undefined && facts.headerInherits;
}

/** The transform fields a weapon-scoped edit changes on this weapon only; every other field writes the shared value. */
export function weaponWritableTransformFields(
  target: TextureTransformTarget,
  facts: TextureTransformFieldFactMap,
): TextureTransformField[] {
  return TEXTURE_TRANSFORM_FIELDS.filter((field) => isWeaponWritableField(target, field, facts[field]));
}

// Transform edits open on the current weapon only when an editable field can be written there.
export function defaultTransformScope(
  target: TextureTransformTarget,
  facts: TextureTransformFieldFactMap,
): 'all' | 'weapon' {
  return weaponWritableTransformFields(target, facts).some((field) => facts[field].editable) ? 'weapon' : 'all';
}

const TRANSFORM_STAGE_NAMES = new Set(['texture_lookup']);

function textureTransformStage(operation: Record<string, unknown>, target: TextureTransformTarget): TextureStageMsg {
  const path = target.stagePath;
  if (path[0] !== 'operation' || !TRANSFORM_STAGE_NAMES.has(path.at(-1) ?? '') || path.at(-2) !== 'stage') {
    throw new EditorMutationAmbiguityError('This texture transform target does not identify an editable texture stage.');
  }
  let cursor: unknown = operation;
  for (const part of path.slice(1)) {
    if (Array.isArray(cursor)) {
      const index = Number(part);
      cursor = Number.isInteger(index) ? cursor[index] : undefined;
    } else if (cursor && typeof cursor === 'object') {
      cursor = (cursor as Record<string, unknown>)[part];
    } else {
      cursor = undefined;
    }
  }
  if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) {
    throw new EditorMutationAmbiguityError('This texture transform stage no longer exists in this operation.');
  }
  return cursor as TextureStageMsg;
}

function formatTransformNumber(value: number): string {
  if (!Number.isFinite(value)) throw new TypeError('Texture transform values must be finite numbers.');
  // Round away float noise from slider edits so the proto string does not grow a decimal tail.
  return String(Math.round(value * 1e6) / 1e6);
}

function formatTransformRange(value: TextureTransformRangeValue): string {
  const min = formatTransformNumber(value.min);
  if (value.mode === 'fixed') return min;
  return `${min} ${formatTransformNumber(value.max)}`;
}

/**
 * Writes one range field on a texture_lookup stage, keeping its Fixed or Varies
 * shape. Provenance follows the select mutations.
 */
export function setTextureTransformRange(
  messages: ProtoDefKitMessages,
  target: TextureTransformTarget,
  field: TextureTransformRangeField,
  value: TextureTransformRangeValue,
): ProtoDefKitMessages {
  if (!Number.isFinite(value.min) || !Number.isFinite(value.max)) {
    throw new TypeError('Texture transform values must be finite numbers.');
  }
  const next = cloneMessages(messages);
  const stage = textureTransformStage(next.operation, target);
  const existing = stage[field] ?? {};
  const raw = formatTransformRange(value);
  const sourcePath = target.fieldSourcePaths?.[field];
  const written = setSelectFieldValue(next, existing, raw, false, sourcePath, !sourcePath ? target.weaponOverridePath : undefined);
  stage[field] = written;
  return next;
}

/**
 * Promotes one effective range to the shared header value and removes copies of
 * that variable from every weapon slot, as one undoable mutation.
 */
export function pushTextureTransformRangeToAllWeapons(
  messages: ProtoDefKitMessages,
  target: TextureTransformTarget,
  field: TextureTransformRangeField,
  value: TextureTransformRangeValue,
  weaponOverridePaths: readonly (readonly string[])[],
): ProtoDefKitMessages {
  const next = setTextureTransformRange(messages, { stagePath: target.stagePath }, field, value);
  const stage = textureTransformStage(next.operation, target);
  const variableName = stage[field]?.variable;
  if (!variableName) return next;

  for (const path of weaponOverridePaths) {
    const [root, ...parts] = path;
    if (root !== 'definition' || parts.length === 0) continue;
    let owner: Record<string, unknown> = next.definition;
    let valid = true;
    for (const part of parts.slice(0, -1)) {
      const child = owner[part];
      if (!child || typeof child !== 'object' || Array.isArray(child)) {
        valid = false;
        break;
      }
      owner = child as Record<string, unknown>;
    }
    if (!valid) continue;
    const key = parts.at(-1)!;
    const prior = owner[key] as Many<VarFieldMsg> | undefined;
    const fields = many(prior);
    const filtered = fields.filter((entry) => entry.variable !== variableName);
    if (filtered.length !== fields.length) replaceMany(owner, key, prior, filtered);
  }
  return next;
}

function operationHasTeamTextures(nodes: Many<OperationNodeMsg>): boolean {
  let found = false;
  collectStages(nodes, (stage) => {
    if (stage.texture_lookup?.texture_red || stage.texture_lookup?.texture_blue) found = true;
  });
  return found;
}

/**
 * Turns per-team artwork on or off for one texture layer. Enabling copies the
 * texture to both teams; disabling keeps the RED texture. has_team_textures follows
 * so the inspect panel shows its team buttons.
 */
export function setTextureLayerTeamColors(
  messages: ProtoDefKitMessages,
  target: Pick<TextureTransformTarget, 'stagePath'>,
  enabled: boolean,
): ProtoDefKitMessages {
  const next = cloneMessages(messages);
  const stage = textureTransformStage(next.operation, target);
  if (enabled) {
    if (stage.texture_red && stage.texture_blue && next.definition.has_team_textures === true) return messages;
    // Template layers can already carry team sides; keep them as authored.
    const shared = stage.texture ?? stage.texture_red ?? stage.texture_blue;
    if (!shared) throw new EditorMutationAmbiguityError('This layer has no texture to give each team.');
    // `texture` stays the layer identity (name and group target read it); a team side wins for its team.
    stage.texture_red ??= structuredClone(shared);
    stage.texture_blue ??= structuredClone(shared);
    next.definition.has_team_textures = true;
    return next;
  }
  if (!stage.texture_red && !stage.texture_blue) return messages;
  stage.texture = stage.texture_red ?? stage.texture_blue;
  delete stage.texture_red;
  delete stage.texture_blue;
  // Templates can hide team artwork from this snapshot, so only template-free operations are known to have none left.
  const nodes = (next.operation as { operation_node?: Many<OperationNodeMsg> }).operation_node;
  const usesTemplates = JSON.stringify(nodes ?? null).includes('"operation_template"');
  if (!usesTemplates && !operationHasTeamTextures(nodes)) delete next.definition.has_team_textures;
  return next;
}

/**
 * Reads a layer's per-team artwork for display, or null when the stage is not a
 * plain texture lookup. A bound variable reads as its header value.
 */
export function readTextureLayerTeamColors(
  messages: ProtoDefKitMessages,
  target: Pick<TextureTransformTarget, 'stagePath'>,
): { enabled: boolean; red?: string; blu?: string } | null {
  let stage: TextureStageMsg;
  try {
    stage = textureTransformStage(messages.operation, target);
  } catch {
    return null;
  }
  const value = (field: VarFieldMsg | undefined) => {
    if (!field) return undefined;
    if (!field.variable) return literalFieldValue(field);
    for (const message of [messages.definition, messages.operation]) {
      const header = message.header as { variables?: Many<VarDefMsg> } | undefined;
      const found = many(header?.variables).find((variable) => variable.name === field.variable);
      if (found?.value !== undefined) return found.value;
    }
    return undefined;
  };
  // The game draws team sides whatever has_team_textures says; the flag only
  // shows the inspect panel's team buttons.
  const enabled = Boolean(stage.texture_red || stage.texture_blue);
  return {
    enabled,
    red: value(stage.texture_red ?? stage.texture),
    blu: value(stage.texture_blue ?? stage.texture),
  };
}

/** Points one team's side of a team-colored layer at new artwork. */
export function setTextureLayerTeamTexture(
  messages: ProtoDefKitMessages,
  target: Pick<TextureTransformTarget, 'stagePath'>,
  team: 'red' | 'blu',
  textureReference: string,
): ProtoDefKitMessages {
  if (!textureReference.trim()) throw new TypeError('A texture reference is required.');
  const next = cloneMessages(messages);
  const stage = textureTransformStage(next.operation, target);
  if (!stage.texture_red && !stage.texture_blue) {
    throw new EditorMutationAmbiguityError('Turn on team colors for this layer first.');
  }
  stage[team === 'red' ? 'texture_red' : 'texture_blue'] = { string: textureReference.trim() };
  return next;
}

/** Writes one deterministic mirroring flip field. */
export function setTextureTransformFlip(
  messages: ProtoDefKitMessages,
  target: TextureTransformTarget,
  axis: 'u' | 'v',
  allowed: boolean,
): ProtoDefKitMessages {
  const field: TextureTransformFlipField = axis === 'u' ? 'flip_u' : 'flip_v';
  const next = cloneMessages(messages);
  const stage = textureTransformStage(next.operation, target);
  const existing = stage[field] ?? {};
  const raw = allowed ? '1' : '0';
  const sourcePath = target.fieldSourcePaths?.[field];
  const written = setSelectFieldValue(next, existing, raw, false, sourcePath, !sourcePath ? target.weaponOverridePath : undefined);
  stage[field] = written;
  return next;
}

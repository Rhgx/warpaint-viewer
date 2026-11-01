import type { ProtoDefKitMessages } from '../../protodefs/types';
import {
  many, type Many, type OperationNodeMsg, type StickerStageMsg, type VarDefMsg, type VarFieldMsg,
} from '../../protodefs/messages';
import { stickerWeightFromString } from '../../protodefs/values';
import {
  EditorMutationAmbiguityError, cloneMessages, collectStages, fieldWithLiteralLike, replaceMany, selectFieldValue,
  setVariableFieldAtSourcePath, type MutableMessages,
} from '../mutationCore';

// Sticker placement, structure, and variant mutations.

export interface StickerTarget {
  /** Required when the operation contains more than one apply_sticker stage. */
  occurrence?: number;
  /** Variable-value paths that won provenance resolution. Duplicate variable names are refused without them. */
  destinationSourcePaths?: Partial<Record<'dest_tl' | 'dest_tr' | 'dest_bl', readonly string[]>>;
}

export interface StickerQuad {
  tl: readonly [number, number];
  tr: readonly [number, number];
  bl: readonly [number, number];
}

export interface StickerStructureTarget {
  /** Exact authored apply_sticker paths represented by one logical sticker. */
  stagePaths: readonly (readonly string[])[];
  /**
   * Each variant's weight as resolved for the weapon, team, and wear being
   * edited, in variant order. Without them, checks read header defaults.
   */
  effectiveWeights?: readonly number[];
}

function stickerTarget(operation: Record<string, unknown>, target: StickerTarget): StickerStageMsg {
  const matches: StickerStageMsg[] = [];
  collectStages((operation as { operation_node?: Many<OperationNodeMsg> }).operation_node, (stage) => {
    if (stage.apply_sticker) matches.push(stage.apply_sticker);
  });
  if (matches.length === 0) throw new EditorMutationAmbiguityError('No apply_sticker stage exists in this operation.');
  if (target.occurrence !== undefined) {
    const selected = matches[target.occurrence];
    if (!selected) throw new EditorMutationAmbiguityError(`Sticker occurrence ${target.occurrence} does not exist.`);
    return selected;
  }
  if (matches.length !== 1) throw new EditorMutationAmbiguityError(`Sticker target is ambiguous: ${matches.length} stages match. Supply an occurrence.`);
  return matches[0];
}

type StickerNodeLocation = {
  owner: Record<string, unknown>;
  prior: Many<OperationNodeMsg>;
  nodes: OperationNodeMsg[];
  index: number;
};

function stickerNodeLocation(operation: Record<string, unknown>, stagePath: readonly string[]): StickerNodeLocation {
  if (stagePath[0] !== 'operation' || stagePath.at(-2) !== 'stage' || stagePath.at(-1) !== 'apply_sticker') {
    throw new EditorMutationAmbiguityError('Sticker stage path does not identify an editable operation node.');
  }
  const nodePath = stagePath.slice(1, -2);
  const collectionIndex = nodePath.lastIndexOf('operation_node');
  if (collectionIndex < 0) {
    throw new EditorMutationAmbiguityError('Sticker stage path has no editable operation-node collection.');
  }
  let cursor: unknown = operation;
  for (const part of nodePath.slice(0, collectionIndex)) {
    if (Array.isArray(cursor)) {
      const index = Number(part);
      cursor = Number.isInteger(index) ? cursor[index] : undefined;
    } else if (cursor && typeof cursor === 'object') {
      cursor = (cursor as Record<string, unknown>)[part];
    } else {
      cursor = undefined;
    }
    if (!cursor || typeof cursor !== 'object') {
      throw new EditorMutationAmbiguityError('Sticker stage path no longer exists in this operation.');
    }
  }
  if (Array.isArray(cursor)) throw new EditorMutationAmbiguityError('Sticker operation-node owner is invalid.');
  const owner = cursor as Record<string, unknown>;
  const prior = owner.operation_node as Many<OperationNodeMsg> | undefined;
  const nodes = many(prior);
  const selector = nodePath.slice(collectionIndex + 1);
  const index = selector.length === 0 ? 0 : Number(selector[0]);
  if (selector.length > 1 || !Number.isInteger(index) || !nodes[index]?.stage?.apply_sticker) {
    throw new EditorMutationAmbiguityError('Sticker stage path no longer identifies an apply_sticker node.');
  }
  return { owner, prior, nodes, index };
}

/** Resolves each authored sticker path and groups the results by the sibling collection that holds them. */
function stickerLocationsByOwner(
  operation: Record<string, unknown>,
  stagePaths: readonly (readonly string[])[],
): Map<Record<string, unknown>, StickerNodeLocation[]> {
  const byOwner = new Map<Record<string, unknown>, StickerNodeLocation[]>();
  for (const path of stagePaths) {
    const location = stickerNodeLocation(operation, path);
    byOwner.set(location.owner, [...(byOwner.get(location.owner) ?? []), location]);
  }
  return byOwner;
}

function freshStickerVariableNames(messages: MutableMessages): { tl: string; tr: string; bl: string } {
  const used = new Set<string>();
  for (const message of [messages.definition, messages.operation]) {
    const header = message.header;
    if (!header || typeof header !== 'object' || Array.isArray(header)) continue;
    for (const variable of many((header as { variables?: Many<VarDefMsg> }).variables)) {
      if (variable.name) used.add(variable.name);
    }
  }
  let suffix = 1;
  while (['tl', 'tr', 'bl'].some((corner) => used.has(`editor_sticker_${suffix}_${corner}`))) suffix += 1;
  return {
    tl: `editor_sticker_${suffix}_tl`,
    tr: `editor_sticker_${suffix}_tr`,
    bl: `editor_sticker_${suffix}_bl`,
  };
}

function appendDefinitionVariables(messages: MutableMessages, variables: readonly VarDefMsg[]): void {
  const header = messages.definition.header;
  if (!header || typeof header !== 'object' || Array.isArray(header)) {
    throw new EditorMutationAmbiguityError('The definition has no editable header for new sticker placement variables.');
  }
  const owner = header as Record<string, unknown>;
  const prior = owner.variables as Many<VarDefMsg> | undefined;
  replaceMany(owner, 'variables', prior, [...many(prior), ...variables]);
}

function referencedVariableNames(value: unknown, output = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const entry of value) referencedVariableNames(entry, output);
  } else if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.variable === 'string') output.add(record.variable);
    for (const child of Object.values(record)) referencedVariableNames(child, output);
  }
  return output;
}

function removeUnusedHeaderVariables(messages: MutableMessages, candidates: ReadonlySet<string>): void {
  const referenced = referencedVariableNames(messages.operation);
  for (const message of [messages.definition, messages.operation]) {
    const header = message.header;
    if (!header || typeof header !== 'object' || Array.isArray(header)) continue;
    const owner = header as Record<string, unknown>;
    const prior = owner.variables as Many<VarDefMsg> | undefined;
    replaceMany(owner, 'variables', prior, many(prior).filter((variable) => (
      !variable.name || !candidates.has(variable.name) || referenced.has(variable.name)
    )));
  }
}

function formatVec2(value: readonly [number, number]): string {
  if (!value.every(Number.isFinite)) throw new TypeError('Sticker coordinates must be finite numbers.');
  return `${value[0]} ${value[1]}`;
}

type StickerVariableMatch = {
  owner: { header: Record<string, unknown> };
  index: number;
  variable: VarDefMsg;
  all: Many<VarDefMsg>;
};

function sourceMatchedStickerVariable(
  messages: MutableMessages,
  variableName: string,
  sourcePath: readonly string[],
): StickerVariableMatch {
  const [root, headerKey, variablesKey, maybeIndex, maybeValue] = sourcePath;
  if ((root !== 'definition' && root !== 'operation') || headerKey !== 'header' || variablesKey !== 'variables') {
    throw new EditorMutationAmbiguityError(`Sticker variable “${variableName}” resolves outside this editable kit.`);
  }
  const message = root === 'definition' ? messages.definition : messages.operation;
  const header = message.header;
  if (!header || typeof header !== 'object' || Array.isArray(header)) {
    throw new EditorMutationAmbiguityError(`Sticker variable “${variableName}” has no editable header.`);
  }
  const owner = { header: header as Record<string, unknown> };
  const all = owner.header.variables as Many<VarDefMsg> | undefined;
  const variables = many(all);
  const index = Array.isArray(all)
    ? (maybeValue === 'value' && /^\d+$/.test(maybeIndex ?? '') ? Number(maybeIndex) : -1)
    : (maybeIndex === 'value' && maybeValue === undefined ? 0 : -1);
  const variable = variables[index];
  if (!variable || variable.name !== variableName) {
    throw new EditorMutationAmbiguityError(`Sticker provenance no longer identifies variable “${variableName}” in this draft.`);
  }
  return { owner, index, variable, all };
}

function setStickerField(
  messages: MutableMessages,
  stage: StickerStageMsg,
  name: 'dest_tl' | 'dest_tr' | 'dest_bl',
  value: string,
  sourcePath?: readonly string[],
): void {
  const existing = stage[name];
  if (!existing?.variable) {
    stage[name] = fieldWithLiteralLike(existing, value);
    return;
  }

  const variableName = existing.variable;
  const owners: StickerVariableMatch['owner'][] = [];
  for (const message of [messages.definition, messages.operation]) {
    const header = message.header;
    if (header && typeof header === 'object' && !Array.isArray(header)) owners.push({ header: header as Record<string, unknown> });
  }
  const matches: StickerVariableMatch[] = [];
  for (const owner of owners) {
    const variables = (owner.header.variables as Many<VarDefMsg> | undefined);
    many(variables).forEach((variable, index) => {
      if (variable.name === variableName) matches.push({ owner, index, variable, all: variables });
    });
  }
  if (sourcePath) {
    if (sourcePath[0] === 'definition' && sourcePath[1] !== 'header') {
      setVariableFieldAtSourcePath(messages, variableName, sourcePath, value);
      return;
    }
    const match = sourceMatchedStickerVariable(messages, variableName, sourcePath);
    const replaced = many(match.all).map((variable, index) => (
      index === match.index ? { ...variable, value, inherit: false } : variable
    ));
    replaceMany(match.owner.header, 'variables', match.all, replaced);
    return;
  }
  if (matches.length !== 1) {
    const detail = matches.length === 0 ? 'is not present in either editable header' : `appears ${matches.length} times`;
    throw new EditorMutationAmbiguityError(`Sticker field variable “${variableName}” ${detail}; its write scope cannot be inferred safely.`);
  }
  const match = matches[0];
  // Freeze each written corner (inherit: false) so re-resolution cannot restore a weapon or wear override.
  const replaced = many(match.all).map((variable, index) => (
    index === match.index ? { ...variable, value, inherit: false } : variable
  ));
  replaceMany(match.owner.header, 'variables', match.all, replaced);
}

/** Set a sticker UV parallelogram (TL/TR/BL) on a cloned, uniquely identified stage. */
export function setStickerDestQuad(
  messages: ProtoDefKitMessages,
  target: StickerTarget,
  quad: StickerQuad,
): ProtoDefKitMessages {
  const next = cloneMessages(messages);
  const stage = stickerTarget(next.operation, target);
  if (!stage.dest_tl || !stage.dest_tr || !stage.dest_bl) {
    throw new EditorMutationAmbiguityError(
      'This sticker is missing one or more corner positions, so it cannot be moved.',
    );
  }
  const requested: Array<readonly ['dest_tl' | 'dest_tr' | 'dest_bl', string]> = [
    ['dest_tl', formatVec2(quad.tl)], ['dest_tr', formatVec2(quad.tr)], ['dest_bl', formatVec2(quad.bl)],
  ];
  const variableValues = new Map<string, string>();
  for (const [name, value] of requested) {
    const variable = stage[name]?.variable;
    if (!variable) continue;
    const prior = variableValues.get(variable);
    if (prior !== undefined && prior !== value) {
      throw new EditorMutationAmbiguityError(`Two corners use the same setting, “${variable}”. Each corner needs its own setting before the sticker can be moved.`);
    }
    variableValues.set(variable, value);
  }
  for (const [name, value] of requested) {
    setStickerField(next, stage, name, value, target.destinationSourcePaths?.[name]);
  }
  return next;
}

/** Add one artwork choice as a new sticker after the selected authored stage. */
export function addStickerStages(
  messages: ProtoDefKitMessages,
  target: StickerStructureTarget,
  quad: StickerQuad,
  baseReference: string,
): ProtoDefKitMessages {
  if (target.stagePaths.length === 0) throw new EditorMutationAmbiguityError('No authored sticker stage is available to add after.');
  if (!baseReference.trim()) throw new TypeError('A sticker texture reference is required.');
  const next = cloneMessages(messages);
  const names = freshStickerVariableNames(next);
  appendDefinitionVariables(next, [
    { name: names.tl, value: formatVec2(quad.tl), inherit: false },
    { name: names.tr, value: formatVec2(quad.tr), inherit: false },
    { name: names.bl, value: formatVec2(quad.bl), inherit: false },
  ]);
  const byOwner = stickerLocationsByOwner(next.operation, target.stagePaths);
  for (const entries of byOwner.values()) {
    const first = entries[0];
    const nodes = [...first.nodes];
    for (const location of [...entries].sort((a, b) => b.index - a.index)) {
      const added = structuredClone(nodes[location.index]) as OperationNodeMsg;
      const stage = added.stage?.apply_sticker;
      if (!stage) throw new EditorMutationAmbiguityError('Sticker stage could not be added.');
      stage.sticker = { base: { string: baseReference.trim() } };
      stage.dest_tl = { variable: names.tl };
      stage.dest_tr = { variable: names.tr };
      stage.dest_bl = { variable: names.bl };
      nodes.splice(location.index + 1, 0, added);
    }
    replaceMany(first.owner, 'operation_node', first.prior, nodes);
  }
  return next;
}

/** Remove every authored occurrence represented by one logical sticker. */
export function removeStickerStages(
  messages: ProtoDefKitMessages,
  target: StickerStructureTarget,
): ProtoDefKitMessages {
  if (target.stagePaths.length === 0) throw new EditorMutationAmbiguityError('No authored sticker stage is available to remove.');
  const next = cloneMessages(messages);
  const byOwner = stickerLocationsByOwner(next.operation, target.stagePaths);
  const placementVariables = new Set([...byOwner.values()].flat().flatMap((location) => {
    const stage = location.nodes[location.index]?.stage?.apply_sticker;
    return [stage?.dest_tl?.variable, stage?.dest_tr?.variable, stage?.dest_bl?.variable]
      .filter((name): name is string => Boolean(name));
  }));
  for (const entries of byOwner.values()) {
    const first = entries[0];
    const removed = new Set(entries.map((entry) => entry.index));
    const unwrapped = first.nodes.flatMap((node, index) => {
      if (!removed.has(index)) return [node];
      return many(node.stage?.apply_sticker?.operation_node);
    });

    // Removing the wrapper promotes its paint recipe in place, even among siblings in the same collection.
    replaceMany(first.owner, 'operation_node', first.prior, unwrapped);
  }
  removeUnusedHeaderVariables(next, placementVariables);
  return next;
}

/**
 * Points every occurrence of one logical sticker at new artwork as a literal,
 * so it stops following a shared artwork or base variable.
 */
export function setStickerBaseReference(
  messages: ProtoDefKitMessages,
  target: StickerStructureTarget,
  baseReference: string,
): ProtoDefKitMessages {
  if (target.stagePaths.length === 0) throw new EditorMutationAmbiguityError('No authored sticker stage is available to change.');
  if (!baseReference.trim()) throw new TypeError('A sticker texture reference is required.');
  const next = cloneMessages(messages);
  for (const path of target.stagePaths) {
    const location = stickerNodeLocation(next.operation, path);
    const stage = location.nodes[location.index]?.stage?.apply_sticker;
    if (!stage) throw new EditorMutationAmbiguityError('This sticker stage no longer exists in this operation.');
    const variants = many(stage.sticker);
    const replaced = (variants.length > 0 ? variants : [{}]).map((variant) => ({ ...variant, base: { string: baseReference.trim() } }));
    replaceMany(stage as Record<string, unknown>, 'sticker', stage.sticker, replaced);
  }
  return next;
}

/** Every occurrence of one logical sticker. Refused when occurrences list different variants. */
function stickerVariantStages(operation: Record<string, unknown>, target: StickerStructureTarget): StickerStageMsg[] {
  if (target.stagePaths.length === 0) throw new EditorMutationAmbiguityError('No authored sticker stage is available to change.');
  const stages = target.stagePaths.map((path) => {
    const location = stickerNodeLocation(operation, path);
    const stage = location.nodes[location.index]?.stage?.apply_sticker;
    if (!stage) throw new EditorMutationAmbiguityError('This sticker stage no longer exists in this operation.');
    return stage;
  });
  if (new Set(stages.map((stage) => many(stage.sticker).length)).size > 1) {
    throw new EditorMutationAmbiguityError('The occurrences of this sticker list different variants, so they cannot be edited safely.');
  }
  return stages;
}

function currentVariantWeights(
  messages: MutableMessages,
  variants: readonly { weight?: VarFieldMsg }[],
  effectiveWeights: readonly number[] | undefined,
): number[] {
  if (effectiveWeights === undefined) {
    return variants.map((variant) => stickerWeightFromString(variant.weight ? selectFieldValue(messages, variant.weight) : undefined));
  }
  if (effectiveWeights.length !== variants.length) {
    throw new EditorMutationAmbiguityError('Resolved sticker weights do not match this editable sticker.');
  }
  return [...effectiveWeights];
}

/** Sets one variant's relative weight. A variable weight is forked to a literal on this variant only. */
export function setStickerVariantWeight(
  messages: ProtoDefKitMessages,
  target: StickerStructureTarget,
  index: number,
  weight: number,
): ProtoDefKitMessages {
  if (!Number.isFinite(weight) || weight < 0) throw new TypeError('A sticker weight must be a finite number, 0 or greater.');
  const next = cloneMessages(messages);
  for (const stage of stickerVariantStages(next.operation, target)) {
    const variants = many(stage.sticker);
    if (!Number.isInteger(index) || !variants[index]) throw new EditorMutationAmbiguityError(`Sticker variant ${index + 1} does not exist.`);
    const weights = currentVariantWeights(next, variants, target.effectiveWeights);
    const total = weights.reduce((sum, current, position) => (
      sum + (position === index ? weight : current)
    ), 0);
    if (total <= 0) throw new EditorMutationAmbiguityError('At least one sticker variant must keep a weight above 0.');
    const replaced = variants.map((variant, position) => (
      position === index ? { ...variant, weight: { float: weight } } : variant
    ));
    replaceMany(stage as Record<string, unknown>, 'sticker', stage.sticker, replaced);
  }
  return next;
}

/** Appends one artwork choice as a new variant with weight 1 to every occurrence of a sticker. */
export function addStickerVariant(
  messages: ProtoDefKitMessages,
  target: StickerStructureTarget,
  baseReference: string,
): ProtoDefKitMessages {
  if (!baseReference.trim()) throw new TypeError('A sticker texture reference is required.');
  const next = cloneMessages(messages);
  for (const stage of stickerVariantStages(next.operation, target)) {
    const variants = many(stage.sticker);
    replaceMany(stage as Record<string, unknown>, 'sticker', stage.sticker, [
      ...variants,
      { base: { string: baseReference.trim() }, weight: { float: 1 } },
    ]);
  }
  return next;
}

/** Removes one variant from every occurrence of a sticker. The last variant cannot be removed. */
export function removeStickerVariant(
  messages: ProtoDefKitMessages,
  target: StickerStructureTarget,
  index: number,
): ProtoDefKitMessages {
  const next = cloneMessages(messages);
  for (const stage of stickerVariantStages(next.operation, target)) {
    const variants = many(stage.sticker);
    if (!Number.isInteger(index) || !variants[index]) throw new EditorMutationAmbiguityError(`Sticker variant ${index + 1} does not exist.`);
    const remaining = variants.filter((_, position) => position !== index);
    if (remaining.length === 0) throw new EditorMutationAmbiguityError('A sticker needs at least one variant.');
    const weights = currentVariantWeights(next, variants, target.effectiveWeights);
    const total = weights.reduce((sum, current, position) => (position === index ? sum : sum + current), 0);
    if (total <= 0) throw new EditorMutationAmbiguityError('The remaining sticker variants would all have weight 0.');
    replaceMany(stage as Record<string, unknown>, 'sticker', stage.sticker, remaining);
  }
  return next;
}

/** Points one variant of every occurrence of a sticker at new artwork, as a literal. Other variants keep their artwork. */
export function setStickerVariantBase(
  messages: ProtoDefKitMessages,
  target: StickerStructureTarget,
  index: number,
  baseReference: string,
): ProtoDefKitMessages {
  if (!baseReference.trim()) throw new TypeError('A sticker texture reference is required.');
  const next = cloneMessages(messages);
  for (const stage of stickerVariantStages(next.operation, target)) {
    const variants = many(stage.sticker);
    if (!Number.isInteger(index) || !variants[index]) throw new EditorMutationAmbiguityError(`Sticker variant ${index + 1} does not exist.`);
    const replaced = variants.map((variant, position) => (
      position === index ? { ...variant, base: { string: baseReference.trim() } } : variant
    ));
    replaceMany(stage as Record<string, unknown>, 'sticker', stage.sticker, replaced);
  }
  return next;
}

/** Gives every variant of every occurrence of a sticker the literal weight 1, as one edit. */
export function equalizeStickerVariantWeights(
  messages: ProtoDefKitMessages,
  target: StickerStructureTarget,
): ProtoDefKitMessages {
  const next = cloneMessages(messages);
  for (const stage of stickerVariantStages(next.operation, target)) {
    const variants = many(stage.sticker);
    replaceMany(stage as Record<string, unknown>, 'sticker', stage.sticker, variants.map((variant) => ({
      ...variant,
      weight: { float: 1 },
    })));
  }
  return next;
}

/** Move a logical sticker before or after the adjacent sticker in each sibling collection. */
export function moveStickerStages(
  messages: ProtoDefKitMessages,
  target: StickerStructureTarget,
  direction: -1 | 1,
): ProtoDefKitMessages {
  if (target.stagePaths.length === 0) throw new EditorMutationAmbiguityError('No authored sticker stage is available to reorder.');
  const next = cloneMessages(messages);
  const byOwner = stickerLocationsByOwner(next.operation, target.stagePaths);
  for (const entries of byOwner.values()) {
    if (entries.length !== 1) {
      throw new EditorMutationAmbiguityError('Repeated logical stickers in one operation branch cannot be reordered safely.');
    }
    const location = entries[0];
    const adjacent = direction < 0
      ? location.nodes.findLastIndex((node, index) => index < location.index && Boolean(node.stage?.apply_sticker))
      : location.nodes.findIndex((node, index) => index > location.index && Boolean(node.stage?.apply_sticker));
    if (adjacent < 0) throw new EditorMutationAmbiguityError(`This sticker is already ${direction < 0 ? 'first' : 'last'} in its group.`);
    const nodes = [...location.nodes];
    [nodes[location.index], nodes[adjacent]] = [nodes[adjacent], nodes[location.index]];
    replaceMany(location.owner, 'operation_node', location.prior, nodes);
  }
  return next;
}

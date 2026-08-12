import type { ProtoDefKitMessages } from '../protodefs/types';
import { many, type Many, type OperationNodeMsg, type OperationStageMsg, type SelectStageMsg, type StickerStageMsg, type VarDefMsg, type VarFieldMsg } from '../protodefs/messages';

/** A refused edit is preferable to silently changing a different authored scope. */
export class EditorMutationAmbiguityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EditorMutationAmbiguityError';
  }
}

export interface SelectGroupTarget {
  /** Exact raw groups field value (for example a groups texture path), if known. */
  groupsValue?: string;
  /** Required when more than one matching select stage exists. Zero-based. */
  occurrence?: number;
  /**
   * Effective selector values from the resolved weapon recipe.  A paint-kit
   * operation commonly leaves these variables inheritable, while a weapon or
   * wear definition supplies the values that are actually visible.  Supplying
   * them lets the first edit preserve that visible baseline before it locks
   * the selector to an authored draft value.
   */
  effectiveSelectValues?: readonly number[];
  /** Exact per-slot write paths for the active weapon's selector values. */
  valueSourcePaths?: readonly (readonly string[] | undefined)[];
  /** Which authored selector slots inherit their effective per-weapon value. */
  inheritedSelectValues?: readonly boolean[];
  /** Weapon-local variable collection that can receive an unused shared slot. */
  valueOverridePath?: readonly string[];
}

/** One editable paint layer considered by an exclusive group assignment. */
export interface SelectGroupAssignmentTarget {
  readonly target: SelectGroupTarget;
  /** Human-readable only; returned to the UI when a part is moved. */
  readonly label?: string;
}

export interface SelectGroupAssignmentResult {
  readonly messages: ProtoDefKitMessages;
  /** The part was removed from the active paint layer. */
  readonly action: 'added' | 'moved' | 'removed';
  /** Paint layers that previously owned the part, in UI-ready form. */
  readonly displacedLabels: readonly string[];
}

export interface StickerTarget {
  /** Required when the operation contains more than one apply_sticker stage. */
  occurrence?: number;
  /**
   * Exact local variable-value paths which won provenance resolution. Without
   * these hints duplicate variable names remain an intentional hard refusal.
   */
  destinationSourcePaths?: Partial<Record<'dest_tl' | 'dest_tr' | 'dest_bl', readonly string[]>>;
}

export interface StickerQuad {
  tl: readonly [number, number];
  tr: readonly [number, number];
  bl: readonly [number, number];
}

type MutableMessages = {
  definition: Record<string, unknown>;
  operation: Record<string, unknown>;
};

function cloneMessages(messages: ProtoDefKitMessages): MutableMessages {
  // Exported proto messages are intentionally plain data. structuredClone keeps
  // unknown keys and singleton-vs-array field shape unlike JSON round-tripping.
  return structuredClone(messages) as MutableMessages;
}

function literalFieldValue(field: VarFieldMsg | undefined): string | undefined {
  if (!field) return undefined;
  for (const key of ['string', 'float', 'double', 'uint32', 'uint64', 'sint32', 'sint64', 'bool'] as const) {
    if (field[key] !== undefined) return String(field[key]);
  }
  return undefined;
}

function findEditableVariable(
  messages: MutableMessages,
  variableName: string,
): { owner: Record<string, unknown>; all: Many<VarDefMsg>; index: number; variable: VarDefMsg } {
  for (const message of [messages.definition, messages.operation]) {
    const matches: Array<{ owner: Record<string, unknown>; all: Many<VarDefMsg>; index: number; variable: VarDefMsg }> = [];
    const header = message.header;
    if (!header || typeof header !== 'object' || Array.isArray(header)) continue;
    const owner = header as Record<string, unknown>;
    const variables = owner.variables as Many<VarDefMsg> | undefined;
    many(variables).forEach((variable, index) => {
      if (variable.name === variableName) matches.push({ owner, all: variables, index, variable });
    });
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      throw new EditorMutationAmbiguityError(`Select variable “${variableName}” appears ${matches.length} times in one header.`);
    }
  }
  throw new EditorMutationAmbiguityError(`Select variable “${variableName}” is not present in an editable header.`);
}

function selectFieldValue(messages: MutableMessages, field: VarFieldMsg): string | undefined {
  if (!field.variable) return literalFieldValue(field);
  return findEditableVariable(messages, field.variable).variable.value;
}

function setSelectFieldValue(
  messages: MutableMessages,
  field: VarFieldMsg,
  value: string,
  lockInheritance = false,
  sourcePath?: readonly string[],
  overridePath?: readonly string[],
): VarFieldMsg {
  if (!field.variable) return fieldWithLiteralLike(field, value);
  if (sourcePath && sourcePath[0] === 'definition' && sourcePath[1] !== 'header') {
    setVariableFieldAtSourcePath(messages, field.variable, sourcePath, value);
    return field;
  }
  if (overridePath) {
    upsertVariableFieldAtPath(messages, field.variable, overridePath, value);
    const match = findEditableVariable(messages, field.variable);
    const variables = many(match.all).map((variable, index) => (
      index === match.index ? { ...variable, inherit: true } : variable
    ));
    replaceMany(match.owner, 'variables', match.all, variables);
    return field;
  }
  const match = findEditableVariable(messages, field.variable);
  const replaced = many(match.all).map((variable, index) => (
    index === match.index
      ? { ...variable, value, ...(lockInheritance ? { inherit: false } : {}) }
      : variable
  ));
  replaceMany(match.owner, 'variables', match.all, replaced);
  return field;
}

export interface StickerStructureTarget {
  /** Exact authored apply_sticker paths represented by one logical sticker. */
  stagePaths: readonly (readonly string[])[];
}

function upsertVariableFieldAtPath(
  messages: MutableMessages,
  variableName: string,
  collectionPath: readonly string[],
  value: string,
): void {
  const [root, ...parts] = collectionPath;
  if ((root !== 'definition' && root !== 'operation') || parts.length === 0) {
    throw new EditorMutationAmbiguityError(`Variable "${variableName}" has no editable weapon override collection.`);
  }
  let owner: Record<string, unknown> = root === 'definition' ? messages.definition : messages.operation;
  for (const part of parts.slice(0, -1)) {
    const child = owner[part];
    if (!child || typeof child !== 'object' || Array.isArray(child)) {
      throw new EditorMutationAmbiguityError(`Variable "${variableName}" has no editable weapon override collection.`);
    }
    owner = child as Record<string, unknown>;
  }
  const key = parts.at(-1)!;
  const prior = owner[key] as Many<VarFieldMsg> | undefined;
  const fields = many(prior);
  const matches = fields.flatMap((field, index) => field.variable === variableName ? [index] : []);
  if (matches.length > 1) {
    throw new EditorMutationAmbiguityError(`Variable "${variableName}" has multiple weapon overrides.`);
  }
  const next = matches.length === 1
    ? fields.map((field, index) => index === matches[0] ? { ...field, string: value } : field)
    : [...fields, { variable: variableName, string: value }];
  replaceMany(owner, key, prior, next);
}

function fieldWithLiteralLike(existing: VarFieldMsg | undefined, value: string): VarFieldMsg {
  if (existing?.variable) throw new EditorMutationAmbiguityError(`Field is controlled by variable “${existing.variable}”, not a literal.`);
  if (existing?.float !== undefined) return { float: Number(value) };
  if (existing?.double !== undefined) return { double: Number(value) };
  if (existing?.uint32 !== undefined) return { uint32: Number(value) };
  if (existing?.uint64 !== undefined) return { uint64: Number(value) };
  if (existing?.sint32 !== undefined) return { sint32: Number(value) };
  if (existing?.sint64 !== undefined) return { sint64: Number(value) };
  if (existing?.bool !== undefined) return { bool: value === 'true' || value === '1' };
  return { string: value };
}

function collectStages(nodes: Many<OperationNodeMsg>, callback: (stage: OperationStageMsg) => void): void {
  for (const node of many(nodes)) {
    if (!node.stage) continue;
    callback(node.stage);
    for (const combine of [node.stage.combine_multiply, node.stage.combine_add, node.stage.combine_lerp]) {
      if (combine) collectStages(combine.operation_node, callback);
    }
    if (node.stage.apply_sticker) collectStages(node.stage.apply_sticker.operation_node, callback);
  }
}

function selectTarget(operation: Record<string, unknown>, target: SelectGroupTarget): SelectStageMsg {
  const matches: SelectStageMsg[] = [];
  collectStages((operation as { operation_node?: Many<OperationNodeMsg> }).operation_node, (stage) => {
    if (!stage.select) return;
    if (target.groupsValue !== undefined && literalFieldValue(stage.select.groups) !== target.groupsValue) return;
    matches.push(stage.select);
  });
  if (matches.length === 0) throw new EditorMutationAmbiguityError('No select stage matches this group target.');
  if (target.occurrence !== undefined) {
    const selected = matches[target.occurrence];
    if (!selected) throw new EditorMutationAmbiguityError(`Select occurrence ${target.occurrence} does not exist.`);
    return selected;
  }
  if (matches.length !== 1) throw new EditorMutationAmbiguityError(`Select target is ambiguous: ${matches.length} stages match. Supply an occurrence.`);
  return matches[0];
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

function replaceMany<T>(owner: Record<string, unknown>, key: string, prior: Many<T>, next: T[]): void {
  owner[key] = Array.isArray(prior) ? next : (next.length === 1 ? next[0] : next);
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

function selectorIds(messages: MutableMessages, target: SelectGroupTarget): number[] {
  const values = many(selectTarget(messages.operation, target).select);
  const hasInheritableVariables = values.some((field) => (
    field.variable !== undefined && findEditableVariable(messages, field.variable).variable.inherit !== false
  ));
  if (hasInheritableVariables && target.effectiveSelectValues === undefined) {
    throw new EditorMutationAmbiguityError(
      'A paint layer inherits its selected parts, so it cannot be reassigned until its visible values are resolved.',
    );
  }
  const ids = hasInheritableVariables
    ? [...target.effectiveSelectValues!]
    : values.map((field) => Number(selectFieldValue(messages, field)));
  if (ids.length !== values.length) {
    throw new EditorMutationAmbiguityError('Resolved selector values do not match this editable selector.');
  }
  if (ids.some((id) => !Number.isInteger(id))) {
    throw new EditorMutationAmbiguityError('Select values contain a non-integer literal and cannot be safely reassigned.');
  }
  return ids;
}

function formatVec2(value: readonly [number, number]): string {
  if (!value.every(Number.isFinite)) throw new TypeError('Sticker coordinates must be finite numbers.');
  return `${value[0]} ${value[1]}`;
}

type StickerVariableMatch = {
  owner: { header: Record<string, unknown>; label: string };
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
  const owner = { header: header as Record<string, unknown>, label: root };
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

function setVariableFieldAtSourcePath(
  messages: MutableMessages,
  variableName: string,
  sourcePath: readonly string[],
  value: string,
): void {
  const [root, ...parts] = sourcePath;
  if ((root !== 'definition' && root !== 'operation') || parts.length === 0) {
    throw new EditorMutationAmbiguityError(`Variable â€œ${variableName}â€ resolves outside this editable kit.`);
  }
  let owner: Record<string, unknown> = root === 'definition' ? messages.definition : messages.operation;
  for (const part of parts.slice(0, -1)) {
    const child = owner[part];
    if (!child || typeof child !== 'object') {
      throw new EditorMutationAmbiguityError(`Variable â€œ${variableName}â€ no longer has its authored weapon override.`);
    }
    owner = child as Record<string, unknown>;
  }
  const key = parts.at(-1)!;
  const field = owner[key];
  if (!field || typeof field !== 'object' || Array.isArray(field)
    || (field as VarFieldMsg).variable !== variableName) {
    throw new EditorMutationAmbiguityError(`Weapon provenance no longer identifies variable â€œ${variableName}â€ in this draft.`);
  }
  const authored = field as VarFieldMsg;
  const literal = { ...authored };
  delete literal.variable;
  owner[key] = { ...fieldWithLiteralLike(literal, value), variable: variableName };
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
  const owners: Array<{ header: Record<string, unknown>; label: string }> = [];
  for (const [label, message] of [['definition', messages.definition], ['operation', messages.operation]] as const) {
    const header = message.header;
    if (header && typeof header === 'object' && !Array.isArray(header)) owners.push({ header: header as Record<string, unknown>, label });
  }
  const matches: Array<{ owner: { header: Record<string, unknown>; label: string }; index: number; variable: VarDefMsg; all: Many<VarDefMsg> }> = [];
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
  // A destination variable may currently inherit a weapon/wear override. Once
  // the editor owns the full placement quad, freeze every written corner at
  // this exact value so re-resolution cannot silently restore that override.
  const replaced = many(match.all).map((variable, index) => (
    index === match.index ? { ...variable, value, inherit: false } : variable
  ));
  replaceMany(match.owner.header, 'variables', match.all, replaced);
}

/**
 * Toggle one raw select-group id on a cloned operation. When selector slots
 * inherit their visible values from weapon/wear scope, the caller supplies
 * that resolved baseline and the first edit freezes every slot into the draft.
 */
export function toggleSelectGroupId(
  messages: ProtoDefKitMessages,
  target: SelectGroupTarget,
  groupId: number,
): ProtoDefKitMessages {
  if (!Number.isInteger(groupId) || groupId < 1 || groupId > 255) throw new RangeError('A selectable group ID must be an integer from 1 through 255.');
  const next = cloneMessages(messages);
  const stage = selectTarget(next.operation, target);
  const prior = stage.select;
  const values = many(prior);
  const supplied = target.effectiveSelectValues;
  const hasInheritableVariables = values.some((field) => {
    if (!field.variable) return false;
    return findEditableVariable(next, field.variable).variable.inherit !== false;
  });
  const useEffectiveBaseline = hasInheritableVariables && supplied !== undefined;
  if (useEffectiveBaseline && supplied!.length !== values.length) {
    throw new EditorMutationAmbiguityError('Resolved selector values do not match this editable selector.');
  }
  const ids = useEffectiveBaseline
    ? [...supplied!]
    : values.map((field) => Number(selectFieldValue(next, field)));
  if (ids.some((id) => !Number.isInteger(id))) throw new EditorMutationAmbiguityError('Select values contain a non-integer literal and cannot be safely toggled.');
  const inheritedMask = target.inheritedSelectValues;
  const hasWeaponScopedSlots = inheritedMask?.some(Boolean) ?? false;
  // A weapon override may own only the active prefix while the operation
  // provides additional shared zero slots. A zero slot is safe to activate by
  // enabling inheritance and writing its value into this weapon only.
  const editableIndex = (index: number) => (
    !hasWeaponScopedSlots
    || values[index]?.variable === undefined
    || inheritedMask?.[index] === true
    || (ids[index] === 0 && target.valueOverridePath !== undefined)
  );
  const found = ids.some((id, index) => id === groupId && editableIndex(index));
  let nextIds: number[];
  if (found) {
    // Real operations commonly use fixed-size selector arrays padded with 0.
    // Preserve that shape and clear every duplicate so a second toggle is a
    // deterministic add, not a partial removal.
    nextIds = ids.map((id, index) => id === groupId && editableIndex(index) ? 0 : id);
  } else {
    const emptyIndex = ids.findIndex((id, index) => id === 0 && editableIndex(index));
    if (emptyIndex >= 0) {
      nextIds = ids.map((id, index) => index === emptyIndex ? groupId : id);
    } else {
      if (values.length >= 16) throw new RangeError('A select stage cannot contain more than 16 group IDs.');
      if (values.some((field) => field.variable !== undefined)) {
        throw new EditorMutationAmbiguityError('No unused selector variable slot remains for another group ID.');
      }
      nextIds = [...ids, groupId];
    }
  }
  const replacement = nextIds.map((id, index) => {
    const field = values[index];
    if (!field) return fieldWithLiteralLike(values[0], String(id));
    // Once an inherited selector becomes an edit surface, keep every slot on
    // its visible baseline. Locking only the changed slot would let the other
    // slots continue to be overwritten by the weapon/wear definition.
    const sourcePath = target.valueSourcePaths?.[index];
    const inherited = target.inheritedSelectValues?.[index] ?? (useEffectiveBaseline && Boolean(field.variable));
    const shouldWrite = ids[index] !== id || (useEffectiveBaseline && inherited);
    if (useEffectiveBaseline && inherited && field.variable && !sourcePath) {
      throw new EditorMutationAmbiguityError(
        `Paint layer variable â€œ${field.variable}â€ has no editable override for this weapon.`,
      );
    }
    return shouldWrite
      ? setSelectFieldValue(
        next,
        field,
        String(id),
        useEffectiveBaseline && inherited,
        sourcePath,
        !sourcePath && field.variable && ids[index] === 0 ? target.valueOverridePath : undefined,
      )
      : field;
  });
  replaceMany(stage as unknown as Record<string, unknown>, 'select', prior, replacement);
  return next;
}

/**
 * Assign one raw group id to exactly one editable paint layer. Adding a part
 * first clears it from every other selector using the same group texture, so
 * the resulting recipe never silently paints one model area twice. Removing
 * a part from its current layer remains a normal toggle.
 */
export function assignSelectGroupExclusively(
  messages: ProtoDefKitMessages,
  active: SelectGroupAssignmentTarget,
  candidates: readonly SelectGroupAssignmentTarget[],
  groupId: number,
): SelectGroupAssignmentResult {
  if (!Number.isInteger(groupId) || groupId < 1 || groupId > 255) {
    throw new RangeError('A selectable group ID must be an integer from 1 through 255.');
  }
  const baseline = cloneMessages(messages);
  const activeIds = selectorIds(baseline, active.target);
  if (activeIds.includes(groupId)) {
    return {
      messages: toggleSelectGroupId(messages, active.target, groupId),
      action: 'removed',
      displacedLabels: [],
    };
  }

  const activeKey = `${active.target.groupsValue ?? ''}:${active.target.occurrence ?? ''}`;
  const seen = new Set<string>([activeKey]);
  const displaced = candidates.filter((candidate) => {
    if (candidate.target.groupsValue !== active.target.groupsValue) return false;
    const key = `${candidate.target.groupsValue ?? ''}:${candidate.target.occurrence ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return selectorIds(baseline, candidate.target).includes(groupId);
  });

  let next: ProtoDefKitMessages = messages;
  for (const candidate of displaced) next = toggleSelectGroupId(next, candidate.target, groupId);
  next = toggleSelectGroupId(next, active.target, groupId);
  return {
    messages: next,
    action: displaced.length > 0 ? 'moved' : 'added',
    displacedLabels: displaced.map((candidate) => candidate.label).filter((label): label is string => Boolean(label)),
  };
}

/**
 * Clears several selected ids from one paint layer in one detached mutation.
 * The session records the returned snapshot once, so Clear remains one
 * undoable action even when the layer contains many parts.
 */
export function clearSelectGroupIds(
  messages: ProtoDefKitMessages,
  target: SelectGroupTarget,
  groupIds: readonly number[],
): ProtoDefKitMessages {
  let next = messages;
  const seen = new Set<number>();
  for (const groupId of groupIds) {
    if (seen.has(groupId)) continue;
    seen.add(groupId);
    if (selectorIds(next as MutableMessages, target).includes(groupId)) {
      next = toggleSelectGroupId(next, target, groupId);
    }
  }
  return next;
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
      'This sticker does not author all three destination corners, so its placement cannot be edited safely.',
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
      throw new EditorMutationAmbiguityError(`Sticker destination fields share variable “${variable}”; one variable cannot safely represent two requested coordinates.`);
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
  const locations = target.stagePaths.map((path) => stickerNodeLocation(next.operation, path));
  const byOwner = new Map<Record<string, unknown>, StickerNodeLocation[]>();
  for (const location of locations) byOwner.set(location.owner, [...(byOwner.get(location.owner) ?? []), location]);
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
  const locations = target.stagePaths.map((path) => stickerNodeLocation(next.operation, path));
  const placementVariables = new Set(locations.flatMap((location) => {
    const stage = location.nodes[location.index]?.stage?.apply_sticker;
    return [stage?.dest_tl?.variable, stage?.dest_tr?.variable, stage?.dest_bl?.variable]
      .filter((name): name is string => Boolean(name));
  }));
  const byOwner = new Map<Record<string, unknown>, StickerNodeLocation[]>();
  for (const location of locations) byOwner.set(location.owner, [...(byOwner.get(location.owner) ?? []), location]);
  for (const entries of byOwner.values()) {
    const first = entries[0];
    const removed = new Set(entries.map((entry) => entry.index));
    const retained = first.nodes.filter((_, index) => !removed.has(index));
    if (retained.length > 0) {
      replaceMany(first.owner, 'operation_node', first.prior, retained);
      continue;
    }

    // apply_sticker stages wrap the recipe they decorate. If every node in
    // this collection is being removed, dropping the wrappers would also drop
    // the complete paint recipe below them. Promote those inputs instead.
    const promoted = entries.flatMap((entry) => (
      many(entry.nodes[entry.index]?.stage?.apply_sticker?.operation_node)
    ));
    replaceMany(first.owner, 'operation_node', first.prior, promoted);
  }
  removeUnusedHeaderVariables(next, placementVariables);
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
  const locations = target.stagePaths.map((path) => stickerNodeLocation(next.operation, path));
  const byOwner = new Map<Record<string, unknown>, StickerNodeLocation[]>();
  for (const location of locations) byOwner.set(location.owner, [...(byOwner.get(location.owner) ?? []), location]);
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

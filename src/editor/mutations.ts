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
): VarFieldMsg {
  if (!field.variable) return fieldWithLiteralLike(field, value);
  if (sourcePath && sourcePath[0] === 'definition' && sourcePath[1] !== 'header') {
    setVariableFieldAtSourcePath(messages, field.variable, sourcePath, value);
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
  const found = ids.includes(groupId);
  let nextIds: number[];
  if (found) {
    // Real operations commonly use fixed-size selector arrays padded with 0.
    // Preserve that shape and clear every duplicate so a second toggle is a
    // deterministic add, not a partial removal.
    nextIds = ids.map((id) => id === groupId ? 0 : id);
  } else {
    const emptyIndex = ids.indexOf(0);
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
    const shouldWrite = useEffectiveBaseline || ids[index] !== id;
    const sourcePath = target.valueSourcePaths?.[index];
    if (useEffectiveBaseline && field.variable && !sourcePath) {
      throw new EditorMutationAmbiguityError(
        `Paint layer variable â€œ${field.variable}â€ has no editable override for this weapon.`,
      );
    }
    return shouldWrite ? setSelectFieldValue(next, field, String(id), useEffectiveBaseline, sourcePath) : field;
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

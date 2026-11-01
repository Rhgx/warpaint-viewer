import type { ProtoDefKitMessages } from '../protodefs/types';
import {
  many, type Many, type OperationNodeMsg, type OperationStageMsg, type VarDefMsg, type VarFieldMsg,
} from '../protodefs/messages';

// Shared proto-message helpers and the ambiguity error used by the editor mutation domains.

/** A refused edit is preferable to silently changing a different authored scope. */
export class EditorMutationAmbiguityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EditorMutationAmbiguityError';
  }
}

export type MutableMessages = {
  definition: Record<string, unknown>;
  operation: Record<string, unknown>;
};

export function cloneMessages(messages: ProtoDefKitMessages): MutableMessages {
  // Exported proto messages are intentionally plain data. structuredClone keeps
  // unknown keys and singleton-vs-array field shape unlike JSON round-tripping.
  return structuredClone(messages) as MutableMessages;
}

export function literalFieldValue(field: VarFieldMsg | undefined): string | undefined {
  if (!field) return undefined;
  for (const key of ['string', 'float', 'double', 'uint32', 'uint64', 'sint32', 'sint64', 'bool'] as const) {
    if (field[key] !== undefined) return String(field[key]);
  }
  return undefined;
}

export function findEditableVariable(
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

export function selectFieldValue(messages: MutableMessages, field: VarFieldMsg): string | undefined {
  if (!field.variable) return literalFieldValue(field);
  return findEditableVariable(messages, field.variable).variable.value;
}

export function setSelectFieldValue(
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

export function upsertVariableFieldAtPath(
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

export function fieldWithLiteralLike(existing: VarFieldMsg | undefined, value: string): VarFieldMsg {
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

export function collectStages(nodes: Many<OperationNodeMsg>, callback: (stage: OperationStageMsg) => void): void {
  for (const node of many(nodes)) {
    if (!node.stage) continue;
    callback(node.stage);
    for (const combine of [node.stage.combine_multiply, node.stage.combine_add, node.stage.combine_lerp]) {
      if (combine) collectStages(combine.operation_node, callback);
    }
    if (node.stage.apply_sticker) collectStages(node.stage.apply_sticker.operation_node, callback);
  }
}

export function replaceMany<T>(owner: Record<string, unknown>, key: string, prior: Many<T>, next: T[]): void {
  owner[key] = Array.isArray(prior) ? next : (next.length === 1 ? next[0] : next);
}

export function setVariableFieldAtSourcePath(
  messages: MutableMessages,
  variableName: string,
  sourcePath: readonly string[],
  value: string,
): void {
  const [root, ...parts] = sourcePath;
  if ((root !== 'definition' && root !== 'operation') || parts.length === 0) {
    throw new EditorMutationAmbiguityError(`Variable “${variableName}” resolves outside this editable kit.`);
  }
  let owner: Record<string, unknown> = root === 'definition' ? messages.definition : messages.operation;
  for (const part of parts.slice(0, -1)) {
    const child = owner[part];
    if (!child || typeof child !== 'object') {
      throw new EditorMutationAmbiguityError(`Variable “${variableName}” no longer has its authored weapon override.`);
    }
    owner = child as Record<string, unknown>;
  }
  const key = parts.at(-1)!;
  const field = owner[key];
  if (!field || typeof field !== 'object' || Array.isArray(field)
    || (field as VarFieldMsg).variable !== variableName) {
    throw new EditorMutationAmbiguityError(`Weapon provenance no longer identifies variable “${variableName}” in this draft.`);
  }
  const authored = field as VarFieldMsg;
  const literal = { ...authored };
  delete literal.variable;
  owner[key] = { ...fieldWithLiteralLike(literal, value), variable: variableName };
}

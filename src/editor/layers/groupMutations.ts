import type { ProtoDefKitMessages } from '../../protodefs/types';
import { many, type Many, type OperationNodeMsg, type SelectStageMsg, type VarFieldMsg } from '../../protodefs/messages';
import {
  EditorMutationAmbiguityError, cloneMessages, collectStages, fieldWithLiteralLike, findEditableVariable,
  literalFieldValue, replaceMany, selectFieldValue, setSelectFieldValue, upsertVariableFieldAtPath,
  type MutableMessages,
} from '../mutationCore';

// Select-group and group texture mutations for paint layers.

export interface SelectGroupTarget {
  /** Exact raw groups field value (for example a groups texture path), if known. */
  groupsValue?: string;
  /** Required when more than one matching select stage exists. Zero-based. */
  occurrence?: number;
  /**
   * Effective selector values from the resolved weapon recipe. Paint-kit
   * operations often leave these inheritable, so supplying them lets the first
   * edit keep the visible baseline before it locks the selector.
   */
  effectiveSelectValues?: readonly number[];
  /** Exact per-slot write paths for the active weapon's selector values. */
  valueSourcePaths?: readonly (readonly string[] | undefined)[];
  /** Which authored selector slots inherit their effective per-weapon value. */
  inheritedSelectValues?: readonly boolean[];
  /** Weapon-local variable collection that can receive an unused shared slot. */
  valueOverridePath?: readonly string[];
}

/** Where a group-map reference is written: a shared header variable, or the literal `groups` value of per-wear select stages. */
export type GroupTextureTarget =
  | { readonly variableName: string; readonly overridePath: readonly string[] }
  | { readonly kind: 'literal'; readonly groupsValue: string };

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

/** Writes one weapon's inherited group-map reference without changing the shared operation. */
export function setGroupTextureReference(
  messages: ProtoDefKitMessages,
  target: GroupTextureTarget,
  textureRef: string,
): ProtoDefKitMessages {
  const trimmed = textureRef.trim();
  if (!trimmed) throw new TypeError('A group texture reference is required.');
  const next = cloneMessages(messages);
  if ('kind' in target) {
    // Every select stage that reads this map is renamed, as one variable would rename all of them.
    let renamed = 0;
    collectStages((next.operation as { operation_node?: Many<OperationNodeMsg> }).operation_node, (stage) => {
      if (!stage.select || literalFieldValue(stage.select.groups) !== target.groupsValue) return;
      stage.select.groups = { string: trimmed };
      renamed += 1;
    });
    if (renamed === 0) throw new EditorMutationAmbiguityError('No select stage uses this group map.');
    return next;
  }
  upsertVariableFieldAtPath(next, target.variableName, target.overridePath, trimmed);
  return next;
}

/** True when a selector slot reads a header variable that a weapon or wear scope may override. */
function hasInheritableSlots(messages: MutableMessages, values: readonly VarFieldMsg[]): boolean {
  return values.some((field) => {
    if (!field.variable) return false;
    return findEditableVariable(messages, field.variable).variable.inherit !== false;
  });
}

function selectorIds(messages: MutableMessages, target: SelectGroupTarget): number[] {
  const values = many(selectTarget(messages.operation, target).select);
  const hasInheritableVariables = hasInheritableSlots(messages, values);
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

/**
 * Toggle one raw select-group id on a cloned operation. Inheriting selector
 * slots use the caller's resolved baseline, frozen into the draft on the first edit.
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
  const hasInheritableVariables = hasInheritableSlots(next, values);
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
  // Zero slots past a weapon's override prefix can be activated for this weapon only, through its override path.
  const editableIndex = (index: number) => (
    !hasWeaponScopedSlots
    || values[index]?.variable === undefined
    || inheritedMask?.[index] === true
    || (ids[index] === 0 && target.valueOverridePath !== undefined)
  );
  const found = ids.some((id, index) => id === groupId && editableIndex(index));
  let nextIds: number[];
  if (found) {
    // Selectors are fixed-size and 0-padded; clear every duplicate so a second toggle is a deterministic add.
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
    // Lock every slot to its visible baseline; locking only the changed one lets the weapon or wear definition overwrite the rest.
    const sourcePath = target.valueSourcePaths?.[index];
    const inherited = target.inheritedSelectValues?.[index] ?? (useEffectiveBaseline && Boolean(field.variable));
    const shouldWrite = ids[index] !== id || (useEffectiveBaseline && inherited);
    if (useEffectiveBaseline && inherited && field.variable && !sourcePath) {
      throw new EditorMutationAmbiguityError(
        `Paint layer variable “${field.variable}” has no editable override for this weapon.`,
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

/** Identifies the select stage a target names, so one stage is never counted as two displaced layers. */
function targetKey(target: SelectGroupTarget): string {
  return `${target.groupsValue ?? ''}:${target.occurrence ?? ''}`;
}

/**
 * Assign one raw group id to one paint layer by clearing it from every other
 * layer that uses the same group texture. Removing a part stays a plain toggle.
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

  const activeKey = targetKey(active.target);
  const seen = new Set<string>([activeKey]);
  const displaced = candidates.filter((candidate) => {
    if (candidate.target.groupsValue !== active.target.groupsValue) return false;
    const key = targetKey(candidate.target);
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

/** Clears several ids from one paint layer in one mutation, so Clear is a single undoable action. */
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

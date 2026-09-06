import type {
  ProtoDefKitMessages,
  ProtoDefRecipeWithProvenance,
  ProtoDefValueProvenance,
} from '../protodefs/types';
import {
  many,
  type Many,
  type OperationNodeMsg,
  type OperationStageMsg,
  type VarDefMsg,
  type VarFieldMsg,
} from '../protodefs/messages';
import type { StickerQuad, StickerTarget } from './mutations';
import { EditorMutationAmbiguityError, setStickerDestQuad } from './mutations';

/** A field as authored in the operation, alongside the value the resolver uses. */
interface StickerResolvedField {
  readonly fieldPath: readonly string[];
  readonly variableName?: string;
  /** The editable kit header's original variable value, or a literal value. */
  readonly authoredValue?: string;
  /** The value currently used for the selected weapon, team, and wear. */
  readonly resolvedValue?: string;
  readonly provenance?: ProtoDefValueProvenance;
}

interface StickerVariantInfo {
  readonly index: number;
  readonly base: StickerResolvedField;
  readonly weight: StickerResolvedField;
  readonly spec: StickerResolvedField;
}

export interface StickerPlacementTarget {
  /** Stable within this operation snapshot, including nested stages. */
  readonly id: string;
  /** Target accepted by setStickerDestQuad(). */
  readonly target: StickerTarget;
  /** Zero-based depth-first apply_sticker occurrence. */
  readonly occurrence: number;
  /** Every authored occurrence represented by this logical sticker. */
  readonly occurrences: readonly number[];
  /** Operation-message path, useful for diagnostics but never an object reference. */
  readonly stagePath: readonly string[];
  readonly stagePaths: readonly (readonly string[])[];
  readonly canMoveEarlier: boolean;
  readonly canMoveLater: boolean;
  readonly stickers: readonly StickerVariantInfo[];
  readonly destTl: StickerResolvedField;
  readonly destTr: StickerResolvedField;
  readonly destBl: StickerResolvedField;
  /** Present only when the full affine quad can be changed safely. */
  readonly quad?: StickerQuad;
  readonly editable: boolean;
  /** Human-readable refusal reason when editable is false. */
  readonly reason?: string;
}

function logicalStickerKey(target: StickerPlacementTarget): string | null {
  const destinationVariables = [target.destTl, target.destTr, target.destBl].map((field) => field.variableName);
  if (destinationVariables.some((name) => !name)) return null;
  const fieldKey = (field: StickerResolvedField) => (
    field.variableName ? `variable:${field.variableName}` : `literal:${field.authoredValue ?? ''}`
  );
  return JSON.stringify({
    destinationVariables,
    stickers: target.stickers.map((sticker) => [
      fieldKey(sticker.base),
      fieldKey(sticker.weight),
      fieldKey(sticker.spec),
    ]),
  });
}

function coalesceLogicalStickerTargets(targets: readonly StickerPlacementTarget[]): StickerPlacementTarget[] {
  const output: StickerPlacementTarget[] = [];
  const indexes = new Map<string, number>();
  for (const target of targets) {
    const key = logicalStickerKey(target);
    const existingIndex = key === null ? undefined : indexes.get(key);
    if (existingIndex === undefined) {
      if (key !== null) indexes.set(key, output.length);
      output.push(target);
      continue;
    }
    const existing = output[existingIndex];
    const representative = existing.editable || !target.editable ? existing : target;
    output[existingIndex] = {
      ...representative,
      id: existing.id,
      occurrence: existing.occurrence,
      occurrences: [...existing.occurrences, ...target.occurrences],
      stagePaths: [...existing.stagePaths, ...target.stagePaths],
      canMoveEarlier: existing.canMoveEarlier && target.canMoveEarlier,
      canMoveLater: existing.canMoveLater && target.canMoveLater,
    };
  }
  return output;
}

function manyEntryPath<T>(root: readonly string[], source: Many<T>, index: number): string[] {
  return Array.isArray(source) ? [...root, String(index)] : [...root];
}

function literalFieldValue(field: VarFieldMsg | undefined): string | undefined {
  if (!field) return undefined;
  for (const key of ['string', 'float', 'double', 'uint32', 'uint64', 'sint32', 'sint64', 'bool'] as const) {
    if (field[key] !== undefined) return String(field[key]);
  }
  return undefined;
}

function editableVariableValue(messages: ProtoDefKitMessages, name: string): string | undefined {
  const matches: VarDefMsg[] = [];
  for (const message of [messages.definition, messages.operation]) {
    const header = message.header;
    if (!header || typeof header !== 'object' || Array.isArray(header)) continue;
    for (const variable of many((header as { variables?: Many<VarDefMsg> }).variables)) {
      if (variable.name === name) matches.push(variable);
    }
  }
  return matches.length === 1 ? matches[0].value : undefined;
}

function provenanceFor(
  provenance: readonly { fieldPath: readonly string[]; provenance: ProtoDefValueProvenance }[] | undefined,
  fieldPath: readonly string[],
): ProtoDefValueProvenance | undefined {
  return provenance?.find((entry) => (
    entry.fieldPath.length === fieldPath.length
    && entry.fieldPath.every((part, index) => part === fieldPath[index])
  ))?.provenance;
}

function fieldInfo(
  messages: ProtoDefKitMessages,
  field: VarFieldMsg | undefined,
  fieldPath: readonly string[],
  provenance: readonly { fieldPath: readonly string[]; provenance: ProtoDefValueProvenance }[] | undefined,
): StickerResolvedField {
  const source = provenanceFor(provenance, fieldPath);
  const literal = literalFieldValue(field);
  return {
    fieldPath,
    ...(field?.variable === undefined ? {} : { variableName: field.variable }),
    authoredValue: field?.variable ? editableVariableValue(messages, field.variable) : literal,
    resolvedValue: source?.effectiveValue ?? literal,
    ...(source ? { provenance: source } : {}),
  };
}

function parseEditableVec2(field: StickerResolvedField): readonly [number, number] | undefined {
  if (field.resolvedValue === undefined) return undefined;
  const values = String(field.resolvedValue).trim().split(/\s+/).filter(Boolean).map(Number);
  if (values.length < 2 || !Number.isFinite(values[0]) || !Number.isFinite(values[1])) return undefined;
  return [values[0], values[1]];
}

function duplicateDestinationVariable(
  fields: readonly StickerResolvedField[],
): string | undefined {
  const seen = new Set<string>();
  for (const field of fields) {
    if (!field.variableName) continue;
    if (seen.has(field.variableName)) return field.variableName;
    seen.add(field.variableName);
  }
  return undefined;
}

function editableLocalSourcePath(field: StickerResolvedField): readonly string[] | undefined {
  const source = field.provenance;
  if (!field.variableName || source?.variableName !== field.variableName) return undefined;
  const path = source.editableSourcePath ?? source.sourcePath;
  const [root, second, third] = path;
  if (source.scope === 'weapon') {
    // A named/repeated weapon slot is part of the exported definition. Writing
    // its VarField keeps another weapon's authored placement untouched.
    return root === 'definition' && second !== 'header' ? path : undefined;
  }
  return (root === 'definition' || root === 'operation') && second === 'header' && third === 'variables'
    ? path : undefined;
}

function preflightEdit(
  messages: ProtoDefKitMessages,
  target: StickerTarget,
  quad: StickerQuad,
): string | undefined {
  try {
    // This only calls the clone-only mutation primitive. It proves the source
    // scope now, before the UI advertises a draggable target.
    setStickerDestQuad(messages, target, quad);
    return undefined;
  } catch (cause) {
    return cause instanceof EditorMutationAmbiguityError || cause instanceof Error ? cause.message : String(cause);
  }
}

/**
 * Discover direct, editable apply_sticker stages in the exported kit operation.
 *
 * Template-owned stages are deliberately excluded: they are not present in the
 * two-message editor snapshot and changing one would affect unrelated kits.
 * Each direct stage is still returned when it is read-only, so the UI can show
 * the actual source and explain why it cannot be moved.
 */
export function discoverStickerPlacementTargets(
  messages: ProtoDefKitMessages,
  resolved?: Pick<ProtoDefRecipeWithProvenance, 'provenance'> | null,
): StickerPlacementTarget[] {
  const output: StickerPlacementTarget[] = [];
  let occurrence = 0;
  const traces = resolved?.provenance;

  const visitNodes = (nodes: Many<OperationNodeMsg>, root: readonly string[]) => {
    const siblings = many(nodes);
    siblings.forEach((node, index) => {
      if (!node.stage) return;
      const stagePath = [...manyEntryPath(root, nodes, index), 'stage'];
      visitStage(node.stage, stagePath, siblings, index);
    });
  };

  const visitStage = (
    stage: OperationStageMsg,
    stagePath: readonly string[],
    siblings: readonly OperationNodeMsg[],
    siblingIndex: number,
  ) => {
    if (stage.apply_sticker) {
      const stickerStage = stage.apply_sticker;
      const currentOccurrence = occurrence++;
      const stickerPath = [...stagePath, 'apply_sticker'];
      const destTl = fieldInfo(messages, stickerStage.dest_tl, [...stickerPath, 'dest_tl'], traces);
      const destTr = fieldInfo(messages, stickerStage.dest_tr, [...stickerPath, 'dest_tr'], traces);
      const destBl = fieldInfo(messages, stickerStage.dest_bl, [...stickerPath, 'dest_bl'], traces);
      const destinationSourcePaths = {
        dest_tl: editableLocalSourcePath(destTl),
        dest_tr: editableLocalSourcePath(destTr),
        dest_bl: editableLocalSourcePath(destBl),
      };
      const target: StickerTarget = {
        occurrence: currentOccurrence,
        ...(Object.values(destinationSourcePaths).some(Boolean) ? { destinationSourcePaths } : {}),
      };
      const stickers = many(stickerStage.sticker).map((sticker, index): StickerVariantInfo => {
        const path = manyEntryPath([...stickerPath, 'sticker'], stickerStage.sticker, index);
        return {
          index,
          base: fieldInfo(messages, sticker.base, [...path, 'base'], traces),
          weight: fieldInfo(messages, sticker.weight, [...path, 'weight'], traces),
          spec: fieldInfo(messages, sticker.spec, [...path, 'spec'], traces),
        };
      });

      const tl = parseEditableVec2(destTl);
      const tr = parseEditableVec2(destTr);
      const bl = parseEditableVec2(destBl);
      let reason: string | undefined;
      let quad: StickerQuad | undefined;
      if (!stickerStage.dest_tl || !stickerStage.dest_tr || !stickerStage.dest_bl) {
        reason = 'This sticker is missing one or more corner positions, so it cannot be moved.';
      } else if (!tl || !tr || !bl) {
        reason = 'One or more sticker corner positions are missing or are not numbers.';
      } else {
        const duplicate = duplicateDestinationVariable([destTl, destTr, destBl]);
        if (duplicate) reason = `Two corners use the same setting, “${duplicate}”. Each corner needs its own setting before the sticker can be moved.`;
        else if ([destTl, destTr, destBl].some((field, index) => (
          field.variableName
          && field.provenance?.scope !== 'global'
          && ![destinationSourcePaths.dest_tl, destinationSourcePaths.dest_tr, destinationSourcePaths.dest_bl][index]
        ))) {
          reason = 'This sticker position is shared with other weapons. It cannot be changed for only this weapon.';
        } else {
          quad = { tl, tr, bl };
          reason = preflightEdit(messages, target, quad);
          if (reason) quad = undefined;
        }
      }
      output.push({
        id: `sticker:${currentOccurrence}:${stickerPath.join('/')}`,
        target,
        occurrence: currentOccurrence,
        occurrences: [currentOccurrence],
        stagePath: stickerPath,
        stagePaths: [stickerPath],
        canMoveEarlier: siblings.some((node, index) => index < siblingIndex && Boolean(node.stage?.apply_sticker)),
        canMoveLater: siblings.some((node, index) => index > siblingIndex && Boolean(node.stage?.apply_sticker)),
        stickers,
        destTl,
        destTr,
        destBl,
        ...(quad ? { quad } : {}),
        editable: quad !== undefined,
        ...(reason ? { reason } : {}),
      });
      visitNodes(stickerStage.operation_node, [...stickerPath, 'operation_node']);
      return;
    }
    for (const [name, combine] of [
      ['combine_multiply', stage.combine_multiply],
      ['combine_add', stage.combine_add],
      ['combine_lerp', stage.combine_lerp],
    ] as const) {
      if (combine) visitNodes(combine.operation_node, [...stagePath, name, 'operation_node']);
    }
  };

  visitNodes(
    (messages.operation as { operation_node?: Many<OperationNodeMsg> }).operation_node,
    ['operation', 'operation_node'],
  );
  return coalesceLogicalStickerTargets(output);
}

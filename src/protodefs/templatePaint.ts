// Builds the operation and definition JSON fragments for a new paint made from a stock
// template (public/data/operation-templates.json). The shape mirrors the fixtures in
// tools/verify/editor/example-warpaints.test.ts.

import type { OperationTemplateInfo, OperationTemplateVariable } from '../data/types';
import { normalizeProtoDefFragments } from './jsonFragments';
import type { ProtoDefJsonFragment, ProtoDefKitMessages } from './types';
import { texturePublicPath } from './values';

// Stand-ins for template patterns the viewer does not ship. A sticker base needs a
// sticker-shaped texture; other layers need a neutral one.
const NEUTRAL_TEXTURE = 'patterns/blank_white';
const NEUTRAL_STICKER = 'patterns/stickers/blank';

interface TemplatePaintOptions {
  template: OperationTemplateInfo;
  defindex: number;
  operationDefindex: number;
  /** Paint name as typed. Blank falls back to new_paint_<defindex>. */
  name: string;
  /** Whether a public texture ref (textures/...webp) is shipped with the viewer. */
  isShipped: (publicRef: string) => boolean;
}

// Weapon map placeholders in a template's header (c_/p__albedo and friends). A weapon's
// own slot overrides them, but a slot that leaves one out reads the header value.
const WEAPON_MAP_PLACEHOLDER = /^textures\/models\/weapons\/c_models\/c_\/p__/;

// Only texture paths are checked. An unshipped pattern becomes a neutral stand-in. An
// unshipped weapon map placeholder also goes neutral: borrowing another weapon's map would
// paint the wrong model, and each slot overrides it anyway.
function shippedVariables(
  template: OperationTemplateInfo,
  isShipped: (publicRef: string) => boolean,
): OperationTemplateVariable[] {
  return template.variables.map((variable) => {
    const ref = texturePublicPath(variable.value);
    if (!ref || isShipped(ref)) return variable;
    if (ref.startsWith('textures/patterns/')) {
      const neutral = variable.name.includes('sticker') ? NEUTRAL_STICKER : NEUTRAL_TEXTURE;
      return { ...variable, value: neutral };
    }
    if (WEAPON_MAP_PLACEHOLDER.test(ref)) {
      return { ...variable, value: NEUTRAL_TEXTURE };
    }
    return variable;
  });
}

/**
 * The operation and definition fragments for one new paint. Both carry the template's
 * variables, since the decoder takes the definition's header variables as its base
 * dictionary. The operation holds the stages itself, because the editor only edits
 * stages its operation authors.
 */
export function buildTemplateWarPaint(options: TemplatePaintOptions): ProtoDefJsonFragment[] {
  const { template, defindex, operationDefindex } = options;
  const variables = shippedVariables(template, options.isShipped);
  const name = options.name.trim() || `new_paint_${defindex}`;

  const operation = {
    header: { defindex: operationDefindex, name: template.name, variables },
    operation_node: template.operationNode,
  };
  const definition = {
    header: { defindex, name, variables },
    operation_template: { defindex: operationDefindex, type: 'DEF_TYPE_PAINTKIT_OPERATION' },
    has_team_textures: template.teamTextures,
    ...Object.fromEntries(Object.entries(template.items).map(([field, slot]) => [
      field,
      {
        item_definition_template: { defindex: slot.defindex, type: 'DEF_TYPE_PAINTKIT_ITEM_DEFINITION' },
        data: slot.data,
      },
    ])),
  };

  return [
    { name: `new_paint_${defindex}_operation.json`, text: JSON.stringify(operation, null, 2) },
    { name: `new_paint_${defindex}_definition.json`, text: JSON.stringify(definition, null, 2) },
  ];
}

interface CopiedPaintOptions {
  /** The stock paint's definition and operation. Left unmodified. */
  messages: ProtoDefKitMessages;
  defindex: number;
  operationDefindex: number;
  /** Paint name as typed. Blank falls back to new_paint_<defindex>. */
  name: string;
}

function headerOf(message: Record<string, unknown>, label: string): Record<string, unknown> {
  if (!isRecord(message.header)) throw new Error(`The copied ${label} has no header.`);
  return message.header;
}

/**
 * Fragments for a copy of one stock paint. Only the ids and name change, so it looks the
 * same until edited; the files follow the generated-paint naming so rename and delete work.
 */
export function buildCopiedWarPaint(options: CopiedPaintOptions): ProtoDefJsonFragment[] {
  const { messages, defindex, operationDefindex } = options;
  const name = options.name.trim() || `new_paint_${defindex}`;
  const operation = structuredClone(messages.operation);
  const definition = structuredClone(messages.definition);

  headerOf(operation, 'operation').defindex = operationDefindex;
  const definitionHeader = headerOf(definition, 'definition');
  definitionHeader.defindex = defindex;
  definitionHeader.name = name;
  const reference = definition.operation_template;
  if (!isRecord(reference)) throw new Error('The copied definition does not reference an operation.');
  reference.defindex = operationDefindex;

  return [
    { name: `new_paint_${defindex}_operation.json`, text: JSON.stringify(operation, null, 2) },
    { name: `new_paint_${defindex}_definition.json`, text: JSON.stringify(definition, null, 2) },
  ];
}

const GENERATED_FILE = /^new_paint_(\d+)_(operation|definition)\.json$/;
const NEW_PAINT_SET_NAME = 'New war paints';

/**
 * Name of a JSON definition set, used in the editor's draft keys. Generated paint files
 * are excluded, so adding a paint keeps the set's name across a reload.
 */
export function definitionSetName(fileNames: readonly string[]): string {
  const imported = fileNames.filter((name) => !GENERATED_FILE.test(name));
  return imported.length ? imported.join(', ') : NEW_PAINT_SET_NAME;
}

/** The paint defindex a generated file belongs to, or null for any other file. */
export function generatedPaintDefindex(fileName: string): number | null {
  const match = GENERATED_FILE.exec(fileName);
  return match ? Number(match[1]) : null;
}

/** The fragments without both files of one generated paint. */
export function withoutGeneratedPaint(fragments: ProtoDefJsonFragment[], defindex: number): ProtoDefJsonFragment[] {
  return fragments.filter((fragment) => generatedPaintDefindex(fragment.name) !== defindex);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Renames one generated paint by changing only its definition's header name, which is
 * what the viewer shows.
 */
export function renameGeneratedPaint(
  fragments: ProtoDefJsonFragment[],
  defindex: number,
  name: string,
): ProtoDefJsonFragment[] {
  return fragments.map((fragment) => {
    const generated = GENERATED_FILE.exec(fragment.name);
    if (generated?.[2] !== 'definition' || Number(generated[1]) !== defindex) return fragment;
    const definition: unknown = JSON.parse(fragment.text);
    if (!isRecord(definition) || !isRecord(definition.header)) {
      throw new Error(`${fragment.name} has no header to rename.`);
    }
    definition.header.name = name;
    return { name: fragment.name, text: JSON.stringify(definition, null, 2) };
  });
}

/** Operation defindexes the fragments define, so a new operation can avoid them. */
export function operationDefindexesIn(fragments: ProtoDefJsonFragment[]): number[] {
  return normalizeProtoDefFragments(fragments).flatMap(({ kind, value }) => {
    const header: unknown = value.header;
    if (kind !== 'operation' || typeof header !== 'object' || header === null || !('defindex' in header)) return [];
    return typeof header.defindex === 'number' ? [header.defindex] : [];
  });
}

/**
 * The first defindexes above everything in use. Paint kits must clear every built-in and
 * loaded paint, and operations every stock and loaded operation, or the new one silently
 * replaces an entry.
 */
export function nextWarPaintIds(used: { paintDefindexes: number[]; operationDefindexes: number[] }): {
  defindex: number;
  operationDefindex: number;
} {
  return {
    defindex: Math.max(0, ...used.paintDefindexes) + 1,
    operationDefindex: Math.max(0, ...used.operationDefindexes) + 1,
  };
}

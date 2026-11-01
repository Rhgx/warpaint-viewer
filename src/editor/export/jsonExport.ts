/**
 * JSON export for the editor's proto_defs messages. Output is strict JSON, unlike the importer,
 * which accepts malformed snippets, so it imports without placeholder ids.
 */

import { normalizeProtoDefFragments, type ProtoDefFragmentKind } from '../../protodefs/jsonFragments';
import type { ProtoDefJsonFragment, ProtoDefKitBundle, ProtoDefKitMessages } from '../../protodefs/types';
import { sanitizePackName } from '../../export/plan';

export interface ProtoDefKitJsonExport {
  /** Strict JSON for the operation message. */
  operation: ProtoDefJsonFragment;
  /** Strict JSON for the paint-kit definition message. */
  definition: ProtoDefJsonFragment;
  /** Stable import order: the operation always comes before its definition. */
  fragments: readonly [ProtoDefJsonFragment, ProtoDefJsonFragment];
}

export interface ProtoDefKitBundleJsonExport {
  /** Strict JSON per message, in import order: operations, item definitions, then the definition. */
  fragments: ProtoDefJsonFragment[];
}

export interface SerializeProtoDefKitOptions {
  /** File-name stem for the returned names. Message content is never changed. */
  name?: string;
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function defindexAt(value: JsonObject, path: string): number {
  const header = value.header;
  if (!isObject(header) || typeof header.defindex !== 'number'
    || !Number.isSafeInteger(header.defindex) || header.defindex < 0) {
    throw new Error(`${path}.header.defindex must be a non-negative safe integer.`);
  }
  return header.defindex;
}

function operationReference(definition: JsonObject): number {
  const reference = definition.operation_template;
  if (!isObject(reference) || typeof reference.defindex !== 'number'
    || !Number.isSafeInteger(reference.defindex) || reference.defindex < 0) {
    throw new Error('definition.operation_template.defindex must be a non-negative safe integer.');
  }
  return reference.defindex;
}

function serializeJson(value: JsonObject, label: string): string {
  let text: string | undefined;
  try {
    text = JSON.stringify(value, null, 2);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`${label} cannot be serialized as JSON: ${message}`);
  }
  if (text === undefined) throw new Error(`${label} cannot be serialized as JSON.`);
  return `${text}\n`;
}

function equivalent(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length
      && left.every((entry, index) => equivalent(entry, right[index]));
  }
  if (!isObject(left) || !isObject(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) => Object.prototype.hasOwnProperty.call(right, key)
      && equivalent(left[key], right[key]));
}

function stemFor(definitionDefindex: number, requestedName?: string): string {
  // These names become browser downloads, so reuse the pack-name contract to block path separators.
  return requestedName?.trim()
    ? sanitizePackName(requestedName)
    : `paintkit-${definitionDefindex}`;
}

function namesFor(definitionDefindex: number, requestedName?: string): [string, string] {
  const name = stemFor(definitionDefindex, requestedName);
  return [`${name}__operation.json`, `${name}__definition.json`];
}

/**
 * Serializes an editor kit into the two strict JSON fragments normalizeProtoDefFragments() reads.
 * Absent, string, fractional or mismatched ids are rejected, so no importer placeholders such as `###` are emitted.
 */
export function serializeProtoDefKitMessages(
  kit: ProtoDefKitMessages,
  options: SerializeProtoDefKitOptions = {},
): ProtoDefKitJsonExport {
  const operationDefindex = defindexAt(kit.operation, 'operation');
  const definitionDefindex = defindexAt(kit.definition, 'definition');
  const referencedOperationDefindex = operationReference(kit.definition);
  if (referencedOperationDefindex !== operationDefindex) {
    throw new Error(
      `definition.operation_template.defindex (${referencedOperationDefindex}) must match operation.header.defindex (${operationDefindex}).`,
    );
  }

  const [operationName, definitionName] = namesFor(definitionDefindex, options.name);
  const operation: ProtoDefJsonFragment = { name: operationName, text: serializeJson(kit.operation, 'operation') };
  const definition: ProtoDefJsonFragment = { name: definitionName, text: serializeJson(kit.definition, 'definition') };
  const fragments: readonly [ProtoDefJsonFragment, ProtoDefJsonFragment] = [operation, definition];

  // Round-trip our own output through the importer so the contract cannot drift from it.
  const normalized = normalizeProtoDefFragments([...fragments]);
  if (normalized.length !== 2
    || normalized[0].kind !== 'operation'
    || normalized[1].kind !== 'definition'
    || !equivalent(normalized[0].value, kit.operation)
    || !equivalent(normalized[1].value, kit.definition)) {
    throw new Error('The supplied kit cannot round-trip through the proto_defs JSON fragment importer.');
  }

  return { operation, definition, fragments };
}

/**
 * Serializes a kit bundle into one strict JSON fragment per operation, item definition and the definition.
 * A single-operation paint with no item definitions delegates to serializeProtoDefKitMessages, so its files are unchanged.
 */
export function serializeProtoDefKitBundle(
  bundle: ProtoDefKitBundle,
  options: SerializeProtoDefKitOptions = {},
): ProtoDefKitBundleJsonExport {
  if (bundle.itemDefinitions.length === 0 && bundle.operations.length === 1) {
    const { operation, definition } = serializeProtoDefKitMessages(
      { operation: bundle.operations[0], definition: bundle.definition },
      options,
    );
    return { fragments: [operation, definition] };
  }
  if (bundle.operations.length === 0) {
    throw new Error('A kit bundle must include at least one operation.');
  }

  const stem = stemFor(defindexAt(bundle.definition, 'definition'), options.name);
  const fragments: ProtoDefJsonFragment[] = [];
  bundle.operations.forEach((operation, index) => {
    const label = `operations[${index}]`;
    const defindex = defindexAt(operation, label);
    fragments.push({ name: `${stem}__operation_${defindex}.json`, text: serializeJson(operation, label) });
  });
  bundle.itemDefinitions.forEach((itemDefinition, index) => {
    const label = `itemDefinitions[${index}]`;
    const defindex = defindexAt(itemDefinition, label);
    fragments.push({ name: `${stem}__item_${defindex}.json`, text: serializeJson(itemDefinition, label) });
  });
  fragments.push({ name: `${stem}__definition.json`, text: serializeJson(bundle.definition, 'definition') });

  const names = new Set(fragments.map((fragment) => fragment.name));
  if (names.size !== fragments.length) {
    throw new Error('The supplied kit bundle contains two messages with the same defindex.');
  }

  // Same round-trip guard as serializeProtoDefKitMessages, applied to every fragment in order.
  const values = [...bundle.operations, ...bundle.itemDefinitions, bundle.definition];
  const expectedKinds: ProtoDefFragmentKind[] = [
    ...bundle.operations.map((): ProtoDefFragmentKind => 'operation'),
    ...bundle.itemDefinitions.map((): ProtoDefFragmentKind => 'itemDefinition'),
    'definition',
  ];
  const normalized = normalizeProtoDefFragments(fragments);
  const roundTrips = normalized.length === values.length && normalized.every((fragment, index) =>
    fragment.kind === expectedKinds[index] && equivalent(fragment.value, values[index]));
  if (!roundTrips) {
    throw new Error('The supplied kit bundle cannot round-trip through the proto_defs JSON fragment importer.');
  }

  return { fragments };
}

/** Compact fragments for the live preview. Skips pretty-printing and the round-trip guard, since the preview decoder rejects bad fragments itself. */
export function serializeProtoDefKitBundlePreview(bundle: ProtoDefKitBundle): ProtoDefKitBundleJsonExport {
  if (bundle.operations.length === 0) {
    throw new Error('A kit bundle must include at least one operation.');
  }
  const stem = stemFor(defindexAt(bundle.definition, 'definition'));
  const fragments: ProtoDefJsonFragment[] = [
    ...bundle.operations.map((operation, index) => ({
      name: `${stem}__operation_${defindexAt(operation, `operations[${index}]`)}.json`,
      text: JSON.stringify(operation),
    })),
    ...bundle.itemDefinitions.map((itemDefinition, index) => ({
      name: `${stem}__item_${defindexAt(itemDefinition, `itemDefinitions[${index}]`)}.json`,
      text: JSON.stringify(itemDefinition),
    })),
    { name: `${stem}__definition.json`, text: JSON.stringify(bundle.definition) },
  ];
  return { fragments };
}

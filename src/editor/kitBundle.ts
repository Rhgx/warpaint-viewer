import type { ProtoDefKitBundle, ProtoDefKitMessages, ProtoDefOperationScope } from '../protodefs/types';

/** The weapon and wear the viewer is showing. */
export interface KitViewerScope {
  weaponKey: string;
  wear: number;
}

/** Scope for the viewer's weapon and wear: exact match, else the weapon's first wear, else the first scope. Null for top-level paints. */
export function selectActiveScope(
  scopes: readonly ProtoDefOperationScope[],
  viewer: KitViewerScope | undefined,
): ProtoDefOperationScope | null {
  const first = scopes[0] ?? null;
  if (!viewer) return first;
  return scopes.find((scope) => scope.weaponKey === viewer.weaponKey && scope.wear === viewer.wear)
    ?? scopes.find((scope) => scope.weaponKey === viewer.weaponKey)
    ?? first;
}

/** The operation the editor edits for the viewer. A top-level paint has only operation 0. */
export function activeOperationIndex(bundle: ProtoDefKitBundle, viewer: KitViewerScope | undefined): number {
  return selectActiveScope(bundle.scopes, viewer)?.operationIndex ?? 0;
}

/** The definition plus one operation: the pair every editor mutation edits. */
export function operationMessages(bundle: ProtoDefKitBundle, operationIndex: number): ProtoDefKitMessages | null {
  const operation = bundle.operations[operationIndex];
  return operation ? { definition: bundle.definition, operation } : null;
}

/** A top-level paint's two messages. A per-wear paint has no single pair, so this is null. */
export function topLevelMessages(bundle: ProtoDefKitBundle): ProtoDefKitMessages | null {
  return bundle.scopes.length === 0 ? operationMessages(bundle, 0) : null;
}

/**
 * Runs one edit on the active operation and writes it back. The definition is shared by every scope,
 * so it may change too. Returns the same bundle when nothing changed.
 */
export function applyBundleEdit(
  bundle: ProtoDefKitBundle,
  operationIndex: number,
  edit: (messages: ProtoDefKitMessages) => ProtoDefKitMessages,
): ProtoDefKitBundle {
  const prior = operationMessages(bundle, operationIndex);
  if (!prior) throw new Error('The selected paint has no operation to edit.');
  const next = edit(prior);
  if (next === prior) return bundle;
  return {
    ...bundle,
    definition: next.definition,
    operations: bundle.operations.map((operation, index) => (index === operationIndex ? next.operation : operation)),
  };
}

// Deep-frozen objects; a frozen snapshot can be reused by reference instead of cloned again.
const frozenSnapshots = new WeakSet<object>();

/** Freezes decoder messages to catch accidental UI mutation. The visited set keeps cycles safe. */
function freezeDeep<T>(value: T, visited = new WeakSet<object>()): T {
  if (!value || typeof value !== 'object') return value;
  if (ArrayBuffer.isView(value)) return value;
  const object = value as object;
  if (visited.has(object)) return value;
  visited.add(object);
  for (const child of Object.values(object as Record<string, unknown>)) freezeDeep(child, visited);
  frozenSnapshots.add(object);
  return Object.freeze(value);
}

function snapshotMessage<T>(value: T): T {
  if (value && typeof value === 'object' && frozenSnapshots.has(value)) return value;
  return freezeDeep(structuredClone(value));
}

/** Freezes a working bundle into a snapshot that shares no mutable state with its input. Frozen parts are reused by reference. */
export function snapshotBundle(bundle: ProtoDefKitBundle): ProtoDefKitBundle {
  const next = {
    ...bundle,
    scopes: snapshotMessage(bundle.scopes),
    definition: snapshotMessage(bundle.definition),
    operations: bundle.operations.map(snapshotMessage),
    itemDefinitions: bundle.itemDefinitions.map(snapshotMessage),
  };
  // Every part above is already a frozen snapshot, so only the wrapper is left to freeze.
  frozenSnapshots.add(next);
  return Object.freeze(next);
}

import type { ProtoDefKitBundle, ProtoDefKitMessages, ProtoDefOperationScope } from '../protodefs/types';

/** The weapon and wear the viewer is showing. */
export interface KitViewerScope {
  weaponKey: string;
  wear: number;
}

/**
 * The scope the editor works on for the viewer's weapon and wear: an exact
 * match, else the weapon's first wear, else the first scope. A top-level paint
 * has no scopes, so the result is null.
 */
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

/** The definition plus one operation: the pair every mutation in mutations.ts edits. */
export function operationMessages(bundle: ProtoDefKitBundle, operationIndex: number): ProtoDefKitMessages | null {
  const operation = bundle.operations[operationIndex];
  return operation ? { definition: bundle.definition, operation } : null;
}

/** A top-level paint's two messages. A per-wear paint has no single pair, so this is null. */
export function topLevelMessages(bundle: ProtoDefKitBundle): ProtoDefKitMessages | null {
  return bundle.scopes.length === 0 ? operationMessages(bundle, 0) : null;
}

/**
 * Runs one edit against the active operation and writes the result back. The
 * definition is shared by every scope, so an edit may change it too; the other
 * operations are reused as the same objects. Returns the bundle itself when the
 * edit changed nothing.
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

// Every object this module has deep-frozen. A frozen snapshot is never mutated,
// so a later snapshot can reuse it by reference instead of cloning it again.
const frozenSnapshots = new WeakSet<object>();

/**
 * Decoder messages are plain data, but freezing them catches accidental UI
 * mutation early. The WeakSet also makes this safe for an unexpected cycle.
 */
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

/**
 * Freezes a working bundle into an editor snapshot that shares no mutable state
 * with its input. Operations, the definition and item definitions that are
 * already snapshots are reused by reference, so an edit clones only what it changed.
 */
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

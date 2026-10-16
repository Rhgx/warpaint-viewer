import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';
import type { Manifest } from '../../../src/data/types';
import { useEditorDraft } from '../../../src/editor/useEditorDraft';
import { useCustomDefinitions } from '../../../src/hooks/useCustomDefinitions';
import { useSourcePackage } from '../../../src/hooks/useSourcePackage';
import type { ProtoDefKitBundle } from '../../../src/protodefs/types';
import { SourceTextureProvider } from '../../../src/source/provider';

// No DOM renderer is installed, so the hooks run over a minimal React that
// keeps state, refs and memoized values per mount, and runs an effect on flush
// only when its dependencies changed. A rerender is an explicit call.
/* oxlint-disable react-hooks/rules-of-hooks -- see above; no real React runtime is involved */
const runtime = vi.hoisted(() => {
  interface Slot {
    set: boolean;
    value: unknown;
    deps?: readonly unknown[];
    cleanup?: unknown;
    setter?: (value: unknown) => void;
  }
  let slots: Slot[] = [];
  let index = 0;
  const pending: Array<() => void> = [];
  const next = (): Slot => {
    slots[index] ??= { set: false, value: undefined };
    return slots[index++];
  };
  const changed = (slot: Slot, deps?: readonly unknown[]): boolean => (
    !slot.set || !deps || !slot.deps || deps.length !== slot.deps.length
    || deps.some((dep, i) => !Object.is(dep, slot.deps?.[i]))
  );
  const resolve = (value: unknown, previous?: unknown): unknown => (
    typeof value === 'function' ? (value as (prev: unknown) => unknown)(previous) : value
  );
  const memo = (deps: readonly unknown[] | undefined, compute: () => unknown): unknown => {
    const slot = next();
    if (changed(slot, deps)) Object.assign(slot, { set: true, deps, value: compute() });
    return slot.value;
  };
  return {
    effects: pending,
    mount<T>(hook: () => T): () => T {
      const own: Slot[] = [];
      return () => {
        slots = own;
        index = 0;
        return hook();
      };
    },
    react: {
      useState(initial: unknown) {
        const slot = next();
        if (!slot.set) {
          slot.set = true;
          slot.value = resolve(initial);
          slot.setter = (value) => { slot.value = resolve(value, slot.value); };
        }
        return [slot.value, slot.setter];
      },
      useRef: (current: unknown) => memo([], () => ({ current })),
      useMemo: (factory: () => unknown, deps?: readonly unknown[]) => memo(deps, factory),
      useCallback: (callback: unknown, deps?: readonly unknown[]) => memo(deps, () => callback),
      useEffect(effect: () => unknown, deps?: readonly unknown[]) {
        const slot = next();
        if (!changed(slot, deps)) return;
        Object.assign(slot, { set: true, deps });
        pending.push(() => {
          if (typeof slot.cleanup === 'function') (slot.cleanup as () => void)();
          slot.cleanup = effect();
        });
      },
    },
  };
});
vi.mock('react', async (importOriginal) => ({
  ...await importOriginal<typeof import('react')>(),
  ...runtime.react,
}));

const storage = vi.hoisted(() => ({
  readEditorDraft: vi.fn(async () => null),
  writeEditorDraft: vi.fn(async () => undefined),
  deleteEditorDraft: vi.fn(async () => undefined),
  readCustomSourceFiles: vi.fn(async () => null),
  writeCustomSourceFiles: vi.fn(async () => undefined),
  deleteCustomSourceFiles: vi.fn(async () => undefined),
  clearCustomWorkspace: vi.fn(async () => ({ drafts: 0 })),
}));
vi.mock('../../../src/editor/draftStorage', () => storage);

const bundle: ProtoDefKitBundle = {
  definition: { header: { defindex: 250 } },
  operations: [{ header: { defindex: 249 }, operation_node: {} }],
  itemDefinitions: [],
  scopes: [],
};
const files = [new File(['{}'], 'paint.json', { type: 'application/json' })];

async function flushEffects(): Promise<void> {
  for (const effect of runtime.effects.splice(0)) effect();
  // Let storage promise chains and file reads settle.
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const mountDraft = (enabled: boolean) => runtime.mount(() => useEditorDraft({
  key: 'stock:250', kitId: 250, revision: 1, original: bundle, current: bundle, dirty: true, restore: () => true, enabled,
}));

beforeEach(() => {
  runtime.effects.length = 0;
  vi.clearAllMocks();
});

test('a disabled workshop never reads, writes, or deletes saved drafts and custom files', async () => {
  const draft = mountDraft(false);
  const pkg = runtime.mount(() => useSourcePackage((ref) => ref, () => undefined, undefined, false));
  const provider = new SourceTextureProvider((ref) => ref);
  const manifest: Manifest = { generatedAt: '', paintkits: [], weapons: [], wearLevels: [], wearNames: [] };
  const definitions = runtime.mount(() => useCustomDefinitions({ manifest, getAssetUrl: (rel) => rel, provider, packageGeneration: 0, enabled: false }));
  for (const render of [draft, pkg, definitions]) render();
  await flushEffects();

  draft().save();
  pkg().sourcePackage.onImport(files);
  pkg().removePackage();
  definitions().state.onImport(files);
  definitions().state.onRemove();
  await flushEffects();
  assert.equal(Object.values(storage).reduce((total, mock) => total + mock.mock.calls.length, 0), 0);
});

test('the enabled draft hook does read storage, so the check above is not vacuous', async () => {
  mountDraft(true)();
  await flushEffects();
  assert.equal(storage.readEditorDraft.mock.calls.length, 1);
});

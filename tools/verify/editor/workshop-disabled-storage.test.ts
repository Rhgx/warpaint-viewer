import assert from 'node:assert/strict';
import { afterEach, beforeEach, test, vi } from 'vitest';
import type { Manifest } from '../../../src/data/types';
import type { EditorDraftRecord } from '../../../src/editor/draftStorage';
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
  readEditorDraft: vi.fn(async (_key: string): Promise<EditorDraftRecord | null> => null),
  writeEditorDraft: vi.fn(async (_record: EditorDraftRecord) => undefined),
  deleteEditorDraft: vi.fn(async (_key: string) => undefined),
  readCustomSourceFiles: vi.fn(async (_kind: string): Promise<File[] | null> => null),
  writeCustomSourceFiles: vi.fn(async (_kind: string, _files: File[]) => undefined),
  deleteCustomSourceFiles: vi.fn(async (_kind: string) => undefined),
  clearCustomWorkspace: vi.fn(async () => ({ drafts: 0 })),
}));
vi.mock('../../../src/editor/draftStorage', () => storage);

const DRAFT_KEY = 'stock:250';
const bundle: ProtoDefKitBundle = {
  definition: { header: { defindex: 250 } },
  operations: [{ header: { defindex: 249 }, operation_node: {} }],
  itemDefinitions: [],
  scopes: [],
};
const storedDraft: EditorDraftRecord = {
  version: 2,
  key: DRAFT_KEY,
  kitId: 250,
  savedAt: 1_788_000_000_000,
  bundle: { ...bundle, definition: { header: { defindex: 250 }, name: 'Edited' } },
};
// Enough for the definitions hook to attempt its restore.
const manifest: Manifest = { generatedAt: '', paintkits: [], weapons: [], wearLevels: [], wearNames: [] };
const getAssetUrl = (rel: string) => rel;
const files = [new File(['{}'], 'paint.json', { type: 'application/json' })];

async function flushEffects(): Promise<void> {
  for (const effect of runtime.effects.splice(0)) effect();
  // Let storage promise chains and file reads settle.
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function storageCalls(): number {
  return Object.values(storage).reduce((total, mock) => total + mock.mock.calls.length, 0);
}

function kindCalls(mock: { mock: { calls: ReadonlyArray<readonly unknown[]> } }, kind: string): number {
  return mock.mock.calls.filter(([entry]) => entry === kind).length;
}

type DraftHook = typeof useEditorDraft;
type DraftOptions = Parameters<DraftHook>[0];

function mountDraft(hook: DraftHook, props: Partial<DraftOptions>) {
  let options: DraftOptions = {
    key: DRAFT_KEY,
    kitId: 250,
    revision: 1,
    original: bundle,
    current: bundle,
    dirty: false,
    restore: () => true,
    ...props,
  };
  const render = runtime.mount(() => hook(options));
  return {
    render,
    update(next: Partial<DraftOptions>) {
      options = { ...options, ...next };
      return render();
    },
  };
}

/** Opens a stored draft, restores and discards it, ends a clean session, and saves a dirty one. */
async function exerciseDraft(hook: DraftHook, enabled?: boolean) {
  const overrides = enabled === undefined ? {} : { enabled };
  const restore = vi.fn((_bundle: ProtoDefKitBundle) => true);
  let recoverySeen = false;

  storage.readEditorDraft.mockResolvedValue(storedDraft);
  for (const action of ['restore', 'discard'] as const) {
    const draft = mountDraft(hook, { ...overrides, restore });
    draft.render();
    await flushEffects();
    const recovery = draft.render().recovery;
    if (recovery) {
      recoverySeen = true;
      recovery[action]();
    }
    await flushEffects();
  }

  storage.readEditorDraft.mockResolvedValue(null);
  const clean = mountDraft(hook, overrides);
  clean.render();
  await flushEffects();
  // A new clean bundle (an edit that was undone) deletes the stored draft.
  clean.update({ current: structuredClone(bundle) });
  await flushEffects();

  const dirty = mountDraft(hook, { ...overrides, dirty: true });
  dirty.render();
  await flushEffects();
  dirty.render().save();
  await flushEffects();

  return { recoverySeen, restore };
}

async function exerciseSourcePackage(hook: typeof useSourcePackage, enabled?: boolean) {
  // The import callback is stable in the app, as it must be here, or every
  // render would count as a new restore.
  const onSuccessfulImport = () => undefined;
  const render = runtime.mount(() => hook((ref) => ref, onSuccessfulImport, undefined, enabled));
  render();
  await flushEffects();
  const pkg = render();
  pkg.sourcePackage.onImport(files);
  pkg.removePackage();
  await flushEffects();
}

async function exerciseDefinitions(enabled: boolean) {
  const provider = new SourceTextureProvider((ref) => ref);
  const render = runtime.mount(() => useCustomDefinitions({
    manifest,
    getAssetUrl,
    provider,
    packageGeneration: 0,
    enabled,
  }));
  render();
  await flushEffects();
  const definitions = render();
  definitions.state.onImport(files);
  definitions.state.onRemove();
  await flushEffects();
}

beforeEach(() => {
  runtime.effects.length = 0;
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test('a disabled workshop never reads, writes, or deletes saved drafts and custom files', async () => {
  const { recoverySeen, restore } = await exerciseDraft(useEditorDraft, false);
  await exerciseSourcePackage(useSourcePackage, false);
  await exerciseDefinitions(false);

  assert.equal(recoverySeen, false, 'no stored draft is offered for recovery');
  assert.equal(restore.mock.calls.length, 0);
  assert.equal(kindCalls(storage.readCustomSourceFiles, 'definitions'), 0);
  assert.equal(storageCalls(), 0);
});

test('the same actions do reach storage when the workshop is enabled', async () => {
  const { recoverySeen, restore } = await exerciseDraft(useEditorDraft, true);
  assert.ok(recoverySeen, 'the stored draft is offered for recovery');
  assert.deepEqual(restore.mock.calls, [[storedDraft.bundle]], 'restore applies the stored bundle');
  assert.ok(storage.readEditorDraft.mock.calls.length > 0, 'the draft is read on open');
  assert.equal(storage.deleteEditorDraft.mock.calls.length, 2, 'discard and the clean session both delete');
  assert.equal(storage.writeEditorDraft.mock.calls.length, 1, 'a dirty session saves');

  await exerciseSourcePackage(useSourcePackage, true);
  assert.equal(kindCalls(storage.readCustomSourceFiles, 'package'), 1, 'the saved package is restored');
  assert.equal(kindCalls(storage.deleteCustomSourceFiles, 'package'), 1, 'package removal deletes its files');

  await exerciseDefinitions(true);
  assert.equal(kindCalls(storage.readCustomSourceFiles, 'definitions'), 1, 'the saved definitions are restored');
  assert.equal(kindCalls(storage.deleteCustomSourceFiles, 'definitions'), 1, 'definitions removal deletes their files');
});

/** Loads the device flag and the hooks that default from it, as a device with this pointer would. */
async function importForDevice(touchOnly: boolean) {
  vi.resetModules();
  vi.stubGlobal('window', {
    matchMedia: (query: string) => ({ matches: touchOnly && query === '(hover: none) and (pointer: coarse)' }),
  });
  return {
    device: await import('../../../src/device'),
    draft: await import('../../../src/editor/useEditorDraft'),
    sourcePackage: await import('../../../src/hooks/useSourcePackage'),
  };
}

test('a touch-only device disables the workshop, and the hooks default to that', async () => {
  const { device, draft, sourcePackage } = await importForDevice(true);
  assert.equal(device.TOUCH_ONLY_DEVICE, true);
  assert.equal(device.WORKSHOP_ENABLED, false);

  const { recoverySeen } = await exerciseDraft(draft.useEditorDraft);
  await exerciseSourcePackage(sourcePackage.useSourcePackage);
  assert.equal(recoverySeen, false);
  assert.equal(storageCalls(), 0);
});

test('a fine pointer keeps the workshop', async () => {
  const { device } = await importForDevice(false);
  assert.equal(device.TOUCH_ONLY_DEVICE, false);
  assert.equal(device.WORKSHOP_ENABLED, true);
});

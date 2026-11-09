import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { Viewer } from '../../../src/viewer/Viewer';

test('returning to the displayed model drops a slower load that is still in flight', async () => {
  let finishOther!: (parts: unknown[]) => void;
  const otherParts = new Promise<unknown[]>((resolve) => { finishOther = resolve; });
  const setMeshGeometries = vi.fn();
  const discard = vi.fn();
  // Just the fields loadModel reads: model "a" is on screen and "b" is slow to load.
  const viewer = {
    currentModelUrl: 'a',
    meshes: [{}],
    loadToken: 0,
    disposed: false,
    statClockWeaponKey: null,
    modelLoader: { load: () => otherParts },
    weaponAttachments: { load: async () => [], discard, setAttachments: vi.fn() },
    setMeshGeometries,
    placeStatClock: vi.fn(),
    clearModel: vi.fn(),
  };
  const load = (url: string) => Reflect.apply(Viewer.prototype.loadModel, viewer, [url]);

  const slow = load('b');
  await load('a');
  finishOther([]);
  await slow;

  assert.equal(setMeshGeometries.mock.calls.length, 0, 'the abandoned model must not replace the displayed one');
  assert.equal(discard.mock.calls.length, 1, 'its attachments are discarded');
  assert.equal(viewer.currentModelUrl, 'a');
});

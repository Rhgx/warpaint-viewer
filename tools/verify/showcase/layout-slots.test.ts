import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';

import type { ShowcaseItem } from '../../../src/showcase/showcaseTypes';
import { inPaint, matchesBoard, parseLayoutSlot, readLayoutSlots, readSlotBackups, slotImages, writeLayoutSlot, writeSlotBackup, type LayoutSlot } from '../../../src/ui/showcase/layoutSlots';
import { parseSettings } from '../../../src/ui/showcase/showcaseSettings';

const item: ShowcaseItem = {
  id: 'item-7',
  weaponKey: 'c_scattergun',
  weaponName: 'Scattergun',
  paint: { kitId: 85, kitName: 'Killer Bee', team: 'blu', wearIndex: 2, seed: '1234' },
  x: 1.5,
  y: -2,
  roll: -90,
  tilt: 10,
  turn: 0,
  flipped: true,
  scale: 0.8,
  hidden: false,
  pose: { pump: 12 },
  part: null,
  hiddenParts: ['shell'],
};
const picture: ShowcaseItem = { ...item, id: 'item-8', weaponKey: '', image: { assetId: 'logo', aspect: 1.5 } };
const settings = { ...parseSettings(null), grid: 'coarse', keepApart: false, lightAzimuth: 40, shadow: 15, background: 'transparent', outputWidth: 3840, poseHandles: false, weaponSize: 70 } as const;
const slot: LayoutSlot = {
  name: 'Bee board',
  savedAt: 1_700_000_000_000,
  thumbnail: 'data:image/webp;base64,AAAA',
  items: [item, picture],
  settings,
  layout: { rows: [[{ weaponKey: 'c_scattergun', paint: item.paint }]], pack: 'order', inward: true, upright: false, logoSpace: false },
  featured: 'c_scattergun',
  pairs: ['c_scattergun', 'c_minigun'],
};

function fakeStorage() {
  const stored = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
    removeItem: (key: string) => void stored.delete(key),
  });
  return stored;
}

afterEach(() => vi.unstubAllGlobals());

test('a slot comes back with its weapons, pictures, settings, layout and picked weapons', () => {
  fakeStorage();
  assert.equal(writeLayoutSlot(1, slot), true);
  assert.deepStrictEqual(readLayoutSlots(), [null, slot, null]);
});

test('a layout without a packing survives saving, as the RED and BLU rows have none', () => {
  fakeStorage();
  const layout = { rows: [[{ weaponKey: 'c_scattergun', paint: item.paint }]], pack: undefined, inward: true, upright: false, logoSpace: false };
  assert.equal(writeLayoutSlot(0, { ...slot, layout }), true);
  assert.deepEqual(readLayoutSlots()[0]?.layout, layout);
});

test('a slot\'s previous save is kept apart from it', () => {
  fakeStorage();
  writeLayoutSlot(0, slot);
  assert.equal(writeSlotBackup(0, { ...slot, name: 'Older' }), true);
  assert.equal(readLayoutSlots()[0]?.name, 'Bee board');
  assert.equal(readSlotBackups()[0]?.name, 'Older');
  writeLayoutSlot(0, null);
  assert.equal(readSlotBackups()[0]?.name, 'Older', 'deleting the slot keeps the way back');
  writeSlotBackup(0, null);
  assert.equal(readSlotBackups()[0], null);
});

test('emptying a slot leaves the others alone', () => {
  fakeStorage();
  writeLayoutSlot(0, slot);
  writeLayoutSlot(2, slot);
  assert.equal(writeLayoutSlot(0, null), true);
  assert.deepStrictEqual(readLayoutSlots(), [null, null, slot]);
});

test('a refused write is reported, and keeps what the slot held', () => {
  const stored = fakeStorage();
  writeLayoutSlot(0, slot);
  const before = stored.get('warpaint-viewer:showcase-slot-1');
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: () => { throw new DOMException('full', 'QuotaExceededError'); },
    removeItem: () => undefined,
  });
  assert.equal(writeLayoutSlot(0, { ...slot, savedAt: 1 }), false);
  assert.equal(stored.get('warpaint-viewer:showcase-slot-1'), before);
  assert.deepStrictEqual(readLayoutSlots()[0], slot);
});

test('damaged JSON costs only its own slot', () => {
  const stored = fakeStorage();
  writeLayoutSlot(0, slot);
  stored.set('warpaint-viewer:showcase-slot-2', '{not json');
  assert.deepStrictEqual(readLayoutSlots(), [slot, null, null]);
});

test('a damaged weapon or a missing board drops the slot', () => {
  const saved = JSON.parse(JSON.stringify({ version: 1, ...slot }));
  assert.equal(parseLayoutSlot({ ...saved, items: [{ ...item, scale: 0 }] }), null);
  assert.equal(parseLayoutSlot({ ...saved, items: [] }), null, 'nothing to load');
  assert.equal(parseLayoutSlot({ ...saved, version: 2 }), null);
  assert.equal(parseLayoutSlot({ ...saved, savedAt: 'today' }), null);
});

test('damage around the weapons keeps them, with the rest at its safe value', () => {
  const saved = JSON.parse(JSON.stringify({ version: 1, ...slot }));
  const damaged = parseLayoutSlot({ ...saved, layout: { ...saved.layout, pack: 'spiral' }, settings: { ...saved.settings, grid: 'huge' }, featured: 3, pairs: [1, 'c_minigun'] });
  assert.deepStrictEqual(damaged?.items, slot.items);
  assert.equal(damaged?.layout, null);
  assert.equal(damaged?.settings.grid, 'normal', 'an unknown value falls back to the default');
  assert.equal(damaged?.settings.shadow, 15, 'the other settings stay');
  assert.equal(damaged?.featured, null);
  assert.deepEqual(damaged?.pairs, ['c_minigun']);
});

test('a thumbnail that is not an image of ours is dropped, keeping the slot', () => {
  const saved = JSON.parse(JSON.stringify({ version: 1, ...slot }));
  for (const thumbnail of ['javascript:alert(1)', 'https://example.com/a.png', 'data:text/html;base64,AAAA', 5]) {
    assert.equal(parseLayoutSlot({ ...saved, thumbnail })?.thumbnail, null, String(thumbnail));
  }
});

test('a long or padded name is tidied', () => {
  const saved = JSON.parse(JSON.stringify({ version: 1, ...slot }));
  assert.equal(parseLayoutSlot({ ...saved, name: `  ${'x'.repeat(100)}` })?.name.length, 32);
  assert.equal(parseLayoutSlot({ ...saved, name: 7 })?.name, '');
});

test('a slot matches the board until something that shows changes, whatever the ids', () => {
  const live = slot.items.map((entry, index) => ({ ...entry, id: `item-${index + 100}` }));
  assert.equal(matchesBoard(slot, live, settings), true);
  assert.equal(matchesBoard(slot, [{ ...live[0], x: 9 }, live[1]], settings), false, 'moved');
  assert.equal(matchesBoard(slot, [{ ...live[0], paint: { ...live[0].paint, wearIndex: 0 } }, live[1]], settings), false, 'repainted');
  assert.equal(matchesBoard(slot, [live[1], live[0]], settings), false, 'reordered');
  assert.equal(matchesBoard(slot, [live[0]], settings), false, 'removed');
  assert.equal(matchesBoard(slot, live, { ...settings, shadow: 90 }), false, 'a setting that shows changed');
  assert.equal(matchesBoard(slot, live, { ...settings, showFootprints: !settings.showFootprints, outputWidth: 1280 }), true, 'a working preference is not a change to the board');
  assert.equal(matchesBoard(slot, [{ ...live[0], pose: { pump: 12 } }, live[1]], settings), true, 'same pose');
});

test('a board goes into another paint as far as that paint covers it', () => {
  const minigun: ShowcaseItem = { ...item, id: 'item-9', weaponKey: 'c_minigun', weaponName: 'Minigun' };
  const saved = { ...slot, items: [item, minigun, picture] };
  const { board, kept } = inPaint(saved, { id: 200, name: 'Other', weapons: ['c_scattergun'] });
  assert.equal(kept, 1, 'the minigun is not covered');
  assert.deepEqual(board.items[0].paint, { ...item.paint, kitId: 200, kitName: 'Other' }, 'wear, team and seed stay');
  assert.deepEqual(board.items[0].x, item.x, 'the arrangement stays');
  assert.deepEqual(board.items[1].paint, item.paint, 'an uncovered weapon keeps its paint');
  assert.deepEqual(board.items[2], picture, 'pictures are left alone');
  assert.equal(board.layout?.rows[0][0].paint.kitId, 200, 'Fill would otherwise bring the old paint back');
  assert.equal(saved.items[0].paint.kitId, item.paint.kitId, 'the slot itself is untouched');
});

test('slots keep their pictures from the start-up cleanup', () => {
  assert.deepEqual([...slotImages([null, slot, { ...slot, items: [item] }])], ['logo']);
});

import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { test } from 'vitest';

import type { ShowcaseItem } from '../../../src/showcase/showcaseTypes';
import { LayoutFileError, layoutFileName, pictureIndex, readLayoutFile, writeLayoutFile, type SharedLayout } from '../../../src/ui/showcase/layoutFile';
import { parseSettings } from '../../../src/ui/showcase/showcaseSettings';

const paint = { kitId: 85, kitName: 'Killer Bee', team: 'blu', wearIndex: 2, seed: '7142535415579923845' } as const;
const item: ShowcaseItem = {
  id: 'item-7', weaponKey: 'c_scattergun', weaponName: 'Scattergun', paint, x: 1.25, y: -2.5, roll: -90, tilt: 10.123456789, turn: 0, flipped: true, scale: 0.8123, hidden: true,
  pose: { pump: 12.5, 'späť': 3 }, part: null, hiddenParts: ['shell'],
};
const part: ShowcaseItem = { ...item, id: 'item-8', part: 'shell', pose: {}, hiddenParts: [], flipped: false, hidden: false };
const picture: ShowcaseItem = { ...item, id: 'item-9', weaponKey: '', weaponName: 'Logo', pose: {}, hiddenParts: [], image: { assetId: 'logo-asset', aspect: 1.5 } };
const copy: ShowcaseItem = { ...picture, id: 'item-10', x: 40 };
const layout: SharedLayout = {
  name: 'Bee board',
  items: [item, part, picture, copy],
  settings: { ...parseSettings(null), grid: 'coarse', keepApart: false, lightAzimuth: 40, shadow: 15, background: 'transparent', outputWidth: 3840, poseHandles: false, weaponSize: 70 },
  layout: { rows: [[{ weaponKey: 'c_scattergun', paint }, { weaponKey: 'c_minigun', paint: { ...paint, team: 'red' } }]], pack: undefined, inward: true, upright: false, logoSpace: true },
  featured: 'c_scattergun',
  pairs: ['c_scattergun', 'c_minigun'],
};
const pictureBytes = new Uint8Array([1, 2, 3, 4, 5, 250]);
const readPicture = async () => new Blob([pictureBytes]);
const bytesOf = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());

/** A file around a body of our own making, for what the writer would never produce. */
function fileAround(body: Uint8Array): Blob {
  const compressed = deflateSync(body);
  const length: number[] = [];
  for (let rest = compressed.length; ; rest = Math.floor(rest / 128)) {
    if (rest < 128) { length.push(rest); break; }
    length.push((rest % 128) | 128);
  }
  return new Blob([new Uint8Array([0x57, 0x50, 0x4c, 0x59, 1, ...length]), compressed]);
}

const rejects = async (file: Blob, label: string) => {
  await assert.rejects(readLayoutFile(file), LayoutFileError, label);
};

test('a file brings back everything on the board, with each picture stored once', async () => {
  const { file, missing } = await writeLayoutFile(layout, readPicture);
  assert.equal(missing, 0);
  const read = await readLayoutFile(file);
  assert.equal(read.pictures.length, 1, 'two copies of a picture share its bytes');
  assert.deepEqual(await bytesOf(read.pictures[0]), pictureBytes);
  assert.equal(read.layout.name, layout.name);
  assert.deepStrictEqual(read.layout.settings, layout.settings);
  assert.deepEqual(read.layout.layout, layout.layout);
  assert.equal(read.layout.featured, layout.featured);
  assert.deepEqual(read.layout.pairs, layout.pairs);
  const withoutIds = (items: readonly ShowcaseItem[]) => items.map(({ image, ...rest }) => ({ ...rest, id: '', aspect: image?.aspect }));
  assert.deepEqual(withoutIds(read.layout.items), withoutIds(layout.items));
  const [first, second] = read.layout.items.slice(2).map((entry) => entry.image?.assetId ?? '');
  assert.equal(pictureIndex(first), 0);
  assert.equal(first, second);
  assert.equal(new Set(read.layout.items.map((entry) => entry.id)).size, 4, 'ids are unique');
});

test('every setting is in the file, so a new one cannot be forgotten', async () => {
  const flipped = Object.fromEntries(Object.entries(parseSettings(null)).map(([key, value]) => [key, typeof value === 'boolean' ? !value : value]));
  const { file } = await writeLayoutFile({ ...layout, settings: parseSettings(flipped) }, readPicture);
  assert.deepStrictEqual((await readLayoutFile(file)).layout.settings, parseSettings(flipped));
});

test('a full board stays small, far smaller than the same data as JSON', async () => {
  const items = Array.from({ length: 20 }, (_, index) => ({ ...item, id: `item-${index}`, weaponKey: `c_weapon_${index}`, weaponName: `Weapon ${index}`, x: index * 2.5, y: -index * 1.25, tilt: 0, scale: 0.75 }));
  const { file } = await writeLayoutFile({ ...layout, items }, readPicture);
  const json = JSON.stringify({ ...layout, items }).length;
  assert.ok(file.size < 1024, `${file.size} bytes`);
  assert.ok(file.size < json / 5, `${file.size} bytes against ${json} of JSON`);
});

test('an item whose picture is gone is left out and counted, not written broken', async () => {
  const { file, missing } = await writeLayoutFile(layout, async () => null);
  assert.equal(missing, 2);
  const read = await readLayoutFile(file);
  assert.equal(read.pictures.length, 0);
  assert.equal(read.layout.items.length, 2);
});

test('a board that came from no ready-made layout has none in its file', async () => {
  const { file } = await writeLayoutFile({ ...layout, layout: null, featured: null, pairs: [] }, readPicture);
  const read = await readLayoutFile(file);
  assert.equal(read.layout.layout, null);
  assert.equal(read.layout.featured, null);
});

test('other files are turned down with a reason', async () => {
  await assert.rejects(readLayoutFile(new Blob(['not a layout at all'])), /Not a \.pegboard file\./);
  await assert.rejects(readLayoutFile(new Blob([])), /Not a \.pegboard file\./);
  await assert.rejects(readLayoutFile(new Blob([new Uint8Array([0x57, 0x50, 0x4c, 0x59, 2, 0])])), /newer version\. Refresh/);
});

test('every cut-off length and every flipped byte is refused or harmless, never a crash', async () => {
  const { file } = await writeLayoutFile({ ...layout, items: [item, part], layout: null }, readPicture);
  const bytes = await bytesOf(file);
  for (let length = 0; length < bytes.length; length += 1) {
    await rejects(new Blob([bytes.slice(0, length)]), `cut off at ${length}`);
  }
  for (let at = 0; at < bytes.length; at += 1) {
    const flipped = bytes.slice();
    flipped[at] ^= 0x41;
    const outcome = await readLayoutFile(new Blob([flipped])).then(() => 'read', (cause: unknown) => cause);
    // The version byte can flip to an older number, which still reads; zlib's checksum catches the body.
    if (outcome !== 'read') assert.ok(outcome instanceof LayoutFileError, `byte ${at}: ${String(outcome)}`);
  }
});

test('hostile bodies are refused', async () => {
  // A string table claiming far more entries than there are bytes.
  await rejects(fileAround(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0x7f])), 'lying count');
  // A varint that never ends.
  await rejects(fileAround(new Uint8Array(32).fill(0xff)), 'endless varint');
  // A decompression bomb: mostly zeros that inflate past the limit.
  await rejects(fileAround(new Uint8Array(8 * 1024 * 1024)), 'decompression bomb');
});

test('values a save could never hold are refused', async () => {
  const check = async (patch: Partial<ShowcaseItem>, label: string) => {
    const { file } = await writeLayoutFile({ ...layout, items: [{ ...item, ...patch }], layout: null }, readPicture);
    await rejects(file, label);
  };
  await check({ x: 1e7 }, 'far off the board');
  await check({ scale: 1000 }, 'enormous');
  await check({ scale: -1 }, 'negative size');
  await check({ paint: { ...paint, seed: '12; drop' } }, 'seed that is not a number');
  await check({ paint: { ...paint, wearIndex: 1000 } }, 'wear out of range');
});

test('a pose control named like an object internal stays plain data', async () => {
  const { file } = await writeLayoutFile({ ...layout, items: [{ ...item, pose: JSON.parse('{"__proto__": 5, "pump": 1}') as Record<string, number> }], layout: null }, readPicture);
  await readLayoutFile(file).then(({ layout: read }) => {
    assert.equal(({} as Record<string, unknown>).pump, undefined, 'nothing leaked onto Object');
    assert.equal(read.items[0].pose.pump, 1);
  });
});

test('file names are safe and readable', () => {
  assert.equal(layoutFileName('Bee board'), 'Bee board.pegboard');
  assert.equal(layoutFileName('../../evil<>:"|?*'), 'evil.pegboard');
  assert.equal(layoutFileName('   '), 'showcase-layout.pegboard');
  assert.equal(layoutFileName('Şerbetçi 1'), 'Şerbetçi 1.pegboard');
});

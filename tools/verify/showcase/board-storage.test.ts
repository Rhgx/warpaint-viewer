
import assert from 'node:assert/strict';
import { test } from 'vitest';

import { parseSavedBoard } from '../../../src/showcase/boardStorage';
import type { ShowcaseItem } from '../../../src/showcase/showcaseTypes';

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
const saved = (items: unknown) => JSON.parse(JSON.stringify({ version: 1, items }));

test('a saved board restores every weapon field as saved', () => {
  const part = { ...item, id: 'item-8', part: 'shell', pose: {}, hiddenParts: [] };
  assert.deepStrictEqual(parseSavedBoard(saved([item, part])), [item, part]);
  assert.deepStrictEqual(parseSavedBoard(saved([])), [], 'an empty board is a valid save');
});

test('a saved picture comes back with its asset, and a damaged one drops the save', () => {
  const picture: ShowcaseItem = { ...item, id: 'item-8', weaponKey: '', image: { assetId: 'asset', aspect: 1.5 } };
  assert.deepEqual(parseSavedBoard({ version: 1, items: [picture] }), [picture]);
  assert.equal(parseSavedBoard({ version: 1, items: [{ ...picture, image: { assetId: 'asset', aspect: 0 } }] }), null);
});

test('a missing, foreign or damaged save restores nothing', () => {
  assert.equal(parseSavedBoard(null), null);
  assert.equal(parseSavedBoard({ version: 2, items: [item] }), null, 'another save version');
  assert.equal(parseSavedBoard({ version: 1 }), null, 'no item list');
  const damaged: [string, unknown][] = [
    ['x', 'left'],
    ['scale', 0],
    ['flipped', 'yes'],
    ['part', 3],
    ['hiddenParts', [1]],
    ['pose', { pump: 'open' }],
    ['paint', { ...item.paint, team: 'green' }],
    ['paint', { ...item.paint, kitId: 8.5 }],
  ];
  for (const [field, value] of damaged) {
    assert.equal(parseSavedBoard(saved([item, { ...item, id: 'item-9', [field]: value }])), null, `${field} = ${JSON.stringify(value)} drops the whole save`);
  }
  assert.equal(parseSavedBoard(saved([item, item])), null, 'two weapons with one id');
});

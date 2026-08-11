// Texture-aware editor layer-colour contract check.

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { EDITOR_LAYER_MAP_COLORS, chooseEditorLayerColors } from '../../../src/editor/layerMap';
import type { RgbaImageDataLike } from '../../../src/editor/groupSampling';

function thumbnail(red: number, green: number, blue: number, alpha = 255): RgbaImageDataLike {
  const data = new Uint8ClampedArray(16 * 16 * 4);
  for (let pixel = 0; pixel < 16 * 16; pixel += 1) {
    data.set([red, green, blue, alpha], pixel * 4);
  }
  return { width: 16, height: 16, data };
}

function isFiniteColor(color: readonly number[]): boolean {
  return color.length === 3 && color.every((channel) => Number.isFinite(channel) && channel >= 0 && channel <= 1);
}

test('texture-aware editor layer colors', () => {
  const dark = thumbnail(8, 12, 18);
  const light = thumbnail(242, 236, 220);
  const vibrant = thumbnail(226, 38, 96);
  const transparent = thumbnail(255, 255, 255, 0);

  const ordinary = chooseEditorLayerColors([
    { thumbnail: dark, fallbackIndex: 0 },
    { thumbnail: light, fallbackIndex: 1 },
    { thumbnail: vibrant, fallbackIndex: 2 },
  ]);
  assert.equal(ordinary.length, 3);
  assert.ok(ordinary.every(isFiniteColor), 'dark, light, and vibrant textures choose finite RGB colours');

  assert.deepEqual(
    chooseEditorLayerColors([{ thumbnail: transparent, fallbackIndex: 4 }]),
    [EDITOR_LAYER_MAP_COLORS[4]],
    'fully transparent artwork retains the exact indexed fallback',
  );
  assert.deepEqual(
    chooseEditorLayerColors([{ thumbnail: null, fallbackIndex: 5 }]),
    [EDITOR_LAYER_MAP_COLORS[5]],
    'missing artwork retains the exact indexed fallback',
  );

  const sameTexture = [
    { thumbnail: vibrant, fallbackIndex: 0 },
    { thumbnail: vibrant, fallbackIndex: 1 },
    { thumbnail: vibrant, fallbackIndex: 2 },
    { thumbnail: vibrant, fallbackIndex: 3 },
    { thumbnail: vibrant, fallbackIndex: 4 },
    { thumbnail: vibrant, fallbackIndex: 5 },
  ];
  const first = chooseEditorLayerColors(sameTexture);
  const second = chooseEditorLayerColors(sameTexture);
  assert.deepEqual(first, second, 'identical input always chooses the same colour order');
  assert.equal(new Set(first.map((color) => color.join(','))).size, first.length, 'same-texture layers stay distinct');
  const pairDistances = first.flatMap((color, index) => first.slice(index + 1).map((other) => (
    Math.hypot(color[0] - other[0], color[1] - other[1], color[2] - other[2])
  )));
  assert.ok(Math.min(...pairDistances) > 0.2, 'generated layer colours remain clearly separated');
  assert.ok(first.flat().every((channel: number) => Number.isFinite(channel)), 'all output channels are finite');
});

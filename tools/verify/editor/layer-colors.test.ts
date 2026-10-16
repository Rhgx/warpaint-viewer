// Texture-aware editor layer-colour contract check.

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { EDITOR_LAYER_MAP_COLORS, chooseEditorLayerColors } from '../../../src/editor/layers/layerMap';
import type { RgbaImageDataLike } from '../../../src/editor/layers/groupSampling';

function thumbnail(red: number, green: number, blue: number, alpha = 255): RgbaImageDataLike {
  const data = new Uint8ClampedArray(16 * 16 * 4);
  for (let pixel = 0; pixel < 16 * 16; pixel += 1) {
    data.set([red, green, blue, alpha], pixel * 4);
  }
  return { width: 16, height: 16, data };
}

test('texture-aware editor layer colors', () => {
  const vibrant = thumbnail(226, 38, 96);
  const transparent = thumbnail(255, 255, 255, 0);

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

  const sameTexture = [0, 1, 2, 3, 4, 5].map((fallbackIndex) => ({ thumbnail: vibrant, fallbackIndex }));
  const first = chooseEditorLayerColors(sameTexture);
  const second = chooseEditorLayerColors(sameTexture);
  assert.deepEqual(first, second, 'identical input always chooses the same colour order');
  assert.equal(new Set(first.map((color) => color.join(','))).size, first.length, 'same-texture layers stay distinct');
  const pairDistances = first.flatMap((color, index) => first.slice(index + 1).map((other) => (
    Math.hypot(color[0] - other[0], color[1] - other[1], color[2] - other[2])
  )));
  assert.ok(Math.min(...pairDistances) > 0.2, 'generated layer colours remain clearly separated');
});

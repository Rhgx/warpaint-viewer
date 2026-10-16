// End-to-end UV-orientation contract for the 2D sticker editor.

import assert from 'node:assert/strict';
import { test } from 'vitest';
import * as geometry from '../../../src/editor/sticker/stickerGeometry';
import * as rows from '../../../src/editor/sticker/stickerSurface';
import * as viewport from '../../../src/editor/sticker/stickerViewport';
import { close } from '../fixtures';


test('2D editor and compositor sticker UV alignment', () => {

  // This deliberately asymmetric placement catches a vertical flip. The 2D
  // editor maps its CSS left/top percentages straight to these UV coordinates;
  // the Viewer and compositor consume the same authored TL/TR/BL fields.
  const placement = { x: 0.23, y: 0.71, width: 0.18, height: 0.12, rotation: 0 };
  const quad = geometry.stickerPlacementToQuad(placement);
  assert.ok(quad, 'valid placement serializes to an authored destination');
  // CSS/UV x and y map directly; top-right stays on the top row, bottom-left sits below top-left.
  close(quad, { tl: [0.14, 0.65], tr: [0.32, 0.65], bl: [0.14, 0.77] }, 'authored quad');

  // A screen pointer at 92px,142px on a 400x200 fitted 2D surface means
  // exactly the same (.23,.71) UV point used by the authored centre above.
  // This catches accidentally passing CSS-normalized values to a viewport API
  // that expects pixels (or introducing another vertical flip while zooming).
  const pointerUv = viewport.stickerViewportPointToUv(
    { x: 92, y: 142 },
    viewport.DEFAULT_STICKER_VIEWPORT,
    { width: 400, height: 200 },
  );
  close(pointerUv, { x: placement.x, y: placement.y }, '2D pointer matches authored/3D UV');

  // Model a 2x2 compositor target. readback row 0 is UV v=0 and has a
  // unique red marker. In an editor canvas that marker must remain in its top
  // row, never appear at v=1; this is the exact failure that made 2D and 3D
  // sticker placement disagree.
  const readback = new Uint8ClampedArray([
    255, 0, 0, 17, 0, 255, 0, 18,
    0, 0, 255, 19, 255, 255, 0, 20,
  ]);
  const preview = rows.compositorReadbackToEditorPixels(readback, 2, 2);
  assert.deepEqual([...preview], [
    255, 0, 0, 255, 0, 255, 0, 255,
    0, 0, 255, 255, 255, 255, 0, 255,
  ], 'UV v=0 readback row remains the top editor row and the preview is opaque');
  assert.deepEqual(
    [...rows.compositorReadbackToEditorPixels(readback, 2, 2, false)],
    [...readback],
    'isolated group artwork keeps its deliberate transparent background',
  );
});

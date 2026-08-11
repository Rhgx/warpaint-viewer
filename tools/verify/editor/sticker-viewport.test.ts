// 2D editor navigation contract check.
//
// Zoom and pan are screen-only. A placement point must map back to the exact
// same V-down compositor coordinate regardless of the current viewport.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import * as viewport from '../../../src/editor/stickerViewport';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function close(actual: number, expected: number, message: string): void {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: expected ${expected}, got ${actual}`);
}

test('sticker viewport UV contract', () => {
  const size = { width: 640, height: 400 };
  const uv = { x: 0.3725, y: 0.68125 }; // V is deliberately CSS/compositor down.

  for (const view of [
    { zoom: 1, panX: 0, panY: 0 },
    { zoom: 2.5, panX: -330, panY: -210 },
    { zoom: 0.5, panX: 160, panY: 100 },
  ]) {
    const pixel = viewport.stickerUvPointToViewport(uv, view, size);
    const roundTrip = viewport.stickerViewportPointToUv(pixel, view, size);
    close(roundTrip.x, uv.x, 'viewport round-trip preserves U');
    close(roundTrip.y, uv.y, 'viewport round-trip preserves V-down');
  }

  const before = { zoom: 1.5, panX: -140, panY: -96 };
  const pointer = { x: 332, y: 174 };
  const beforeUv = viewport.stickerViewportPointToUv(pointer, before, size);
  const zoomed = viewport.zoomStickerViewportAt(before, 3, pointer, size);
  const afterUv = viewport.stickerViewportPointToUv(pointer, zoomed, size);
  close(afterUv.x, beforeUv.x, 'pointer-centred zoom preserves U below pan clamp');
  close(afterUv.y, beforeUv.y, 'pointer-centred zoom preserves V below pan clamp');

  const fit = viewport.normalizeStickerViewport({ zoom: 1, panX: 99, panY: -99 }, size);
  assert.deepEqual(fit, { zoom: 1, panX: 0, panY: 0 }, 'fit view is an untransformed UV canvas');

  const editorSource = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'workbench', 'StickerPlacementEditor.tsx'), 'utf8');
  assert.match(editorSource, /if \(event\.button !== 2\) return;/, 'UV panning is reserved for right drag');
  assert.match(editorSource, /onContextMenu=\{\(event\) => event\.preventDefault\(\)\}/, 'right drag suppresses the context menu');
  assert.doesNotMatch(editorSource, /middle drag pans|Middle \/ Space drag/, 'UV guidance does not advertise the old middle-drag pan');
});

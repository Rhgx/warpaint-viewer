// Runs the focused Edit workbench verification suite in a stable order.

import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const verifiers = [
  'editor-provenance.mjs',
  'editor-json-export.mjs',
  'editor-package-export.mjs',
  'group-sampling.mjs',
  'group-targets.mjs',
  'group-names.mjs',
  'editor-history.mjs',
  'layer-colors.mjs',
  'sticker-targets.mjs',
  'sticker-editor-geometry.mjs',
  'sticker-placement.mjs',
  'sticker-uv-alignment.mjs',
  'sticker-viewport.mjs',
  'sticker-surface-preview.mjs',
  'sticker-artwork.mjs',
  'sticker-camera-controls.mjs',
  'uv-wireframe.mjs',
  'sticker-gizmo.mjs',
  'sticker-uv-topology.mjs',
];

for (const verifier of verifiers) {
  const result = spawnSync(process.execPath, [path.join(directory, verifier)], {
    cwd: process.cwd(),
    stdio: 'inherit',
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

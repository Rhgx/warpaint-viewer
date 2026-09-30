// protobufjs requires Node's fs inside a try/catch. The dev prebundle must give
// it an empty module, not Vite's browser-external stub that logs
// 'Module "fs" has been externalized for browser compatibility' on every read.

import assert from 'node:assert/strict';
import { test } from 'vitest';
import config from '../../vite.config';

test('the dev prebundle resolves fs to an empty module', () => {
  const plugins = config.optimizeDeps?.rolldownOptions?.plugins as unknown as
    { resolveId(id: string): string | null; load(id: string): string | null }[];
  const id = plugins.map((plugin) => plugin.resolveId('fs')).find(Boolean);
  assert.ok(id);
  assert.equal(plugins.map((plugin) => plugin.load(id)).find(Boolean), 'module.exports = {};');
});

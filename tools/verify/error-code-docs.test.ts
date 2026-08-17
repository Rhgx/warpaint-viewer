import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { ERROR_CODES } from '../../src/errors';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('every public error code is registered in the documentation', () => {
  const documentation = fs.readFileSync(path.join(ROOT, 'docs', 'error-codes.md'), 'utf8');
  const documented = [...documentation.matchAll(/^\| `((?:WV)-[A-Z]+-\d{4})` \|/gm)]
    .map((match) => match[1])
    .sort();
  const registered = [...Object.values(ERROR_CODES)].sort();
  assert.deepEqual(documented, registered, 'The documented table must exactly match ERROR_CODES.');
});

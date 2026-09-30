// The editor must stop working on a paint once it leaves the catalog, or its
// session and Parts view keep resolving a group texture of a removed kit.

import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { PaintkitEntry } from '../../../src/data/types';
import { resolveEditableKitId } from '../../../src/editor/useEditorCore';

const kit = { id: 7 } as PaintkitEntry;

test('a requested kit is editable while it is in the catalog', () => {
  assert.equal(resolveEditableKitId(7, 7, kit), 7);
});

test('a selected id whose kit left the catalog is not editable', () => {
  assert.equal(resolveEditableKitId(7, 7, null), null);
});

test('an id the editor was not asked to open is not editable', () => {
  assert.equal(resolveEditableKitId(7, 3, kit), null);
  assert.equal(resolveEditableKitId(7, null, kit), null);
  assert.equal(resolveEditableKitId(null, null, null), null);
});

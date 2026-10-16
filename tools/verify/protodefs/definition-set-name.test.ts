import assert from 'node:assert/strict';
import { test } from 'vitest';
import { definitionSetName } from '../../../src/protodefs/templatePaint';

test('a package-loaded set keeps its name once generated paints are added to it', () => {
  const packageFiles = ['paints/paint_a.json', 'paints/paint_a_kit.json'];
  const generated = ['new_paint_9001_operation.json', 'new_paint_9001_definition.json'];
  const name = definitionSetName(packageFiles);

  assert.equal(definitionSetName([...packageFiles, ...generated]), name);
  assert.equal(definitionSetName(generated), 'New war paints');
});

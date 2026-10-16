import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'data', 'operation-templates.json'), 'utf8'));

const STAGE_KINDS = ['texture_lookup', 'combine_add', 'combine_lerp', 'combine_multiply', 'select', 'apply_sticker'];

// Counts apply_sticker stages in a node list, failing on any operation_template reference left in it.
function countStickers(nodes, label) {
  let count = 0;
  for (const node of nodes) {
    assert.ok(!('operation_template' in node), `${label} still references another template`);
    if (node.stage?.apply_sticker) count += 1;
    for (const kind of STAGE_KINDS) {
      const stage = node.stage?.[kind];
      if (stage?.operation_node) count += countStickers(stage.operation_node, label);
    }
  }
  return count;
}

test('every template names its weapon slots with only their model maps', () => {
  for (const template of data.templates) {
    const indexes = Object.values(template.items);
    assert.ok(indexes.length > 0, `template ${template.defindex} has no weapon slots`);
    for (const index of indexes) {
      const slot = data.slots[index];
      assert.ok(slot, `template ${template.defindex} points at missing slot ${index}`);
      assert.ok(Number.isInteger(slot.defindex), `template ${template.defindex} has a non-integer item defindex`);
      assert.ok(slot.data.variable.every((entry) => entry.variable.startsWith('weapon_')));
    }
  }
});

test('every template carries its operation with nested templates inlined', () => {
  for (const template of data.templates) {
    const label = `template ${template.defindex}`;
    assert.ok(template.operationNode.length > 0, `${label} has no operation nodes`);
    assert.equal(countStickers(template.operationNode, label), template.stickers, `${label} sticker count`);
  }
});

test('usage lists are non-empty and sorted, and every template is used', () => {
  for (const [id, kits] of Object.entries(data.usage)) {
    assert.ok(kits.length > 0, `operation ${id} has no paint kits`);
    assert.deepEqual(kits, [...kits].sort((a, b) => a - b), `operation ${id} is not sorted`);
    assert.ok(data.names[id], `operation ${id} has no name`);
  }
  for (const template of data.templates) {
    assert.ok(data.usage[template.defindex], `template ${template.defindex} is missing from usage`);
  }
});

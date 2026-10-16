// Precompute operation template facts into public/data/operation-templates.json:
// which stock paints reach each operation, and what each top-level template is made of.
//
//   npm run update:operation-templates
//
// Decodes the shipped public/data/protodefs-full.bin, so it runs without a TF2 install.
// update:warpaints runs it last, so the file follows every game data refresh. Decoding
// the container in the browser would cost ~10 MB of protobuf work per visit, so the
// browser reads this summary instead.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadRoot, parseContainer, decodeType, DEF_TYPE } from '../lib/proto.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const PUBLIC_DATA = path.join(ROOT, 'public', 'data');

// The snapshot this guard was written against has 20 top-level templates. Far fewer
// means the container layout changed under the decoder, not that the game dropped them.
const MIN_TEMPLATES = 10;

const STAGE_KINDS = ['texture_lookup', 'combine_add', 'combine_lerp', 'combine_multiply', 'select', 'apply_sticker'];

// Yields what a node list reaches, depth first. A `template` event is an operation_template
// reference; its nodes are expanded in place. A `stage` event carries the stage. `ancestors`
// holds the templates on the current path, so a reference cycle stops instead of recursing.
function* walkNodes(nodes, opByIdx, ancestors = new Set()) {
  for (const node of nodes ?? []) {
    if (node.operation_template) {
      const id = node.operation_template.defindex;
      yield { type: 'template', id };
      const template = opByIdx.get(id);
      if (template && !ancestors.has(id)) {
        yield* walkNodes(template.operation_node, opByIdx, new Set([...ancestors, id]));
      }
      continue;
    }
    // stage is a oneof, so exactly one of these is set.
    const kind = STAGE_KINDS.find((name) => node.stage?.[name]);
    if (!kind) continue;
    const body = node.stage[kind];
    yield { type: 'stage', kind, body };
    if (body.operation_node) yield* walkNodes(body.operation_node, opByIdx, ancestors);
  }
}

// The node list with every operation_template reference replaced by that template's nodes,
// recursively, so a paint built on the template authors every stage in its own operation.
// Like walkNodes, a reference back to an enclosing template is dropped instead of recursing.
function expandNodes(nodes, opByIdx, ancestors = new Set()) {
  return (nodes ?? []).flatMap((node) => {
    if (node.operation_template) {
      const id = node.operation_template.defindex;
      if (ancestors.has(id)) return [];
      const template = opByIdx.get(id);
      if (!template) throw new Error(`operation_template ${id} is referenced but was not decoded`);
      return expandNodes(template.operation_node, opByIdx, new Set([...ancestors, id]));
    }
    const kind = STAGE_KINDS.find((name) => node.stage?.[name]);
    if (!kind || !node.stage[kind].operation_node) return [node];
    const body = node.stage[kind];
    return [{ stage: { [kind]: { ...body, operation_node: expandNodes(body.operation_node, opByIdx, ancestors) } } }];
  });
}

// Item slots on a paint kit: the old-style item[] list plus the named weapon fields.
// Matching on the item_definition_template key keeps this in step with the schema
// without repeating its field list.
function itemDefindexes(kit) {
  return Object.values(kit)
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .filter((slot) => slot?.item_definition_template)
    .map((slot) => slot.item_definition_template.defindex);
}

// Named weapon slots on a paint kit (scattergun, knife, ...), keyed by field name. The repeated
// `item` list is left out because the JSON importer only reads named slots. A slot keeps its
// item definition and the weapon's own model maps: the template's weapon_* values are placeholders
// that every slot overrides. Everything else on a slot belongs to one paint (sticker placement,
// select values, material overrides), so it is dropped.
function weaponSlots(kit) {
  return Object.fromEntries(Object.entries(kit).flatMap(([field, slot]) => {
    if (!slot?.item_definition_template) return [];
    const variable = (slot.data?.variable ?? []).filter((entry) => entry.variable.startsWith('weapon_'));
    return [[field, { defindex: slot.item_definition_template.defindex, data: { variable } }]];
  }));
}

// Weapon slots repeat across templates (every stock paint names the same ones), so the file keeps
// each distinct slot once in a shared table and a template's items map field -> table index.
function describeTemplate(op, opByIdx, representative, slotIndex) {
  const stages = [...walkNodes(op.operation_node, opByIdx)].filter((event) => event.type === 'stage');
  const variables = op.header.variables ?? [];

  const stickers = stages.filter((event) => event.kind === 'apply_sticker');
  return {
    defindex: op.header.defindex,
    name: op.header.name,
    // The weapons one stock paint using this template supports, so a paint built on it can
    // name the same item definitions.
    items: Object.fromEntries(Object.entries(weaponSlots(representative)).map(([field, slot]) => [field, slotIndex(slot)])),
    operationNode: expandNodes(op.operation_node, opByIdx, new Set([op.header.defindex])),
    variables: variables.map((variable) => ({
      name: variable.name,
      value: variable.value,
      // inherit defaults to true in the schema, so only an explicit value is kept.
      ...(variable.inherit !== undefined ? { inherit: variable.inherit } : {}),
    })),
    textureLayers: new Set(variables.map((v) => v.name).filter((name) => /^texture_layer_\d+$/.test(name))).size,
    stickers: stickers.length,
    stickerVariants: Math.max(0, ...stickers.map((event) => (event.body.sticker ?? []).length)),
    innerWear: variables.some((v) => /^inner_layer_\d/.test(v.name)),
    teamTextures: op.header.name.includes('team_color')
      || stages.some((event) => event.kind === 'texture_lookup' && (event.body.texture_red || event.body.texture_blue)),
  };
}

function main() {
  const root = loadRoot();
  const { byType } = parseContainer(path.join(PUBLIC_DATA, 'protodefs-full.bin'));
  const defs = decodeType(root, byType, DEF_TYPE.PAINTKIT_DEFINITION);
  const itemDefs = decodeType(root, byType, DEF_TYPE.PAINTKIT_ITEM_DEFINITION);
  const ops = decodeType(root, byType, DEF_TYPE.PAINTKIT_OPERATION);

  const manifest = JSON.parse(fs.readFileSync(path.join(PUBLIC_DATA, 'manifest.json'), 'utf8'));
  const known = new Set(manifest.paintkits.map((kit) => kit.id));
  const opByIdx = new Map(ops.map((op) => [op.header.defindex, op]));
  const itemByIdx = new Map(itemDefs.map((item) => [item.header.defindex, item]));

  const usage = new Map(); // operation defindex -> paint kit ids
  const topLevel = new Set(); // operations used as a stock paint kit's own operation_template
  const representatives = new Map(); // top-level operation defindex -> lowest-id paint kit using it
  for (const kit of defs) {
    const kitId = kit.header.defindex;
    if (!known.has(kitId)) continue;

    // The kit's own operation, then every per-wear override on each of its item definitions.
    const starts = [];
    if (kit.operation_template) {
      starts.push(kit.operation_template.defindex);
      topLevel.add(kit.operation_template.defindex);
      const templateId = kit.operation_template.defindex;
      const current = representatives.get(templateId);
      if (Object.keys(weaponSlots(kit)).length > 0 && (!current || kitId < current.header.defindex)) {
        representatives.set(templateId, kit);
      }
    }
    for (const defindex of itemDefindexes(kit)) {
      const item = itemByIdx.get(defindex);
      if (!item) throw new Error(`paint kit ${kitId} references missing item definition ${defindex}`);
      for (const perWear of item.definition ?? []) {
        if (perWear.operation_template) starts.push(perWear.operation_template.defindex);
      }
    }

    const reached = new Set();
    for (const id of starts) {
      const op = opByIdx.get(id);
      if (!op) throw new Error(`paint kit ${kitId} references missing operation ${id}`);
      reached.add(id);
      for (const event of walkNodes(op.operation_node, opByIdx)) {
        if (event.type === 'template') reached.add(event.id);
      }
    }
    for (const id of reached) {
      if (!usage.has(id)) usage.set(id, new Set());
      usage.get(id).add(kitId);
    }
  }

  const slots = [];
  const slotPositions = new Map(); // serialized slot -> index in slots
  const slotIndex = (slot) => {
    const key = JSON.stringify(slot);
    if (!slotPositions.has(key)) {
      slotPositions.set(key, slots.length);
      slots.push(slot);
    }
    return slotPositions.get(key);
  };
  const templates = [...topLevel]
    .sort((a, b) => a - b)
    .map((id) => {
      const representative = representatives.get(id);
      if (!representative) throw new Error(`no stock paint with weapon slots uses template ${id}`);
      return describeTemplate(opByIdx.get(id), opByIdx, representative, slotIndex);
    });
  if (templates.length < MIN_TEMPLATES) {
    throw new Error(`only ${templates.length} templates found (expected at least ${MIN_TEMPLATES})`);
  }

  const usageOut = {};
  const names = {}; // operation defindex -> header name, so a nested template reads as more than its id
  for (const id of [...usage.keys()].sort((a, b) => a - b)) {
    usageOut[id] = [...usage.get(id)].sort((a, b) => a - b);
    const name = opByIdx.get(id)?.header.name;
    if (name) names[id] = name;
  }

  const out = { usage: usageOut, names, slots, templates };
  fs.writeFileSync(path.join(PUBLIC_DATA, 'operation-templates.json'), `${JSON.stringify(out)}\n`);
  console.log(`[operation-templates] wrote ${templates.length} templates, ${slots.length} weapon slots, ${usage.size} operations in usage`);
}

try {
  main();
} catch (err) {
  console.error(`[operation-templates] ${err.message}`);
  process.exit(1);
}

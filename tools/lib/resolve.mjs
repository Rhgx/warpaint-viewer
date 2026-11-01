// Port of CPaintKitDefinition::GetItemPaintKitDefinitionKV (econ_paintkit.cpp). For each
// (paintkit, weapon slot, wear, team) it builds a compositor stage tree with variables substituted.

// Named weapon slot fields on CMsgPaintKit_Definition (the repeated item[] is handled separately).
export const WEAPON_SLOTS = [
  'paintkit_tool', 'flamethrower', 'grenadelauncher', 'knife', 'medigun', 'minigun', 'pistol', 'revolver',
  'rocketlauncher', 'scattergun', 'shotgun', 'smg', 'sniperrifle', 'stickybomb_launcher',
  'ubersaw', 'wrench', 'amputator', 'atom_launcher', 'back_scratcher', 'battleaxe',
  'bazaar_sniper', 'blackbox', 'claidheamohmor', 'crusaders_crossbow', 'degreaser',
  'demo_cannon', 'demo_sultan_sword', 'detonator', 'gatling_gun', 'holymackerel', 'jag',
  'lochnload', 'powerjack', 'quadball', 'reserve_shooter', 'riding_crop', 'russian_riot',
  'scimitar', 'scorch_shot', 'shortstop', 'soda_popper', 'tele_shotgun', 'tomislav',
  'trenchgun', 'winger_pistol',
];

export function buildIndex(operations, itemDefs) {
  const opByIdx = new Map();
  for (const o of operations) opByIdx.set(o.header.defindex, o);
  const itemDefByIdx = new Map();
  for (const it of itemDefs) itemDefByIdx.set(it.header.defindex, it);
  return { opByIdx, itemDefByIdx };
}

function toNums(str) {
  if (str == null) return [];
  return String(str).trim().split(/\s+/).filter((s) => s.length).map(Number);
}

function parseRange(str, dflt) {
  const n = toNums(str);
  if (n.length === 0) return dflt ? dflt.slice() : null;
  if (n.length === 1) return [n[0], n[0]];
  return [n[0], n[1]];
}

function parseRangeDiv255(str, dflt) {
  const r = parseRange(str, null);
  if (!r) return dflt.slice();
  return [r[0] / 255, r[1] / 255];
}

function parseInverseRange(str, dflt) {
  const r = parseRange(str, null);
  if (!r) return dflt.slice();
  const inv = (v) => (v === 0 ? 0 : 1 / v);
  return [inv(r[0]), inv(r[1])];
}

function parseVec2(str, dflt) {
  const n = toNums(str);
  if (n.length >= 2) return [n[0], n[1]];
  if (n.length === 1) return [n[0], n[0]];
  return dflt.slice();
}

// Compositor texture ref (no materials/ prefix or extension) -> recipe path textures/<path>.webp.
export function texturePublicPath(ref) {
  if (!ref) return null;
  let p = String(ref).trim().replace(/\\/g, '/');
  p = p.replace(/^materials\//i, '');
  // Some workshop refs carry a stray source-image extension (e.g. foo.tga); strip any of them.
  p = p.replace(/\.(vtf|tga|psd|png|webp)$/i, '');
  return `textures/${p}.webp`;
}

// A CMsgVarField is a variable reference with a baked default, or a literal oneof value.
function varFieldValue(field, dict) {
  if (field == null) return undefined;
  if (field.variable !== undefined && field.variable !== '') {
    const entry = dict.get(field.variable);
    if (entry !== undefined) return entry.value;
    // fall back to the field's own baked default value
  }
  if (field.string !== undefined) return field.string;
  for (const k of ['float', 'double', 'uint32', 'uint64', 'sint32', 'sint64', 'bool']) {
    if (field[k] !== undefined) return String(field[k]);
  }
  return undefined;
}

function buildVarDict(baseHeaderVars) {
  const dict = new Map();
  for (const v of baseHeaderVars || []) {
    dict.set(v.name, { value: v.value != null ? v.value : '', canOverride: v.inherit !== false });
  }
  return dict;
}

// Apply CMsgVarField overrides (variable=name, value in oneof) - only updates existing keys.
function applyVarFieldOverrides(dict, varFields) {
  for (const vf of varFields || []) {
    const name = vf.variable;
    if (name == null) continue;
    const entry = dict.get(name);
    if (!entry || !entry.canOverride) continue;
    let val;
    if (vf.string !== undefined) val = vf.string;
    else {
      for (const k of ['float', 'double', 'uint32', 'uint64', 'sint32', 'sint64', 'bool']) {
        if (vf[k] !== undefined) { val = String(vf[k]); break; }
      }
    }
    if (val === undefined) continue;
    if (entry.value !== val) entry.value = val;
  }
}

// Apply CMsgVariableDefinition overrides (name/value) - only updates existing keys.
function applyVarDefOverrides(dict, varDefs) {
  for (const vd of varDefs || []) {
    const entry = dict.get(vd.name);
    if (!entry || !entry.canOverride) continue;
    const val = vd.value != null ? vd.value : '';
    if (entry.value !== val) entry.value = val;
  }
}

const DEFAULTS = {
  adjustBlack: [0, 0],
  adjustOffset: [1, 1],
  adjustGamma: [1, 1],
  rotation: [0, 0],
  translateU: [0, 0],
  translateV: [0, 0],
  scaleUV: [1, 1],
};

function resolveTextureRef(stage, dict, team) {
  // team texture selection: red uses texture_red||texture, blu uses texture_blue||texture
  let chosen;
  if (team === 'blu') chosen = stage.texture_blue || stage.texture;
  else chosen = stage.texture_red || stage.texture;
  const val = varFieldValue(chosen, dict);
  return texturePublicPath(val);
}

function commonTransforms(stage, dict) {
  const out = {};
  const flipRange = (field) => {
    const range = parseRange(varFieldValue(field, dict), [0, 0]);
    return range.every(Number.isFinite) ? range : [0, 0];
  };
  out.adjustBlack = parseRangeDiv255(varFieldValue(stage.adjust_black, dict), DEFAULTS.adjustBlack);
  out.adjustOffset = parseRangeDiv255(varFieldValue(stage.adjust_offset, dict), DEFAULTS.adjustOffset);
  out.adjustGamma = parseInverseRange(varFieldValue(stage.adjust_gamma, dict), DEFAULTS.adjustGamma);
  out.rotation = parseRange(varFieldValue(stage.rotation, dict), DEFAULTS.rotation);
  out.translateU = parseRange(varFieldValue(stage.translate_u, dict), DEFAULTS.translateU);
  out.translateV = parseRange(varFieldValue(stage.translate_v, dict), DEFAULTS.translateV);
  out.scaleUV = parseRange(varFieldValue(stage.scale_uv, dict), DEFAULTS.scaleUV);
  out.flipU = flipRange(stage.flip_u);
  out.flipV = flipRange(stage.flip_v);
  return out;
}

// Resolve an array of operation_node into resolved child nodes (inlining operation_template refs).
function resolveNodes(nodeList, ctx, dict, team, textureRefs) {
  const out = [];
  for (const node of nodeList || []) {
    if (node.operation_template) {
      const ref = ctx.opByIdx.get(node.operation_template.defindex);
      if (ref) {
        const inlined = resolveNodes(ref.operation_node, ctx, dict, team, textureRefs);
        if (inlined.length === 1) out.push(inlined[0]);
        else out.push({ type: 'combine_multiply', rootCopy: true, nodes: inlined });
      }
      continue;
    }
    if (node.stage) {
      const resolved = resolveStage(node.stage, ctx, dict, team, textureRefs);
      if (resolved) out.push(resolved);
    }
  }
  return out;
}

function resolveStage(stage, ctx, dict, team, textureRefs) {
  const key = Object.keys(stage).find((k) => stage[k] != null);
  if (!key) return null;
  const s = stage[key];

  if (key === 'texture_lookup') {
    const tex = resolveTextureRef(s, dict, team);
    if (tex) textureRefs.add(tex);
    return { type: 'texture_lookup', texture: tex, ...commonTransforms(s, dict) };
  }

  if (key === 'combine_multiply' || key === 'combine_add' || key === 'combine_lerp') {
    const node = { type: key, ...commonTransforms(s, dict), nodes: resolveNodes(s.operation_node, ctx, dict, team, textureRefs) };
    return node;
  }

  if (key === 'select') {
    const groupsVal = varFieldValue(s.groups, dict);
    const groups = texturePublicPath(groupsVal);
    if (groups) textureRefs.add(groups);
    const select = [];
    for (const sel of s.select || []) {
      const v = varFieldValue(sel, dict);
      const num = Number(v);
      select.push(Number.isFinite(num) ? num : v);
    }
    return { type: 'select', groups, select };
  }

  if (key === 'apply_sticker') {
    const stickers = [];
    for (const st of s.sticker || []) {
      const base = texturePublicPath(varFieldValue(st.base, dict));
      if (base) textureRefs.add(base);
      const rawWeight = varFieldValue(st.weight, dict);
      const weight = rawWeight === undefined || rawWeight.trim() === '' ? 1 : Number(rawWeight);
      const entry = { base, weight: Number.isFinite(weight) ? weight : 1 };
      const specVal = varFieldValue(st.spec, dict);
      if (specVal) { entry.spec = texturePublicPath(specVal); if (entry.spec) textureRefs.add(entry.spec); }
      stickers.push(entry);
    }
    return {
      type: 'apply_sticker',
      stickers,
      destTl: parseVec2(varFieldValue(s.dest_tl, dict), [0, 0]),
      destTr: parseVec2(varFieldValue(s.dest_tr, dict), [0, 0]),
      destBl: parseVec2(varFieldValue(s.dest_bl, dict), [0, 0]),
      adjustBlack: parseRangeDiv255(varFieldValue(s.adjust_black, dict), DEFAULTS.adjustBlack),
      adjustOffset: parseRangeDiv255(varFieldValue(s.adjust_offset, dict), DEFAULTS.adjustOffset),
      adjustGamma: parseInverseRange(varFieldValue(s.adjust_gamma, dict), DEFAULTS.adjustGamma),
      nodes: resolveNodes(s.operation_node, ctx, dict, team, textureRefs),
    };
  }

  return null;
}

// Resolve one (paintkit, slot, item def, wear, team) to { tree, textureRefs }, or null if no operation applies.
export function resolveRecipe(paintkitDef, slotItem, itemDef, wearIdx, team, ctx) {
  // Operation and base variables; a per-wear template overrides both.
  let operationMsg = null;
  let baseHeaderVars = paintkitDef.header.variables;
  if (paintkitDef.operation_template) {
    operationMsg = ctx.opByIdx.get(paintkitDef.operation_template.defindex) || null;
  }
  const defs = itemDef.definition || [];
  const clampedIdx = Math.max(0, Math.min(wearIdx, defs.length - 1));
  const perWearDef = defs[clampedIdx];
  if (perWearDef && perWearDef.operation_template) {
    const override = ctx.opByIdx.get(perWearDef.operation_template.defindex);
    if (override) {
      operationMsg = override;
      baseHeaderVars = override.header.variables;
    }
  }
  if (!operationMsg) return null;

  const dict = buildVarDict(baseHeaderVars);
  // Override order matches the SDK: item slot data vars, then item def header vars, then per-wear def vars.
  applyVarFieldOverrides(dict, slotItem.data && slotItem.data.variable);
  applyVarDefOverrides(dict, itemDef.header && itemDef.header.variables);
  if (perWearDef) applyVarFieldOverrides(dict, perWearDef.variable);

  const textureRefs = new Set();
  const nodes = resolveNodes(operationMsg.operation_node, ctx, dict, team, textureRefs);
  // One root node is used directly; several are wrapped in a passthrough combine.
  let tree;
  if (nodes.length === 1) tree = nodes[0];
  else tree = { type: 'combine_multiply', rootCopy: true, nodes };
  return { tree, textureRefs };
}

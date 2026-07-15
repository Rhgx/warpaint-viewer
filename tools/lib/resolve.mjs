// Port of CPaintKitDefinition::GetItemPaintKitDefinitionKV (econ_paintkit.cpp) to JS.
// Produces, for each (paintkit definition, supported weapon slot, wear level, team), a fully
// resolved compositor operation-stage tree with all variables substituted.

// The 15 stock + repeated `item` + workshop weapon slot field names on CMsgPaintKit_Definition.
export const WEAPON_SLOTS = [
  'flamethrower', 'grenadelauncher', 'knife', 'medigun', 'minigun', 'pistol', 'revolver',
  'rocketlauncher', 'scattergun', 'shotgun', 'smg', 'sniperrifle', 'stickybomb_launcher',
  'ubersaw', 'wrench', 'amputator', 'atom_launcher', 'back_scratcher', 'battleaxe',
  'bazaar_sniper', 'blackbox', 'claidheamohmor', 'crusaders_crossbow', 'degreaser',
  'demo_cannon', 'demo_sultan_sword', 'detonator', 'gatling_gun', 'holymackerel', 'jag',
  'lochnload', 'powerjack', 'quadball', 'reserve_shooter', 'riding_crop', 'russian_riot',
  'scimitar', 'scorch_shot', 'shortstop', 'soda_popper', 'tele_shotgun', 'tomislav',
  'trenchgun', 'winger_pistol',
];

// Build indexes for fast reference resolution.
export function buildIndex(operations, itemDefs, variables) {
  const opByIdx = new Map();
  for (const o of operations) opByIdx.set(o.header.defindex, o);
  const itemDefByIdx = new Map();
  for (const it of itemDefs) itemDefByIdx.set(it.header.defindex, it);
  const varByIdx = new Map();
  for (const v of variables) varByIdx.set(v.header.defindex, v);
  return { opByIdx, itemDefByIdx, varByIdx };
}

// ---- value parsing helpers (mirror the KV->compositor parse functions named in the proto) ----

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

function parseBool(str) {
  if (str == null) return false;
  const s = String(str).trim().toLowerCase();
  return s === '1' || s === 'true';
}

// Convert a raw compositor texture reference (no "materials/" prefix, no ".vtf") into the
// public recipe path "textures/<path>.png".
export function texturePublicPath(ref) {
  if (!ref) return null;
  let p = String(ref).trim().replace(/\\/g, '/');
  p = p.replace(/^materials\//i, '');
  // Some workshop refs carry a stray source-image extension (e.g. foo.tga); strip any of them.
  p = p.replace(/\.(vtf|tga|psd|png)$/i, '');
  return `textures/${p}.png`;
}

// Convert a raw compositor texture reference into the vpk-relative path "materials/<path>.vtf".
export function textureVpkPath(ref) {
  if (!ref) return null;
  let p = String(ref).trim().replace(/\\/g, '/');
  p = p.replace(/^materials\//i, '');
  p = p.replace(/\.(vtf|tga|psd|png)$/i, '');
  return `materials/${p}.vtf`;
}

// ---- variable dictionary construction ----

// A CMsgVarField holds either a `variable` reference (name) plus optional baked default value,
// or a literal value in one of the oneof fields. Resolve to a string using the var dict.
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

// ---- operation tree -> resolved recipe node tree ----

const DEFAULTS = {
  adjustBlack: [0, 0],
  adjustOffset: [1, 1],
  adjustGamma: [1, 1],
  rotation: [0, 0],
  translateU: [0, 0],
  translateV: [0, 0],
  scaleUV: [1, 1],
};

function resolveTextureRef(stage, dict, team, field) {
  // team texture selection: red uses texture_red||texture, blu uses texture_blue||texture
  let chosen;
  if (team === 'blu') chosen = stage.texture_blue || stage[field] || stage.texture;
  else chosen = stage.texture_red || stage[field] || stage.texture;
  const val = varFieldValue(chosen, dict);
  return texturePublicPath(val);
}

function commonTransforms(stage, dict) {
  const out = {};
  out.adjustBlack = parseRangeDiv255(varFieldValue(stage.adjust_black, dict), DEFAULTS.adjustBlack);
  out.adjustOffset = parseRangeDiv255(varFieldValue(stage.adjust_offset, dict), DEFAULTS.adjustOffset);
  out.adjustGamma = parseInverseRange(varFieldValue(stage.adjust_gamma, dict), DEFAULTS.adjustGamma);
  out.rotation = parseRange(varFieldValue(stage.rotation, dict), DEFAULTS.rotation);
  out.translateU = parseRange(varFieldValue(stage.translate_u, dict), DEFAULTS.translateU);
  out.translateV = parseRange(varFieldValue(stage.translate_v, dict), DEFAULTS.translateV);
  out.scaleUV = parseRange(varFieldValue(stage.scale_uv, dict), DEFAULTS.scaleUV);
  out.flipU = parseBool(varFieldValue(stage.flip_u, dict));
  out.flipV = parseBool(varFieldValue(stage.flip_v, dict));
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
        for (const c of inlined) out.push(c);
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
    const tex = resolveTextureRef(s, dict, team, 'texture');
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
      const entry = { base, weight: Number(varFieldValue(st.weight, dict)) || 1 };
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

// Resolve one (paintkitDef, slotItem, itemDef, wearIdx, team) into a recipe tree.
// Returns { tree, textureRefs:Set } or null if it cannot resolve.
export function resolveRecipe(paintkitDef, slotItem, itemDef, wearIdx, team, ctx) {
  // Determine operation message + base variable header (per GetItemPaintKitDefinitionKV).
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
  // The operation root is an implicit list of nodes; a paintkit operation is a single tree,
  // so if there is exactly one root node use it directly, else wrap in a passthrough combine.
  let tree;
  if (nodes.length === 1) tree = nodes[0];
  else tree = { type: 'combine_multiply', ...DEFAULTS, flipU: false, flipV: false, nodes };
  return { tree, textureRefs };
}

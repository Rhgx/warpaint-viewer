// Shared logic for turning an unusual-effect PCF systems map (as parsed from
// weapon_unusual_hot.pcf etc., see extractUnusuals() in extract-effects.mjs) into
// pre-resolved per-(effect, weapon) bundles: { root: "<systemName>", systems: {
// "<name>": <systemDef>, ... } }, where systems holds the root plus its transitive
// children copied verbatim.
//
// Used by both tools/repack-unusuals.mjs (one-shot migration of the legacy
// monolithic unusuals.json) and tools/extract-effects.mjs (which emits the
// bundles directly from freshly-parsed PCF data), so the selection/closure logic
// exists exactly once.

// Maps a viewer effect id to the .pcf's top-level key in the old unusuals.json /
// extractUnusuals()'s `unusuals` object (both keyed by pcf basename).
export const EFFECT_PCF_KEY = {
  hot: 'weapon_unusual_hot',
  isotope: 'weapon_unusual_isotope',
  cool: 'weapon_unusual_cool',
  energy_orb: 'weapon_unusual_energyorb',
};

// System selection: the game (items_game use_suffix_name) spawns the system named
// weapon_unusual_<effect>_<weapon> directly, not the authoring _unusual_parent_*
// container (which holds BOTH the world-model subtree and the _vm viewmodel
// subtree, and would render doubled if instantiated whole). Ported verbatim from
// the runtime heuristic formerly in src/viewer/particles/index.ts's
// selectSystemName(), which called console.warn on the fallback path; here the
// fallback is reported back to the caller instead so it can be logged/summarized
// once per migration run rather than once per instance.
export function selectSystemName(systems, effectId, weaponKey) {
  const base = `weapon_unusual_${effectId === 'energy_orb' ? 'energyorb' : effectId}`;
  const weapon = weaponKey.replace(/^c_/, '');
  const worldName = `${base}_${weapon}`;
  if (systems[worldName]) return { name: worldName, fallback: false };
  const vmName = `${worldName}_vm`;
  if (systems[vmName]) return { name: vmName, fallback: false };
  const prefix = `${base}_`;
  const candidates = Object.keys(systems).filter((k) => k.startsWith(prefix));
  if (!candidates.length) return { name: null, fallback: false };
  const nonVm = candidates.filter((k) => !k.endsWith('_vm'));
  const pool = (nonVm.length ? nonVm : candidates).slice().sort();
  return { name: pool[0], fallback: true };
}

// Walks sysDef.children recursively from `rootName`, collecting every reachable
// system (root included), copied verbatim from `systems`. Mirrors build() in the
// old src/viewer/particles/index.ts: a child name with no entry in `systems` is
// skipped (not an error) since the runtime treated an unresolvable child the same
// way; onMissingChild, if given, is called once per such reference so callers can
// log it. Cycles (a child eventually referencing an ancestor) terminate safely
// because a name already present in the output is never revisited.
export function transitiveClosure(systems, rootName, onMissingChild) {
  const out = {};
  const visit = (name) => {
    if (Object.prototype.hasOwnProperty.call(out, name)) return;
    const def = systems[name];
    if (!def) {
      if (onMissingChild) onMissingChild(name);
      return;
    }
    out[name] = def;
    for (const childName of def.children) visit(childName);
  };
  visit(rootName);
  return out;
}

// Builds every (effectId, weaponKey) bundle for one effect's systems map. Returns
// an array of { effectId, weaponKey, root, systems, fallback } entries; callers
// decide how to serialize/write them and how to report `fallback`/missing
// children (via the same onMissingChild hook threaded through to
// transitiveClosure).
export function buildBundlesForEffect(systems, effectId, weaponKeys, onMissingChild) {
  const out = [];
  for (const weaponKey of weaponKeys) {
    const selected = selectSystemName(systems, effectId, weaponKey);
    if (!selected.name) {
      throw new Error(`no candidate system for ${effectId}/${weaponKey} in the "${effectId}" prefix - the fallback pool was empty, which should be impossible`);
    }
    const closureSystems = transitiveClosure(systems, selected.name, (missingName) => {
      if (onMissingChild) onMissingChild(effectId, weaponKey, selected.name, missingName);
    });
    out.push({ effectId, weaponKey, root: selected.name, systems: closureSystems, fallback: selected.fallback });
  }
  return out;
}

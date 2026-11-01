// Turns an unusual-effect PCF systems map (from extractUnusuals() in tools/extract/effects.mjs)
// into pre-resolved per-(effect, weapon) bundles: { root, systems }, where systems holds the root
// and its transitive children, copied verbatim.

// Viewer effect id -> PCF basename key in extractUnusuals()'s output.
export const EFFECT_PCF_KEY = {
  hot: 'weapon_unusual_hot',
  isotope: 'weapon_unusual_isotope',
  cool: 'weapon_unusual_cool',
  energy_orb: 'weapon_unusual_energyorb',
  sparkle: 'item_fx',
};

// Pick weapon_unusual_<effect>_<weapon> (or its _vm variant), not the _unusual_parent_* container:
// the container holds both world and viewmodel subtrees, so instancing it whole renders doubled.
// A fallback to the first matching name is reported via `fallback`.
function selectSystemName(systems, effectId, weaponKey) {
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

// Collect rootName and every system reachable through children, copied verbatim. Unknown children
// are skipped and reported via onMissingChild. Cycles stop because each name is visited once.
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

// One { effectId, weaponKey, root, systems, fallback } entry per weapon. onMissingChild is passed
// through to transitiveClosure.
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

// Recipe tree compaction and per-kit bundling.
//
// The runtime reads an absent transform field as its default and draws the same RNG values, so
// default-valued fields are dropped. A bundle is { trees, variants }: variants maps
// "<weaponKey>_<team>[_w<n>]" to an index into trees, and identical trees share one entry.

const DEFAULTS = {
  adjustBlack: [0, 0],
  adjustOffset: [1, 1],
  adjustGamma: [1, 1],
  rotation: [0, 0],
  translateU: [0, 0],
  translateV: [0, 0],
  scaleUV: [1, 1],
  flipU: [0, 0],
  flipV: [0, 0],
};

function deepEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

// Deep copy that drops default-valued transform fields (see DEFAULTS) at every depth.
function compactNode(value) {
  if (Array.isArray(value)) return value.map(compactNode);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (Object.prototype.hasOwnProperty.call(DEFAULTS, k) && deepEqual(v, DEFAULTS[k])) continue;
      out[k] = compactNode(v);
    }
    return out;
  }
  return value;
}

// Compact each tree, then deduplicate by its JSON.
export function buildBundle(entries) {
  const trees = [];
  const variants = {};
  const seen = new Map();
  for (const { key, tree } of entries) {
    const compacted = compactNode(tree);
    const sig = JSON.stringify(compacted);
    let idx = seen.get(sig);
    if (idx === undefined) {
      idx = trees.length;
      trees.push(compacted);
      seen.set(sig, idx);
    }
    variants[key] = idx;
  }
  return { trees, variants };
}

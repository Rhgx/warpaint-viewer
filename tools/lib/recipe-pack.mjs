// Recipe tree compaction and per-kit bundling.
//
// A recipe tree carries 9 transform fields (adjustBlack/adjustOffset/adjustGamma/
// rotation/translateU/translateV/scaleUV/flipU/flipV) on texture_lookup, combine_*
// and apply_sticker nodes. src/compositor/resolve.ts + rng.ts resolveRange() treat
// an absent field exactly like its default value (a degenerate [d,d] range still
// consumes one RNG draw; absent flipU skips the draw exactly like false), so
// dropping default-valued fields is runtime-safe and shrinks the data considerably.
//
// A bundle groups every variant of one paintkit into one file:
//   { trees: [<node>, ...], variants: { "<weaponKey>_<team>[_w<n>]": <index into trees> } }
// Identical compacted trees (same canonical JSON) share one `trees` entry.

const DEFAULTS = {
  adjustBlack: [0, 0],
  adjustOffset: [1, 1],
  adjustGamma: [1, 1],
  rotation: [0, 0],
  translateU: [0, 0],
  translateV: [0, 0],
  scaleUV: [1, 1],
  flipU: false,
  flipV: false,
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

// Deep-copies `value`, dropping any of the 9 default-valued transform fields
// (see DEFAULTS) from plain objects encountered anywhere in the tree, including
// nested `nodes` arrays and every node type. Every other field passes through
// byte-for-byte unmodified.
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

// Builds a { trees, variants } bundle from a flat list of { key, tree } entries
// (one per old per-variant filename, key = filename without ".json"). Trees are
// compacted first, then deduplicated by JSON.stringify of the compacted form.
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

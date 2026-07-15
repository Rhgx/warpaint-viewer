// Seeded PRNG for the paintkit compositor.
//
// FIDELITY NOTE
// -------------
// TF2's real texture compositor (ctexturecompositor.cpp) is NOT shipped in the
// Source SDK 2013 drop, and the exact per-range RNG it uses to resolve each
// [min,max] in an operation tree is not conclusively documented anywhere in the
// community (searches for "TF2 paintkit seed compositor" / "texture compositor
// random" turn up how seeds are stored on items, but not the draw order or the
// generator). So we approximate it:
//
//   * generator  : mulberry32, seeded from the item's uint32 seed
//   * draw order : depth-first PRE-ORDER traversal of the stage tree; within a
//                  texture_lookup stage the ranges are consumed in a fixed field
//                  order (see resolve.ts). This is deterministic, so a given
//                  (recipe, seed) always yields the same texture, which is the
//                  property the UI actually needs. It will NOT be bit-identical
//                  to what the game rolls for the same seed.
//
// If the real generator is ever recovered, only this file and resolve.ts need to
// change; the GL evaluation stays the same.

export type Rng = () => number;

// mulberry32: tiny, fast, well distributed 32-bit PRNG.
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Resolve a [min,max] range to a concrete value. A range where min===max (the
// common case for defaulted fields) still consumes one draw so that adding or
// removing a defaulted field does not shift every later draw.
export function resolveRange(rng: Rng, range: [number, number] | undefined, fallback: number): number {
  if (!range) {
    rng();
    return fallback;
  }
  const [min, max] = range;
  const r = rng();
  return min + r * (max - min);
}

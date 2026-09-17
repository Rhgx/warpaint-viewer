// Recipe stage-tree node shapes, matching the FINAL pipeline contract
// (DESIGN.md "Data contract" + "Pipeline schema amendments") and the
// CMsgPaintKit_Operation_*Stage protos.
//
// Notes on values (pre-transformed by the pipeline, do NOT re-transform):
//   - adjustBlack / adjustOffset are already divided by 255 (0..1 shader space).
//   - adjustGamma is already inverted (1/x).
//   - flipU / flipV retain the parsed integer range. Fixed ranges do not draw.
//   - select values are raw 0..255 group ids; the shader compares them with the
//     fxc's 1/16 bucketing (cFac in compositor.cpp).

type Range = [number, number];

// Transform + adjust fields carried by texture_lookup and combine messages.
// Source parses combine UV fields but ignores them during resolution.
export interface StageTransform {
  adjustBlack?: Range;
  adjustOffset?: Range; // offset added to the sampled black point to get white
  adjustGamma?: Range;
  rotation?: Range; // degrees
  translateU?: Range;
  translateV?: Range;
  scaleUV?: Range;
  flipU?: Range | boolean;
  flipV?: Range | boolean;
}

interface TextureLookupNode extends StageTransform {
  type: 'texture_lookup';
  // Path relative to public/data (real data) or a mock key / data: URL (mock).
  texture: string;
}

// Combine stages are n-ary in real data (the engine batches 4 inputs per pass
// and chains passes for more). Their level fields apply when the output is
// sampled by the parent, while their UV fields have no effect.
export interface CombineNode extends StageTransform {
  type: 'combine_multiply' | 'combine_add' | 'combine_lerp';
  nodes: RecipeNode[]; // multiply/add: 2+, lerp: exactly 3 (c0, c1, selector)
  /** Synthetic CTCCopyStage used for an operation with multiple root nodes. */
  rootCopy?: boolean;
}

// Select is a LEAF: it samples the groups texture directly and emits a 0/1 mask.
export interface SelectNode {
  type: 'select';
  groups: string; // grayscale region-id texture
  // Raw group ids (0..255); 0 entries are unused slots. A small number of real
  // recipe files carry string values with trailing junk (e.g. "96```") straight
  // from the source KV data; the game atoi()s them, and resolve.ts does the same.
  select: Array<number | string>;
}

interface StickerDef {
  base: string;
  weight?: number;
  spec?: string;
}

export interface ApplyStickerNode {
  type: 'apply_sticker';
  stickers: StickerDef[];
  destTl?: [number, number];
  destTr?: [number, number];
  destBl?: [number, number];
  adjustBlack?: Range;
  adjustOffset?: Range;
  adjustGamma?: Range;
  nodes: RecipeNode[]; // exactly 1 child: the surface the sticker lands on
}

export type RecipeNode = TextureLookupNode | CombineNode | SelectNode | ApplyStickerNode;

// Resolves a texture path/ref to a URL the browser can load.
export type TextureResolver = (ref: string) => string | Promise<string>;
export type PaintSeed = string;

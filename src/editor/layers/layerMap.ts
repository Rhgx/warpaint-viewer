import type { RgbaImageDataLike } from './groupSampling';

/** Restrained categorical tints shared by the editor UI and Viewer overlay. */
export const EDITOR_LAYER_MAP_COLORS = [
  [0.35, 0.58, 0.92],
  [0.77, 0.47, 0.78],
  [0.36, 0.72, 0.57],
  [0.88, 0.63, 0.31],
  [0.85, 0.39, 0.49],
  [0.31, 0.69, 0.73],
] as const satisfies readonly (readonly [number, number, number])[];

type Rgb = readonly [number, number, number];

/** Separated categorical set for texture-aware cues. Missing textures use the indexed fallback above. */
const LAYER_COLOR_CANDIDATES = [
  [0.92, 0.25, 0.28],
  [0.20, 0.48, 0.95],
  [0.15, 0.75, 0.38],
  [0.95, 0.55, 0.12],
  [0.65, 0.30, 0.90],
  [0.10, 0.72, 0.82],
  [0.90, 0.78, 0.08],
  [0.90, 0.28, 0.65],
  [0.50, 0.80, 0.15],
  [0.35, 0.30, 0.90],
  [0.95, 0.38, 0.18],
  [0.10, 0.65, 0.60],
] as const satisfies readonly Rgb[];

export interface EditorLayerColorInput {
  /** A tiny decoded version of the texture that the layer's selector masks. */
  readonly thumbnail?: RgbaImageDataLike | null;
  /** Stable editor-layer order; also defines the legacy fallback colour. */
  readonly fallbackIndex: number;
}

interface Oklab {
  readonly l: number;
  readonly a: number;
  readonly b: number;
}

const OVERLAY_OPACITY = 0.16;
const MIN_VISIBLE_ALPHA = 16;
const MAX_TEXTURE_SAMPLES = 256;
const MIN_LAYER_COLOR_DISTANCE = 0.14;
const SEPARATION_SCORE_WEIGHT = 0.18;

function clampUnit(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

export function linearLayerColorToCss([r, g, b]: Rgb, saturation: number): string {
  const toSrgbByte = (channel: number) => {
    const clamped = clampUnit(channel);
    const srgb = clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * clamped ** (1 / 2.4) - 0.055;
    return Math.round(srgb * 255);
  };
  const channels = [toSrgbByte(r), toSrgbByte(g), toSrgbByte(b)];
  const peak = Math.max(...channels);
  const lifted = peak > 0 ? channels.map((channel) => channel * Math.min(1.35, 242 / peak)) : channels;
  const average = lifted.reduce((sum, channel) => sum + channel, 0) / lifted.length;
  const vivid = lifted.map((channel) => Math.round(Math.min(
    255,
    Math.max(0, average + (channel - average) * saturation),
  )));
  return `rgb(${vivid[0]}, ${vivid[1]}, ${vivid[2]})`;
}

function srgbToLinear(value: number): number {
  const channel = clampUnit(value / 255);
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function toOklab(color: Rgb): Oklab {
  const [r, g, b] = color;
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
  const lRoot = Math.cbrt(Math.max(0, l));
  const mRoot = Math.cbrt(Math.max(0, m));
  const sRoot = Math.cbrt(Math.max(0, s));
  return {
    l: 0.2104542553 * lRoot + 0.793617785 * mRoot - 0.0040720468 * sRoot,
    a: 1.9779984951 * lRoot - 2.428592205 * mRoot + 0.4505937099 * sRoot,
    b: 0.0259040371 * lRoot + 0.7827717662 * mRoot - 0.808675766 * sRoot,
  };
}

function oklabDistance(first: Oklab, second: Oklab): number {
  return Math.hypot(first.l - second.l, first.a - second.a, first.b - second.b);
}

/** The historic indexed tint for a layer, wrapping after the palette runs out. */
export function fallbackColor(index: number): Rgb {
  return EDITOR_LAYER_MAP_COLORS[Math.max(0, index) % EDITOR_LAYER_MAP_COLORS.length];
}

function fallbackCandidateIndex(index: number): number {
  return Math.max(0, index) % EDITOR_LAYER_MAP_COLORS.length;
}

/** Up to one sample per thumbnail texel. Transparent pixels are skipped; translucent ones blend toward a dark base. */
function textureSamples(thumbnail: RgbaImageDataLike | null | undefined): Array<{ color: Rgb; weight: number }> {
  if (!thumbnail
    || !Number.isSafeInteger(thumbnail.width) || thumbnail.width <= 0
    || !Number.isSafeInteger(thumbnail.height) || thumbnail.height <= 0) return [];
  const pixels = thumbnail.width * thumbnail.height;
  if (!Number.isSafeInteger(pixels) || thumbnail.data.length < pixels * 4) return [];
  const count = Math.min(MAX_TEXTURE_SAMPLES, pixels);
  const output: Array<{ color: Rgb; weight: number }> = [];
  for (let sample = 0; sample < count; sample += 1) {
    const pixel = Math.min(pixels - 1, Math.floor(sample * pixels / count));
    const offset = pixel * 4;
    const alphaByte = Number(thumbnail.data[offset + 3]);
    const red = Number(thumbnail.data[offset]);
    const green = Number(thumbnail.data[offset + 1]);
    const blue = Number(thumbnail.data[offset + 2]);
    if (![alphaByte, red, green, blue].every(Number.isFinite) || alphaByte < MIN_VISIBLE_ALPHA) continue;
    const alpha = clampUnit(alphaByte / 255);
    // Blend low-alpha texels over near-black so transparent white padding does not make dark paint look bright.
    const neutral = 0.04;
    output.push({
      color: [
        srgbToLinear(red) * alpha + neutral * (1 - alpha),
        srgbToLinear(green) * alpha + neutral * (1 - alpha),
        srgbToLinear(blue) * alpha + neutral * (1 - alpha),
      ],
      weight: 0.25 + 0.75 * alpha,
    });
  }
  return output;
}

function candidateScore(candidate: Rgb, samples: readonly { color: Rgb; weight: number }[]): number {
  const contrasts = samples.map(({ color, weight }) => {
    const overlay: Rgb = [
      color[0] * (1 - OVERLAY_OPACITY) + candidate[0] * OVERLAY_OPACITY,
      color[1] * (1 - OVERLAY_OPACITY) + candidate[1] * OVERLAY_OPACITY,
      color[2] * (1 - OVERLAY_OPACITY) + candidate[2] * OVERLAY_OPACITY,
    ];
    return oklabDistance(toOklab(color), toOklab(overlay)) * weight;
  }).sort((left, right) => left - right);
  // Score the lower fifth, not the average: a candidate that vanishes into common texture colours is a poor cue.
  return contrasts[Math.floor((contrasts.length - 1) * 0.2)] ?? Number.NEGATIVE_INFINITY;
}

/**
 * Deterministically picks layer colours that stay legible over each layer's texture at overlay opacity.
 * Layer order keeps colours stable when parts are selected or deselected.
 */
export function chooseEditorLayerColors(inputs: readonly EditorLayerColorInput[]): Rgb[] {
  const usedCandidateIndexes = new Set<number>();
  const selectedColors: Rgb[] = [];
  return inputs.map(({ thumbnail, fallbackIndex }) => {
    const samples = textureSamples(thumbnail);
    if (samples.length === 0) {
      const candidateIndex = fallbackCandidateIndex(fallbackIndex);
      usedCandidateIndexes.add(candidateIndex);
      const color = fallbackColor(fallbackIndex);
      selectedColors.push(color);
      return color;
    }

    const available = LAYER_COLOR_CANDIDATES
      .map((_, index) => index)
      .filter((index) => !usedCandidateIndexes.has(index));
    const unusedCandidateIndexes = available.length > 0
      ? available
      : LAYER_COLOR_CANDIDATES.map((_, index) => index);
    const separationFromSelected = (candidateIndex: number) => selectedColors.length === 0
      ? 1
      : Math.min(...selectedColors.map((color) => oklabDistance(
        toOklab(LAYER_COLOR_CANDIDATES[candidateIndex]),
        toOklab(color),
      )));
    const separatedCandidateIndexes = unusedCandidateIndexes.filter((candidateIndex) => (
      separationFromSelected(candidateIndex) >= MIN_LAYER_COLOR_DISTANCE
    ));
    const candidateIndexes = separatedCandidateIndexes.length > 0
      ? separatedCandidateIndexes
      : unusedCandidateIndexes;
    let selectedIndex = candidateIndexes[0];
    let selectedScore = Number.NEGATIVE_INFINITY;
    for (const candidateIndex of candidateIndexes) {
      const score = candidateScore(LAYER_COLOR_CANDIDATES[candidateIndex], samples)
        + separationFromSelected(candidateIndex) * SEPARATION_SCORE_WEIGHT;
      // Strict comparison: palette order breaks ties, including on flat thumbnails.
      if (score > selectedScore) {
        selectedIndex = candidateIndex;
        selectedScore = score;
      }
    }
    usedCandidateIndexes.add(selectedIndex);
    const color = LAYER_COLOR_CANDIDATES[selectedIndex];
    selectedColors.push(color);
    return color;
  });
}

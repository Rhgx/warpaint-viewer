export interface StickerLevels {
  black: number;
  white: number;
  gamma: number;
}

export interface PreparedStickerArtwork {
  url: string;
  dispose(): void;
}

const COMPOSED_STICKER_BASES = new Set(['square', 'black_square', 'groupsticker']);

export interface StickerArtworkCandidate {
  readonly base: string;
  readonly destTl: readonly [number, number];
  readonly destTr: readonly [number, number];
  readonly destBl: readonly [number, number];
}

export interface StickerArtworkTarget {
  readonly bases: readonly (string | undefined)[];
  readonly quad?: {
    readonly tl: readonly [number, number];
    readonly tr: readonly [number, number];
    readonly bl: readonly [number, number];
  };
}

export interface GroupStickerArtworkTarget extends StickerArtworkTarget {
  readonly occurrenceCount: number;
}

const MAX_STICKER_ARTWORK_PIXELS = 16 * 1024 * 1024;

function normalizedTextureReference(value: string | undefined): string {
  return (value ?? '')
    .replace(/\\/g, '/')
    .replace(/^textures\//i, '')
    .replace(/\.(?:png|vtf|webp)$/i, '')
    .toLowerCase();
}

/** Group stickers use their base as an operation mask, not as visible artwork. */
export function stickerArtworkNeedsComposedPreview(bases: readonly (string | undefined)[]): boolean {
  const names = bases
    .map(normalizedTextureReference)
    .filter(Boolean)
    .map((reference) => reference.split('/').pop() ?? '');
  return names.length > 0 && names.every((name) => COMPOSED_STICKER_BASES.has(name));
}

function pointsEqual(first: readonly [number, number], second: readonly [number, number]): boolean {
  return Math.abs(first[0] - second[0]) < 1e-7 && Math.abs(first[1] - second[1]) < 1e-7;
}

/** Match direct authored stages without relying on indexes shifted by expanded templates. */
export function matchResolvedStickerArtwork<T extends StickerArtworkCandidate>(
  targets: readonly StickerArtworkTarget[],
  candidates: readonly T[],
): readonly (T | null)[] {
  const claimed = new Set<number>();
  return targets.map((target) => {
    if (!target.quad) return null;
    const bases = new Set(target.bases.map(normalizedTextureReference).filter(Boolean));
    const match = candidates.findIndex((candidate, index) => (
      !claimed.has(index)
      && bases.has(normalizedTextureReference(candidate.base))
      && pointsEqual(target.quad!.tl, candidate.destTl)
      && pointsEqual(target.quad!.tr, candidate.destTr)
      && pointsEqual(target.quad!.bl, candidate.destBl)
    ));
    if (match < 0) return null;
    claimed.add(match);
    return candidates[match];
  });
}

/** Match every resolved wear-branch occurrence owned by each logical sticker. */
export function matchResolvedStickerArtworkGroups<T extends StickerArtworkCandidate>(
  targets: readonly GroupStickerArtworkTarget[],
  candidates: readonly T[],
): readonly (readonly T[])[] {
  const claimed = new Set<number>();
  return targets.map((target) => {
    if (!target.quad) return [];
    const bases = new Set(target.bases.map(normalizedTextureReference).filter(Boolean));
    const matches: T[] = [];
    const limit = Math.max(1, target.occurrenceCount);
    for (let index = 0; index < candidates.length && matches.length < limit; index += 1) {
      const candidate = candidates[index];
      if (claimed.has(index)
        || !bases.has(normalizedTextureReference(candidate.base))
        || !pointsEqual(target.quad.tl, candidate.destTl)
        || !pointsEqual(target.quad.tr, candidate.destTr)
        || !pointsEqual(target.quad.bl, candidate.destBl)) continue;
      claimed.add(index);
      matches.push(candidate);
    }
    return matches;
  });
}

export function stickerLevelsAreIdentity({ black, white, gamma }: StickerLevels): boolean {
  return black === 0 && white === 1 && gamma === 1;
}

/** Apply TF2's sticker AdjustLevels operation to sRGB bytes, including alpha. */
export function adjustStickerArtworkPixels(pixels: Uint8ClampedArray, levels: StickerLevels): void {
  const { black, white, gamma } = levels;
  for (let index = 0; index < pixels.length; index++) {
    const source = pixels[index] / 255;
    const normalized = white === black
      ? source > black ? 1 : 0
      : Math.min(1, Math.max(0, (source - black) / (white - black)));
    pixels[index] = Math.round(Math.min(1, Math.max(0, normalized ** gamma)) * 255);
  }
}

/**
 * Prepare the exact artwork displayed by an apply_sticker stage. Raw source
 * textures can be white masks whose authored levels supply their visible
 * colour, so the editor must not show the source file by itself.
 */
export async function prepareStickerArtwork(url: string, levels: StickerLevels): Promise<PreparedStickerArtwork> {
  if (stickerLevelsAreIdentity(levels)) return { url, dispose() {} };

  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load sticker artwork (${response.status}).`);
  const bitmap = await createImageBitmap(await response.blob());
  try {
    const pixelCount = bitmap.width * bitmap.height;
    if (!Number.isSafeInteger(pixelCount) || pixelCount <= 0 || pixelCount > MAX_STICKER_ARTWORK_PIXELS) {
      throw new Error(`Sticker dimensions ${bitmap.width} x ${bitmap.height} are invalid or too large.`);
    }
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('This browser cannot prepare sticker artwork.');
    context.drawImage(bitmap, 0, 0);
    const image = context.getImageData(0, 0, bitmap.width, bitmap.height);
    adjustStickerArtworkPixels(image.data, levels);
    context.putImageData(image, 0, 0);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(
      (result) => result ? resolve(result) : reject(new Error('Could not encode sticker artwork.')),
      'image/png',
    ));
    const preparedUrl = URL.createObjectURL(blob);
    return { url: preparedUrl, dispose: () => URL.revokeObjectURL(preparedUrl) };
  } finally {
    bitmap.close();
  }
}

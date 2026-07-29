/**
 * The rules the export follows, with none of the machinery that carries them
 * out. The panel needs to show target paths, formats, sizes and warnings before
 * anyone clicks Export, and the exporter needs the same answers when it runs.
 * Keeping them here means the two can never drift, and means the panel does not
 * drag the VTF, DXT and zip encoders into the main bundle just to draw a list.
 */

import type { TextureMetadata } from '../data/types';
import { sourceTextureIdentity } from '../source/paths';

import type { RecipeNode } from '../compositor/types';

export type ExportTextureKind = 'texture' | 'mask' | 'sticker' | 'sticker-mask';

/**
 * Every texture a paint reads, across all the wear variants it was resolved
 * for.
 *
 * This is what the export packs from, rather than the set of paths the
 * compositor happens to have read so far. That set is filled in lazily as the
 * renderer resolves textures, so it depends on whether the paint finished
 * compositing before the tab was opened; the recipe is the same answer whether
 * or not anything has been drawn yet.
 */
export function collectTextureRefs(recipes: readonly RecipeNode[]): string[] {
  const refs = new Set<string>();
  const visit = (node: RecipeNode) => {
    switch (node.type) {
      case 'texture_lookup':
        refs.add(node.texture);
        break;
      case 'select':
        refs.add(node.groups);
        break;
      case 'apply_sticker':
        for (const sticker of node.stickers ?? []) {
          if (sticker.base) refs.add(sticker.base);
          if (sticker.spec) refs.add(sticker.spec);
        }
        node.nodes.forEach(visit);
        break;
      default:
        node.nodes.forEach(visit);
    }
  };
  for (const recipe of recipes) visit(recipe);
  return [...refs];
}
export type ExportCompression = 'auto' | 'lossless';

/**
 * The materials a paint kit definition names, e.g.
 * "models/paintkits/handcrafted/c_flamethrower".
 *
 * These are not part of the recipe, so walking the stage tree never finds them,
 * and they are not optional: a new paint kit ships one VMT per weapon it paints
 * and the definition points every weapon slot at its own. A pack that installs
 * the definition without them leaves the engine loading a material that is not
 * there, which is far worse than a missing texture.
 */
export function collectMaterialOverrides(definition: Record<string, unknown>): string[] {
  const overrides = new Set<string>();
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    if (value === null || typeof value !== 'object') return;
    for (const [key, current] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'material_override' && typeof current === 'string' && current) overrides.add(current);
      else visit(current);
    }
  };
  visit(definition);
  return [...overrides];
}

/**
 * Texture paths a VMT names, so a carried material's own dependencies come with
 * it (a paintkit VMT typically points at its own exponent mask and lightwarp).
 * Deliberately a scan for material-shaped values rather than a full KeyValues
 * parse: anything it picks up that the package does not carry is dropped, so a
 * false positive costs nothing and a missed reference costs a broken material.
 */
export function collectVmtTextureRefs(vmt: string): string[] {
  const refs = new Set<string>();
  for (const match of vmt.matchAll(/"\$[a-z0-9_]+"\s*"([^"]+)"/gi)) {
    const value = match[1].trim().replace(/\\/g, '/');
    // Values that are numbers, vectors or booleans are parameters, not paths.
    if (!value || /^[\d\s.[\]-]+$/.test(value) || value.includes(' ')) continue;
    refs.add(value.replace(/\.vtf$/i, ''));
  }
  return [...refs];
}

/** Where a viewer texture ref lands in the game's material tree. */
export function exportPathFor(ref: string): string {
  return `${sourceTextureIdentity(ref)}.vtf`;
}

/**
 * Region masks and sticker specs carry exact values, not a picture: a group map
 * addresses regions by id and the shader buckets those ids, so a few units of
 * DXT drift can move a pixel into the neighbouring region. Valve ships its own
 * group maps as DXT1 and gets away with it because the authored ids sit clear of
 * the bucket edges, but a user's mask has no such guarantee. Artwork takes the
 * compression, masks do not.
 */
export function formatFor(kind: ExportTextureKind, compression: ExportCompression): 'auto' | 'bgra8888' {
  if (compression === 'lossless') return 'bgra8888';
  return kind === 'mask' || kind === 'sticker-mask' ? 'bgra8888' : 'auto';
}

function isPowerOfTwo(value: number): boolean {
  return value > 0 && (value & (value - 1)) === 0;
}

export function warningsFor(
  ref: string,
  width: number | undefined,
  height: number | undefined,
  metadata: TextureMetadata | undefined,
): string[] {
  const path = exportPathFor(ref);
  const warnings: string[] = [];
  if (width !== undefined && height !== undefined) {
    if (!isPowerOfTwo(width) || !isPowerOfTwo(height)) {
      warnings.push(`${path} is ${width} x ${height}, which is not a power of two. The game may refuse to load it.`);
    }
    if (metadata && (metadata.width !== width || metadata.height !== height)) {
      warnings.push(`${path} is ${width} x ${height}, where the file it replaces is ${metadata.width} x ${metadata.height}.`);
    }
  }
  // Anything outside patterns/workshop/ is a file the base game ships, which
  // other paints read too. Replacing it is legitimate and often the point, but
  // it is not scoped to the paint on screen and people should know that.
  if (!ref.includes('/patterns/workshop/')) {
    warnings.push(`${path} is a stock game file, so this pack changes every war paint that reads it.`);
  }
  return warnings;
}

/** Rough encoded size, for the panel's running total before anything is read. */
export function estimateBytes(
  kind: ExportTextureKind,
  compression: ExportCompression,
  width: number,
  height: number,
): number {
  const perPixel = formatFor(kind, compression) === 'bgra8888' ? 4 : 1;
  // The mip chain adds a third again on top of the largest level.
  return Math.round(width * height * perPixel * 1.34);
}

export function sanitizePackName(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/^[_.]+|[_.]+$/g, '')
    .slice(0, 64);
  return cleaned || 'warpaint';
}

/**
 * Resolves which of a paint's textures a mounted package supplies.
 *
 * Driven by the paint's own recipe refs rather than by whatever the compositor
 * has read so far, so the answer is the same before and after the paint has
 * rendered, and resolved through the provider so a ref binds to exactly the
 * entry the viewer is drawing. Refs the package does not carry are left out on
 * purpose: those are stock files that already exist in the player's game.
 */
export function resolvePackageTextures(
  refs: readonly string[],
  packagePathFor: (ref: string) => string | undefined,
): { ref: string; path: string }[] {
  const found: { ref: string; path: string }[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    const path = packagePathFor(ref);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    found.push({ ref, path });
  }
  return found;
}

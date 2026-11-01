/**
 * The export rules, without the machinery that carries them out. The panel shows paths,
 * formats, sizes and warnings before Export is clicked, and the exporter uses the same answers,
 * so the two cannot drift. Keeping the encoders out of this module keeps them out of the main
 * bundle.
 */

import type { TextureMetadata } from '../data/types';
import { sourceTextureIdentity } from '../source/paths';

import type { RecipeNode } from '../compositor/types';

export type ExportTextureKind = 'texture' | 'mask' | 'sticker' | 'sticker-mask';

/**
 * Every texture a paint reads, across all its wear variants. The export packs from the recipes
 * rather than the compositor's lazily filled read set, which depends on whether anything was
 * drawn. An empty ref (a stage with no texture picked yet) names nothing and is skipped.
 */
export function collectTextureRefs(recipes: readonly RecipeNode[]): string[] {
  const refs = new Set<string>();
  const add = (ref: string | undefined) => { if (ref) refs.add(ref); };
  const visit = (node: RecipeNode) => {
    switch (node.type) {
      case 'texture_lookup':
        add(node.texture);
        break;
      case 'select':
        add(node.groups);
        break;
      case 'apply_sticker':
        for (const sticker of node.stickers ?? []) {
          add(sticker.base);
          add(sticker.spec);
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
 * The materials a paint kit definition names, e.g. models/paintkits/handcrafted/c_flamethrower.
 * They are not in the recipe, and they are required: a pack without them leaves the engine
 * loading a missing material, which is worse than a missing texture.
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
 * Texture paths a VMT names, so a carried material brings its own dependencies. A scan for
 * material-shaped values, not a full KeyValues parse: false positives are dropped later because
 * the package lacks them, while a miss would break a material.
 */
export function collectVmtTextureRefs(vmt: string): string[] {
  const refs = new Set<string>();
  // KeyValues allows quoted or bare keys and values, and community VMTs mix the two. Keep the
  // value capture path-shaped so numeric parameters and braces are not taken for dependencies.
  for (const match of vmt.matchAll(/(?:"\$[a-z0-9_]+"|\$[a-z0-9_]+)\s+(?:"([^"]+)"|([^\s{}"]+))/gi)) {
    const value = (match[1] ?? match[2] ?? '').trim().replace(/\\/g, '/');
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
 * Region masks and sticker specs hold exact values: the shader buckets a group map's ids, so
 * DXT drift can move a pixel into a neighbouring region. Valve's own maps get away with DXT1
 * because their ids sit clear of the bucket edges; a user's mask has no such guarantee.
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
  // Files outside patterns/workshop/ are stock game files that other paints read. Replacing one
  // is legitimate but unscoped, so warn.
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
 * Which of a paint's textures a mounted package supplies. Driven by the recipe refs, so the
 * answer does not depend on render order, and resolved through the provider so a ref binds to
 * the entry the viewer draws. Refs the package lacks are stock files and are left out.
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

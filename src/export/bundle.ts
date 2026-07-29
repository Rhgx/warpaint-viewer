/**
 * Turns the workbench's replaced textures into a mod TF2 loads from tf/custom/.
 *
 * The viewer's texture refs are already the game's material paths, so a slot
 * the user replaced maps straight onto the file the engine reads:
 *   textures/patterns/camo/australia.webp -> materials/patterns/camo/australia.vtf
 * sourceTextureIdentity() does that half, which is the same mapping the Source
 * package mount uses in reverse.
 *
 * Only files the user supplied are written. Nothing built in is re-emitted:
 * those already sit in the player's game, and a pack that carried them would be
 * both larger and a redistribution of Valve's assets.
 */

import { BlobWriter, TextReader, Uint8ArrayReader, ZipWriter } from '@zip.js/zip.js';
import type { TextureMetadata } from '../data/types';
import { collectVmtTextureRefs, exportPathFor, formatFor, sanitizePackName, warningsFor } from './plan';
import { sourceTextureCandidates } from '../source/paths';
import type { ExportCompression, ExportTextureKind } from './plan';
import { decodeImageExact } from './decodeImage';
import { encodeVtf } from './vtfEncode';
import { writeVpk } from './vpkWrite';

export interface ExportTextureInput {
  /** Viewer texture ref, e.g. "textures/patterns/workshop/mypaint/base.webp". */
  ref: string;
  /** The replacement image: a Blob, or any URL the browser can fetch. */
  source: Blob | string;
  kind: ExportTextureKind;
  /** Sampling flags of the file being replaced, so the export keeps them. */
  metadata?: TextureMetadata;
}

export interface ExportOptions {
  /** Folder name inside a folder export, or the wrapped .vpk's file name. */
  packName: string;
  container: 'zip' | 'vpk';
  /**
   * 'auto' follows the game's own choices: DXT for artwork, uncompressed for
   * masks. 'lossless' keeps every texture uncompressed.
   */
  compression: ExportCompression;
  paintName?: string;
  weaponName?: string;
  /** TF2 build the shipped data snapshot came from, recorded in the README. */
  gameBuild?: string | null;
  /** When that snapshot was taken, which is what a reader can compare against. */
  snapshotDate?: string | null;
  /**
   * The pack contains an unsigned proto_defs.vpd and therefore needs the
   * custom_items_games client plugin plus an -insecure TF2 launch.
   */
  requiresDefinitionBypass?: boolean;
}

/** Anything the caller wants carried along verbatim, at a pack-relative path. */
export interface ExportExtraFile {
  path: string;
  data: Uint8Array;
}

export interface ExportedFile {
  path: string;
  bytes: number;
  format: string;
  /** The ref this came from, for the panel's file list. */
  ref?: string;
}

export interface ExportResult {
  blob: Blob;
  fileName: string;
  files: ExportedFile[];
  warnings: string[];
}

function hasTransparency(pixels: Uint8Array): boolean {
  for (let i = 3; i < pixels.length; i += 4) if (pixels[i] !== 255) return true;
  return false;
}

/**
 * Mirrors the encoder's own choice so the file list and README can name the
 * format without the encoder having to report it back.
 */
function formatLabel(requested: 'auto' | 'bgra8888', pixels: Uint8Array): string {
  if (requested === 'bgra8888') return 'bgra8888';
  return hasTransparency(pixels) ? 'dxt5' : 'dxt1';
}

function describeInstall(options: ExportOptions, packName: string): string {
  return options.container === 'vpk'
    ? [
        `Drop ${packName}.vpk into:`,
        '',
        '    Steam/steamapps/common/Team Fortress 2/tf/custom/',
        '',
        'Then restart TF2.',
      ].join('\n')
    : [
        `Extract the ${packName} folder into:`,
        '',
        '    Steam/steamapps/common/Team Fortress 2/tf/custom/',
        '',
        `You should end up with tf/custom/${packName}/materials/. Then restart TF2.`,
      ].join('\n');
}

function buildReadme(
  options: ExportOptions,
  packName: string,
  files: ExportedFile[],
  warnings: string[],
): string {
  const lines: string[] = [];
  lines.push(options.paintName ? `${options.paintName} (custom textures)` : 'Custom war paint textures');
  lines.push('='.repeat(lines[0].length));
  lines.push('');
  if (options.paintName) {
    lines.push(`Built from the war paint "${options.paintName}"${options.weaponName ? ` on the ${options.weaponName}` : ''}.`);
  }
  lines.push(`Exported ${new Date().toISOString().slice(0, 10)} by the TF2 Warpaint Viewer.`);
  if (options.snapshotDate || options.gameBuild) {
    const day = options.snapshotDate ? new Date(options.snapshotDate).toISOString().slice(0, 10) : null;
    lines.push(
      `Built against TF2 game data from ${day ?? 'an earlier snapshot'}`
      + `${options.gameBuild ? ` (build ${options.gameBuild})` : ''}.`,
    );
  }
  lines.push('');
  lines.push('INSTALL');
  lines.push('-------');
  lines.push(describeInstall(options, packName));
  lines.push('');
  if (options.requiresDefinitionBypass) {
    lines.push('REQUIRED: CUSTOM DEFINITIONS PLUGIN');
    lines.push('-----------------------------------');
    lines.push('This pack contains a modified scripts/protodefs/proto_defs.vpd.');
    lines.push('Stock TF2 rejects that file during startup unless its integrity check is bypassed.');
    lines.push('');
    lines.push('1. Install the latest custom_items_games release:');
    lines.push('   https://github.com/ficool2/custom_items_games/releases/latest');
    lines.push('2. Extract its addons folder into Team Fortress 2/tf/.');
    lines.push('3. Add -insecure to TF2 launch options and restart the game.');
    lines.push('4. Confirm in the developer console that the plugin loaded before using this pack.');
    lines.push('');
    lines.push('Without the plugin and -insecure, remove this pack before starting TF2.');
    lines.push('Remove -insecure for normal multiplayer; client plugins do not load without it.');
    lines.push('');
  }
  lines.push('CONTENTS');
  lines.push('--------');
  lines.push(`  ${files.length} file${files.length === 1 ? '' : 's'} total`);
  const byExtension = new Map<string, number>();
  for (const file of files) {
    const name = file.path.split('/').pop() ?? file.path;
    const dot = name.lastIndexOf('.');
    const extension = dot >= 0 ? name.slice(dot + 1).toUpperCase() : 'other';
    byExtension.set(extension, (byExtension.get(extension) ?? 0) + 1);
  }
  const extensionLabels: Record<string, string> = {
    VTF: 'texture',
    VMT: 'material',
    VPD: 'definition',
    TXT: 'localization',
  };
  for (const [extension, count] of [...byExtension].sort(([a], [b]) => a.localeCompare(b))) {
    const label = extensionLabels[extension] ?? 'asset';
    lines.push(`  ${count} ${extension} ${label} file${count === 1 ? '' : 's'}`);
  }
  lines.push('');
  if (warnings.length) {
    lines.push('NOTES');
    lines.push('-----');
    for (const warning of warnings) lines.push(`  - ${warning}`);
    lines.push('');
  }
  lines.push('These files replace textures the game reads by path, so they change any');
  lines.push('war paint that reads the same file, not only the one they were made for.');
  lines.push('Delete them from tf/custom/ to go back to the stock look.');
  lines.push('');
  lines.push('Team Fortress 2 and its assets are the property of Valve Corporation.');
  lines.push('This pack is not affiliated with or endorsed by Valve.');
  return `${lines.join('\n')}\n`;
}

async function encodeTexture(
  input: ExportTextureInput,
  compression: ExportCompression,
  warnings: string[],
): Promise<{ path: string; data: Uint8Array; format: string }> {
  const image = await decodeImageExact(input.source);
  const path = exportPathFor(input.ref);
  warnings.push(...warningsFor(input.ref, image.width, image.height, input.metadata));

  const original = input.metadata;
  const requested = formatFor(input.kind, compression);
  const encoded = encodeVtf({
    width: image.width,
    height: image.height,
    pixels: image.pixels,
    format: requested,
    flags: original && {
      clampS: original.clampS,
      clampT: original.clampT,
      pointSample: original.pointSample,
      trilinear: original.trilinear,
      anisotropic: original.anisotropic,
      noMip: original.noMip,
      noLod: original.noLod,
    },
  });
  return { path, data: encoded, format: formatLabel(requested, image.pixels) };
}

/**
 * Copies those textures into the pack byte for byte.
 *
 * No decode and re-encode: a VTF the author made keeps its exact mip chain,
 * format and flags, and nothing this exporter does can degrade it. A slot the
 * user replaced by hand wins over the package copy, matching what the viewer
 * renders.
 */
export async function collectPackageFiles(
  entries: readonly {
    /** Path inside the mounted package. */
    path: string;
    /** Canonical Source path to emit when fallback matching repaired the layout. */
    writeAs?: string;
  }[],
  read: (path: string) => Promise<Uint8Array>,
  skip: ReadonlySet<string>,
): Promise<ExportExtraFile[]> {
  const files: ExportExtraFile[] = [];
  for (const { path, writeAs = path } of entries) {
    if (skip.has(writeAs)) continue;
    try {
      files.push({ path: writeAs, data: await read(path) });
    } catch {
      // A single unreadable entry should not sink the export: the pack simply
      // goes out without it, and the game falls back to its built-in file.
    }
  }
  return files;
}

/**
 * Carries a definition's materials, and whatever those materials reference.
 *
 * A new paint kit names one VMT per weapon it paints. Those VMTs in turn name
 * their own textures (an exponent mask, a lightwarp). None of it appears in the
 * recipe, so this follows the definition's references directly, one level deep
 * into each material, and takes whatever the package actually holds.
 */
export async function collectMaterialFiles(
  overrides: readonly string[],
  resolve: (path: string) => string | undefined,
  read: (path: string) => Promise<Uint8Array>,
): Promise<{ files: ExportExtraFile[]; missing: string[]; repaired: string[] }> {
  const files: ExportExtraFile[] = [];
  const missing: string[] = [];
  const repaired: string[] = [];
  const taken = new Set<string>();

  const take = async (path: string, writeAs = path): Promise<Uint8Array | null> => {
    if (taken.has(writeAs)) return null;
    const readFrom = resolve(path);
    if (!readFrom) return null;
    taken.add(writeAs);
    try {
      const data = await read(readFrom);
      files.push({ path: writeAs, data });
      return data;
    } catch {
      return null;
    }
  };

  for (const override of overrides) {
    const materialPath = `materials/${override.replace(/\\/g, '/').replace(/^materials\//i, '').replace(/\.vmt$/i, '')}.vmt`.toLowerCase();
    let data = await take(materialPath);
    if (!data && !taken.has(materialPath)) {
      // Packs are inconsistent about the "c_" prefix on this one file, and the
      // game itself uses both spellings (paintkits/macaw/paintkit_tool.vmt but
      // paintkits/c_dragons_fury/c_paintkit_tool_gold.vmt). When a definition
      // names one and the archive ships the other, the reference dangles and
      // whatever draws with it has nothing to load. The bytes are right there,
      // so carry them under the name the definition actually asks for and say
      // so, rather than shipping a pack with a hole in it.
      const slash = materialPath.lastIndexOf('/');
      const directory = materialPath.slice(0, slash + 1);
      const filename = materialPath.slice(slash + 1);
      const alternate = filename.startsWith('c_') ? filename.slice(2) : `c_${filename}`;
      data = await take(`${directory}${alternate}`, materialPath);
      if (data) repaired.push(materialPath);
    }
    if (!data) {
      if (!taken.has(materialPath)) missing.push(materialPath);
      continue;
    }
    for (const ref of collectVmtTextureRefs(new TextDecoder().decode(data))) {
      for (const candidate of sourceTextureCandidates(`materials/${ref}`)) {
        if (await take(candidate)) break;
      }
    }
  }
  return { files, missing, repaired };
}

export async function buildWarpaintExport(
  inputs: readonly ExportTextureInput[],
  options: ExportOptions,
  extras: readonly ExportExtraFile[] = [],
): Promise<ExportResult> {
  if (inputs.length === 0 && extras.length === 0) {
    throw new Error('There is nothing to export yet. Replace a texture first.');
  }
  const packName = sanitizePackName(options.packName);
  const warnings: string[] = [];
  const files: ExportedFile[] = [];
  const payload: { path: string; data: Uint8Array }[] = [];
  const payloadPaths = new Set<string>();
  const addPayload = (
    entry: { path: string; data: Uint8Array },
    file: ExportedFile,
  ): void => {
    // Inputs are added before package/generated extras, so a hand-edited
    // texture wins if several collectors converge on the same Source path.
    // This also keeps ZIPs unambiguous and prevents writeVpk() from rejecting
    // duplicate normalized entries.
    const identity = entry.path.replace(/\\/g, '/').toLowerCase();
    if (payloadPaths.has(identity)) return;
    payloadPaths.add(identity);
    payload.push(entry);
    files.push(file);
  };

  for (const input of inputs) {
    const encoded = await encodeTexture(input, options.compression, warnings);
    addPayload(
      { path: encoded.path, data: encoded.data },
      { path: encoded.path, bytes: encoded.data.length, format: encoded.format, ref: input.ref },
    );
  }
  for (const extra of extras) {
    addPayload(
      { path: extra.path, data: extra.data },
      { path: extra.path, bytes: extra.data.length, format: 'file' },
    );
  }

  const readme = buildReadme(options, packName, files, warnings);

  if (options.container === 'vpk') {
    // A README embedded in a VPK is invisible to almost everyone installing
    // it. Wrap the game-ready archive and its instructions in a normal zip so
    // the user sees both before moving only the VPK into tf/custom/.
    const vpk = writeVpk(payload);
    const writer = new ZipWriter(new BlobWriter('application/zip'));
    await writer.add(`${packName}.vpk`, new Uint8ArrayReader(vpk));
    await writer.add('README.txt', new TextReader(readme));
    return {
      blob: await writer.close(),
      fileName: `${packName}.zip`,
      files,
      warnings,
    };
  }

  const writer = new ZipWriter(new BlobWriter('application/zip'));
  for (const entry of payload) {
    await writer.add(`${packName}/${entry.path}`, new Uint8ArrayReader(entry.data));
  }
  await writer.add(`${packName}/README.txt`, new TextReader(readme));
  return {
    blob: await writer.close(),
    fileName: `${packName}.zip`,
    files,
    warnings,
  };
}

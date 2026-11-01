/**
 * Writer for Source 1 VPK directory files, the single-file layout src/source/vpk.ts reads: a
 * header, a three-level (extension / directory / filename) string tree, then the file data.
 * Output is version 2. Version 1 parses, but TF2's bin/vpk.exe places the data section at 28
 * bytes plus the tree size whatever the version says, so a v1 file extracts shifted and empty.
 */

import { crc32 } from '../source/vpk';
import { normalizeSourcePath, sourcePathExtension } from '../source/paths';

export interface VpkFileEntry {
  /** Source-relative path, e.g. "materials/patterns/mypaint/base.vtf". */
  path: string;
  data: Uint8Array;
}

const VPK_SIGNATURE = 0x55aa1234;
const VPK_VERSION = 2;
// signature + version + treeSize, then v2's four section sizes.
const VPK_HEADER_SIZE = 28;
// Checksum sections are optional and only read by an explicit integrity check, so they are left
// empty rather than bundling an MD5 implementation.
const FILE_DATA_SECTION_SIZE_OFFSET = 12;
// Entries point into the directory file itself, not a numbered _NNN.vpk segment
// (vpk.ts DIRECTORY_ARCHIVE_INDEX).
const DIRECTORY_ARCHIVE_INDEX = 0x7fff;
const ENTRY_TERMINATOR = 0xffff;
// Written verbatim: vpk.ts maps this exact string to the archive root.
const ROOT_DIRECTORY = ' ';
// crc32(4) + preloadBytes(2) + archiveIndex(2) + offset(4) + length(4) + terminator(2)
const ENTRY_FIXED_SIZE = 18;

interface TreeEntry {
  readonly stem: string;
  readonly data: Uint8Array;
  readonly crc: number;
}

interface DirectoryGroup {
  readonly directory: string;
  readonly entries: readonly TreeEntry[];
}

interface ExtensionGroup {
  readonly extension: string;
  readonly directories: readonly DirectoryGroup[];
}

/**
 * Builds a version-2 VPK containing every given file. Entries are grouped by
 * extension then directory then filename, and every level is sorted, so the
 * same input always serializes to identical bytes.
 */
export function writeVpk(files: readonly VpkFileEntry[]): Uint8Array {
  const groups = groupEntries(files);

  // The data section starts after the tree, so measure the tree first. Only the name strings
  // vary in width, so measureTreeSize walks the same structure writeTree does.
  const treeSize = measureTreeSize(groups);
  let dataSize = 0;
  for (const extension of groups) {
    for (const directory of extension.directories) {
      for (const entry of directory.entries) dataSize += entry.data.byteLength;
    }
  }

  const buffer = new Uint8Array(VPK_HEADER_SIZE + treeSize + dataSize);
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  view.setUint32(0, VPK_SIGNATURE, true);
  view.setUint32(4, VPK_VERSION, true);
  view.setUint32(8, treeSize, true);
  view.setUint32(FILE_DATA_SECTION_SIZE_OFFSET, dataSize, true);
  // archiveMD5SectionSize, otherMD5SectionSize and signatureSectionSize stay 0.

  writeTree(buffer, view, VPK_HEADER_SIZE, VPK_HEADER_SIZE + treeSize, groups);

  return buffer;
}

/** Groups and sorts entries; also validates and normalizes every path. */
function groupEntries(files: readonly VpkFileEntry[]): ExtensionGroup[] {
  // extension -> directory -> stem -> entry
  const byExtension = new Map<string, Map<string, Map<string, TreeEntry>>>();
  const seenPaths = new Set<string>();

  for (const file of files) {
    let normalized: string;
    try {
      normalized = normalizeSourcePath(file.path);
    } catch (error) {
      throw new Error(`Invalid VPK entry path "${file.path}": ${error instanceof Error ? error.message : String(error)}`);
    }

    if (seenPaths.has(normalized)) {
      throw new Error(`Duplicate VPK entry path "${normalized}".`);
    }
    seenPaths.add(normalized);

    // sourcePathExtension() also rejects dotfiles such as "materials/.vtf", which doubles as the
    // empty-name check.
    const extension = sourcePathExtension(normalized);
    if (!extension) {
      throw new Error(`VPK entries must have a file extension, got "${normalized}".`);
    }

    const slashIndex = normalized.lastIndexOf('/');
    const filename = slashIndex === -1 ? normalized : normalized.slice(slashIndex + 1);
    const directory = slashIndex === -1 ? ROOT_DIRECTORY : normalized.slice(0, slashIndex);
    const stem = filename.slice(0, filename.length - extension.length - 1);
    if (!stem) {
      throw new Error(`VPK entries must have a non-empty file name, got "${normalized}".`);
    }

    let byDirectory = byExtension.get(extension);
    if (!byDirectory) {
      byDirectory = new Map();
      byExtension.set(extension, byDirectory);
    }
    let byStem = byDirectory.get(directory);
    if (!byStem) {
      byStem = new Map();
      byDirectory.set(directory, byStem);
    }
    byStem.set(stem, { stem, data: file.data, crc: crc32(file.data) });
  }

  return sortByKey(byExtension).map(([extension, byDirectory]) => ({
    extension,
    directories: sortByKey(byDirectory).map(([directory, byStem]) => ({
      directory,
      entries: sortByKey(byStem).map(([, entry]) => entry),
    })),
  }));
}

/** Plain code-unit ordering, not localeCompare(), so output never depends on locale. */
function sortByKey<T>(map: ReadonlyMap<string, T>): [string, T][] {
  return [...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function measureTreeSize(groups: readonly ExtensionGroup[]): number {
  let size = cstringSize('');
  for (const extension of groups) {
    size += cstringSize(extension.extension) + cstringSize('');
    for (const directory of extension.directories) {
      size += cstringSize(directory.directory) + cstringSize('');
      for (const entry of directory.entries) size += cstringSize(entry.stem) + ENTRY_FIXED_SIZE;
    }
  }
  return size;
}

function cstringSize(text: string): number {
  return utf8Encoder.encode(text).byteLength + 1;
}

const utf8Encoder = new TextEncoder();

function writeTree(
  buffer: Uint8Array,
  view: DataView,
  treeStart: number,
  dataStart: number,
  groups: readonly ExtensionGroup[],
): void {
  let treeCursor = treeStart;
  let dataOffset = 0;

  const writeCString = (text: string): void => {
    const bytes = utf8Encoder.encode(text);
    buffer.set(bytes, treeCursor);
    treeCursor += bytes.byteLength;
    buffer[treeCursor] = 0;
    treeCursor += 1;
  };

  for (const extension of groups) {
    writeCString(extension.extension);
    for (const directory of extension.directories) {
      writeCString(directory.directory);
      for (const entry of directory.entries) {
        writeCString(entry.stem);
        view.setUint32(treeCursor, entry.crc, true); treeCursor += 4;
        view.setUint16(treeCursor, 0, true); treeCursor += 2; // preloadBytes: this writer never preloads
        view.setUint16(treeCursor, DIRECTORY_ARCHIVE_INDEX, true); treeCursor += 2;
        // Relative to dataStart; the reader adds dataBaseOffset (vpk.ts).
        view.setUint32(treeCursor, dataOffset, true); treeCursor += 4;
        view.setUint32(treeCursor, entry.data.byteLength, true); treeCursor += 4;
        view.setUint16(treeCursor, ENTRY_TERMINATOR, true); treeCursor += 2;

        buffer.set(entry.data, dataStart + dataOffset);
        dataOffset += entry.data.byteLength;
      }
      writeCString(''); // ends this directory's filename list
    }
    writeCString(''); // ends this extension's directory list
  }
  writeCString(''); // ends the extension list
}

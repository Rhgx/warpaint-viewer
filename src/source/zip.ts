import { BlobReader, Uint8ArrayWriter, ZipReader, type FileEntry } from '@zip.js/zip.js';

import {
  type SourceDiagnostic,
  type SourceEntry,
  type SourcePackage,
  type SourcePackageOpenResult,
  SourcePackageError,
} from './contracts';
import { isSupportedTexturePath, normalizeSourcePath } from './paths';

const MEBIBYTE = 1024 * 1024;

export interface ZipSourcePackageLimits {
  /** Limits central-directory work before any entry is decompressed. */
  maxArchiveBytes: number;
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalExpandedBytes: number;
  /** Reports unusually dense entries; expanded-byte limits provide the hard bound. */
  maxCompressionRatio: number;
}

/** Conservative defaults for an untrusted browser upload. */
export const DEFAULT_ZIP_SOURCE_PACKAGE_LIMITS: Readonly<ZipSourcePackageLimits> = {
  maxArchiveBytes: 512 * MEBIBYTE,
  maxEntries: 10_000,
  maxEntryBytes: 128 * MEBIBYTE,
  maxTotalExpandedBytes: 512 * MEBIBYTE,
  maxCompressionRatio: 200,
};

interface IndexedZipEntry {
  source: SourceEntry;
  zipEntry: FileEntry;
}

function packageId(file: File): string {
  const random = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  return `zip:${file.name}:${file.size}:${file.lastModified}:${random}`;
}

function sourceError(code: string, message: string, path?: string, cause?: unknown): SourcePackageError {
  return new SourcePackageError(code, message, path, cause);
}

function ensureFiniteNonNegative(value: number, label: string, path: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw sourceError('invalid-entry-size', `${label} is invalid.`, path);
  }
  return value;
}

function isHarmlessMetadataPath(path: string): boolean {
  return path === '__macosx' || path.startsWith('__macosx/');
}

function resolveLimits(configuredLimits: Partial<ZipSourcePackageLimits>): ZipSourcePackageLimits {
  const limits = { ...DEFAULT_ZIP_SOURCE_PACKAGE_LIMITS, ...configuredLimits };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw sourceError('invalid-limit', `${name} must be a positive safe integer.`);
    }
  }
  return limits;
}

class ZipSourcePackage implements SourcePackage {
  readonly format = 'zip' as const;
  readonly entries: ReadonlyMap<string, SourceEntry>;
  readonly id: string;
  readonly name: string;
  #disposed = false;
  private readonly reader: ZipReader<Blob>;
  private readonly indexedEntries: ReadonlyMap<string, IndexedZipEntry>;
  private readonly limits: ZipSourcePackageLimits;

  constructor(
    id: string,
    name: string,
    reader: ZipReader<Blob>,
    indexedEntries: ReadonlyMap<string, IndexedZipEntry>,
    entries: ReadonlyMap<string, SourceEntry>,
    limits: ZipSourcePackageLimits,
  ) {
    this.id = id;
    this.name = name;
    this.reader = reader;
    this.indexedEntries = indexedEntries;
    this.entries = entries;
    this.limits = limits;
  }

  has(path: string): boolean {
    try {
      return this.entries.has(normalizeSourcePath(path));
    } catch {
      return false;
    }
  }

  async read(path: string): Promise<Uint8Array> {
    if (this.#disposed) {
      throw sourceError('package-disposed', 'This Source package has been removed.');
    }
    const canonicalPath = normalizeSourcePath(path);
    const indexed = this.indexedEntries.get(canonicalPath);
    if (!indexed) {
      throw sourceError('entry-not-found', 'The requested Source asset is not in this package.', canonicalPath);
    }

    try {
      const bytes = await indexed.zipEntry.getData(new Uint8ArrayWriter(), {
        checkAmbiguity: true,
        checkSignature: true,
      });
      if (this.#disposed) {
        throw sourceError('package-disposed', 'This Source package was removed while its entry was being read.', canonicalPath);
      }
      if (bytes.byteLength !== indexed.source.size || bytes.byteLength > this.limits.maxEntryBytes) {
        throw sourceError('entry-size-mismatch', 'Extracted entry size does not match its validated archive metadata.', canonicalPath);
      }
      return bytes;
    } catch (error) {
      if (error instanceof SourcePackageError) throw error;
      throw sourceError('entry-read-failed', 'Could not read this ZIP entry.', canonicalPath, error);
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    void this.reader.close().catch(() => undefined);
  }
}

/**
 * Validates a Source-root ZIP central directory without inflating its files.
 * The returned package keeps the supplied File open and extracts only on read.
 */
export async function openZipSourcePackage(
  file: File,
  configuredLimits: Partial<ZipSourcePackageLimits> = {},
): Promise<SourcePackageOpenResult> {
  const limits = resolveLimits(configuredLimits);
  if (file.size > limits.maxArchiveBytes) {
    throw sourceError('archive-too-large', `ZIP files may not exceed ${limits.maxArchiveBytes} bytes.`, file.name);
  }

  const reader = new ZipReader(new BlobReader(file), { strictness: 'strict' });
  try {
    const entries = await reader.getEntries({
      checkAmbiguity: true,
      strictness: 'strict',
      maxAppendedDataSize: 0,
    });
    if (entries.length > limits.maxEntries) {
      throw sourceError('too-many-entries', `ZIP files may contain at most ${limits.maxEntries.toLocaleString()} entries.`, file.name);
    }

    // Mod ZIPs commonly wrap the Source tree in one descriptive folder (for
    // example `Yeti Coated/materials/...`). Treat that single shared folder as
    // presentation rather than part of the Source path. Multiple or nested
    // roots remain ambiguous and are rejected below.
    const normalizedArchivePaths = entries.map((entry) => ({
      entry,
      path: normalizeSourcePath(entry.filename),
    })).filter(({ path }) => !isHarmlessMetadataPath(path));
    const hasDirectMaterialsRoot = normalizedArchivePaths.some(({ entry, path }) =>
      (path === 'materials' && entry.directory) || path.startsWith('materials/'));
    let wrapperRoot: string | undefined;
    if (!hasDirectMaterialsRoot) {
      const roots = new Set(normalizedArchivePaths.map(({ path }) => path.split('/')[0]));
      const onlyRoot = roots.size === 1 ? roots.values().next().value as string | undefined : undefined;
      if (onlyRoot && normalizedArchivePaths.some(({ entry, path }) =>
        (path === `${onlyRoot}/materials` && entry.directory) || path.startsWith(`${onlyRoot}/materials/`))) {
        wrapperRoot = onlyRoot;
      }
    }

    const diagnostics: SourceDiagnostic[] = [];
    const sourceEntries = new Map<string, SourceEntry>();
    const indexedEntries = new Map<string, IndexedZipEntry>();
    const normalizedPaths = new Set<string>();
    let totalExpandedBytes = 0;
    let hasMaterialsRoot = false;
    let ignoredMetadataEntries = 0;
    let highCompressionEntryCount = 0;
    let highestCompressionRatio = 0;
    let highestCompressionPath: string | undefined;

    for (const entry of entries) {
      let archivePath: string;
      try {
        archivePath = normalizeSourcePath(entry.filename);
      } catch (error) {
        if (error instanceof SourcePackageError) {
          throw sourceError(error.code, error.message, entry.filename, error);
        }
        throw error;
      }
      if (isHarmlessMetadataPath(archivePath)) {
        ignoredMetadataEntries += 1;
        continue;
      }
      if (wrapperRoot && archivePath === wrapperRoot && entry.directory) continue;
      const canonicalPath = wrapperRoot && archivePath.startsWith(`${wrapperRoot}/`)
        ? archivePath.slice(wrapperRoot.length + 1)
        : archivePath;
      if (normalizedPaths.has(canonicalPath)) {
        throw sourceError('duplicate-path', 'ZIP contains paths that collide after Source path normalization.', canonicalPath);
      }
      normalizedPaths.add(canonicalPath);
      if ((canonicalPath === 'materials' && entry.directory) || canonicalPath.startsWith('materials/')) {
        hasMaterialsRoot = true;
      }
      if (entry.encrypted) {
        throw sourceError('encrypted-entry', 'Encrypted ZIP entries are not supported.', entry.filename);
      }
      if (entry.directory) continue;

      const size = ensureFiniteNonNegative(entry.uncompressedSize, 'Uncompressed entry size', entry.filename);
      const compressedSize = ensureFiniteNonNegative(entry.compressedSize, 'Compressed entry size', entry.filename);
      if (size > limits.maxEntryBytes) {
        throw sourceError('entry-too-large', `ZIP entries may not exceed ${limits.maxEntryBytes} bytes when expanded.`, entry.filename);
      }
      totalExpandedBytes += size;
      if (totalExpandedBytes > limits.maxTotalExpandedBytes) {
        throw sourceError('expanded-size-limit', `ZIP files may not expand beyond ${limits.maxTotalExpandedBytes} bytes.`, file.name);
      }
      const compressionRatio = compressedSize === 0 ? (size === 0 ? 1 : Infinity) : size / compressedSize;
      if (compressionRatio > limits.maxCompressionRatio) {
        highCompressionEntryCount += 1;
        if (compressionRatio > highestCompressionRatio) {
          highestCompressionRatio = compressionRatio;
          highestCompressionPath = canonicalPath;
        }
      }
      const source: SourceEntry = {
        path: canonicalPath,
        size,
        compressedSize,
        crc32: entry.signature >>> 0,
      };
      sourceEntries.set(canonicalPath, source);
      indexedEntries.set(canonicalPath, { source, zipEntry: entry });
    }

    if (!hasMaterialsRoot) {
      throw sourceError('missing-materials-root', 'ZIP packages must contain materials/ at the root or inside one wrapper directory.', file.name);
    }
    if (wrapperRoot) {
      diagnostics.push({
        id: 'zip-wrapper-root',
        level: 'info',
        message: 'Removed the package wrapper directory to create a Source-style root.',
        detail: `${wrapperRoot}/`,
      });
    }
    if (highCompressionEntryCount > 0) {
      diagnostics.push({
        id: 'zip-high-compression',
        level: 'info',
        message: `${highCompressionEntryCount.toLocaleString()} highly compressed ZIP ${highCompressionEntryCount === 1 ? 'entry' : 'entries'} detected (up to ${Math.round(highestCompressionRatio).toLocaleString()}:1); protected by expanded-size limits.`,
        detail: highestCompressionPath,
      });
    }
    if (ignoredMetadataEntries > 0) {
      diagnostics.push({
        id: 'zip-macos-metadata',
        level: 'info',
        message: `Ignored ${ignoredMetadataEntries.toLocaleString()} macOS metadata ${ignoredMetadataEntries === 1 ? 'entry' : 'entries'}.`,
        detail: '__MACOSX/',
      });
    }
    const materialTextureCount = [...sourceEntries.values()]
      .filter((entry) => entry.path.startsWith('materials/') && isSupportedTexturePath(entry.path)).length;
    if (materialTextureCount === 0) {
      diagnostics.push({
        id: 'zip-no-supported-material-textures',
        level: 'warning',
        message: 'This package has no supported texture files beneath materials/.',
        detail: 'materials/',
      });
    }

    const suggestedPaintkitId = wrapperRoot && /^\d+$/.test(wrapperRoot)
      ? Number(wrapperRoot)
      : undefined;
    if (suggestedPaintkitId !== undefined && Number.isSafeInteger(suggestedPaintkitId)) {
      diagnostics.push({
        id: 'zip-paintkit-index',
        level: 'info',
        message: `Detected war paint index ${suggestedPaintkitId.toLocaleString()} from the package directory.`,
        detail: `${wrapperRoot}/`,
      });
    }
    return {
      package: new ZipSourcePackage(
        packageId(file),
        file.name,
        reader,
        indexedEntries,
        sourceEntries,
        limits,
      ),
      diagnostics,
      suggestedPaintkitId: suggestedPaintkitId !== undefined && Number.isSafeInteger(suggestedPaintkitId)
        ? suggestedPaintkitId
        : undefined,
    };
  } catch (error) {
    await reader.close().catch(() => undefined);
    if (error instanceof SourcePackageError) throw error;
    throw sourceError('invalid-zip', 'Could not read this ZIP archive.', file.name, error);
  }
}

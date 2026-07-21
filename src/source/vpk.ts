/**
 * Browser-safe reader for Source 1 VPK directory files.  It deliberately only
 * reads the small header/tree during mounting; entry data remains in the File
 * objects and is sliced on demand.
 */

import type { SourceDiagnostic, SourceEntry, SourcePackage, SourcePackageOpenResult } from './contracts'
import { SourcePackageError } from './contracts'
import { normalizeSourcePath } from './paths'

const VPK_SIGNATURE = 0x55aa1234
const DIRECTORY_ARCHIVE_INDEX = 0x7fff
const VPK_V1_HEADER_SIZE = 12
const VPK_V2_HEADER_SIZE = 28
const MEBIBYTE = 1024 * 1024
const EMPTY_BYTES = new Uint8Array(0)

export interface VpkSourcePackageLimits {
  /** Total bytes across the directory VPK and every selected numbered segment. */
  maxPackageBytes: number
  /** Maximum size of any one selected directory or numbered VPK file. */
  maxFileBytes: number
  /** Maximum number of VPK files accepted in one multipart selection. */
  maxFiles: number
  maxTreeBytes: number
  maxEntries: number
  maxPreloadBytesPerEntry: number
  /** Maximum uncompressed bytes returned by one lazy entry read. */
  maxEntryBytes: number
}

/**
 * Source's normal multipart target is roughly 200 MiB per segment, so these
 * defaults allow ordinary texture mods while bounding all browser work.
 */
export const DEFAULT_VPK_SOURCE_PACKAGE_LIMITS: Readonly<VpkSourcePackageLimits> = {
  maxPackageBytes: 512 * MEBIBYTE,
  maxFileBytes: 256 * MEBIBYTE,
  maxFiles: 64,
  maxTreeBytes: 16 * MEBIBYTE,
  maxEntries: 50_000,
  maxPreloadBytesPerEntry: 8 * MEBIBYTE,
  maxEntryBytes: 128 * MEBIBYTE,
}

export type VpkOpenOptions = Partial<VpkSourcePackageLimits>

export interface VpkSourceEntry extends SourceEntry {
  readonly crc32: number
  readonly preloadBytes: number
  readonly archiveIndex: number
}

interface VpkRecord extends VpkSourceEntry {
  readonly offset: number
  readonly preload: Uint8Array
  readonly dataFile: File
  readonly dataBaseOffset: number
}

interface VpkHeader {
  readonly version: 1 | 2
  readonly treeSize: number
  readonly treeStart: number
  readonly dataStart: number
  readonly embeddedDataSize: number
}

type Limits = Readonly<VpkSourcePackageLimits>

/** Error codes are stable enough for the UI to turn into helpful diagnostics. */
export type VpkErrorCode =
  | 'vpk-invalid-input'
  | 'vpk-missing-directory'
  | 'vpk-multiple-directories'
  | 'vpk-invalid-signature'
  | 'vpk-unsupported-version'
  | 'vpk-truncated-header'
  | 'vpk-invalid-tree'
  | 'vpk-too-many-files'
  | 'vpk-file-too-large'
  | 'vpk-package-too-large'
  | 'vpk-entry-limit'
  | 'vpk-path'
  | 'vpk-duplicate-path'
  | 'vpk-entry-range'
  | 'vpk-missing-segments'
  | 'vpk-crc-mismatch'
  | 'vpk-disposed'

export class VpkPackageError extends SourcePackageError {
  readonly missingSegments?: readonly string[]

  constructor(code: VpkErrorCode, message: string, options?: { path?: string; missingSegments?: readonly string[] }) {
    super(code, message, options?.path)
    this.missingSegments = options?.missingSegments
  }
}

/**
 * A mounted VPK. File bytes are never copied until an entry is requested.
 * The package owns no object URLs, so dispose only makes future reads fail and
 * releases its in-memory index/preload slices.
 */
export class VpkSourcePackage implements SourcePackage {
  readonly format = 'vpk' as const
  readonly id: string
  readonly name: string
  readonly entries: ReadonlyMap<string, VpkSourceEntry>

  #records: Map<string, VpkRecord>
  #disposed = false

  constructor(name: string, directoryFile: File, records: Map<string, VpkRecord>) {
    this.name = name
    const random = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)
    this.id = `vpk:${directoryFile.name}:${directoryFile.size}:${directoryFile.lastModified}:${random}`
    this.#records = records
    this.entries = records
  }

  has(path: string): boolean {
    try {
      return this.#records.has(normalizeSourcePath(path))
    } catch {
      return false
    }
  }

  async read(path: string): Promise<Uint8Array> {
    this.#assertActive()

    let normalized: string
    try {
      normalized = normalizeSourcePath(path)
    } catch (error) {
      throw new VpkPackageError('vpk-path', `Invalid VPK entry path: ${String(error)}`, { path })
    }

    const record = this.#records.get(normalized)
    if (!record) {
      throw new VpkPackageError('vpk-invalid-input', `VPK does not contain “${normalized}”.`, { path: normalized })
    }

    const archiveLength = record.size - record.preloadBytes
    const archive = archiveLength === 0
      ? EMPTY_BYTES
      : await readFileRange(record.dataFile, record.dataBaseOffset + record.offset, archiveLength, normalized)
    this.#assertActive()
    const actualCrc32 = crc32Chunks(record.preload, archive)
    if (actualCrc32 !== record.crc32) {
      throw new VpkPackageError(
        'vpk-crc-mismatch',
        `CRC32 mismatch for “${normalized}” (expected ${formatCrc32(record.crc32)}, got ${formatCrc32(actualCrc32)}).`,
        { path: normalized },
      )
    }

    // Validate before allocating the combined return buffer. This avoids a
    // second large allocation for corrupt entries, and no copy is made when
    // the entry has no preload bytes.
    if (archiveLength > 0) return joinBytes(record.preload, archive)
    return record.preload.slice()
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#records.clear()
  }

  #assertActive(): void {
    if (this.#disposed) {
      throw new VpkPackageError('vpk-disposed', 'This VPK package has already been removed.')
    }
  }
}

/**
 * Opens a standalone directory VPK or a complete multipart selection. Selecting
 * a numbered archive without its matching _dir.vpk is rejected before mounting.
 */
export async function openVpkPackage(files: readonly File[], options: VpkOpenOptions = {}): Promise<VpkSourcePackage> {
  const limits = resolveLimits(options)
  const vpkFiles = files.filter((file) => file.name.toLowerCase().endsWith('.vpk'))
  if (vpkFiles.length === 0) {
    throw new VpkPackageError('vpk-invalid-input', 'Select at least one .vpk file.')
  }
  validateSelectedFiles(vpkFiles, limits)

  const nameIndex = indexFilesByName(vpkFiles)
  const directoryCandidates = vpkFiles.filter((file) => /_dir\.vpk$/i.test(file.name))
  if (directoryCandidates.length > 1) {
    throw new VpkPackageError('vpk-multiple-directories', 'Select exactly one _dir.vpk directory file at a time.')
  }
  if (directoryCandidates.length === 0 && vpkFiles.length > 1) {
    throw new VpkPackageError('vpk-missing-directory', 'Multipart VPK imports require their matching _dir.vpk file.')
  }
  if (directoryCandidates.length === 0 && /_\d{3}\.vpk$/i.test(vpkFiles[0].name)) {
    throw new VpkPackageError('vpk-missing-directory', 'This appears to be a numbered VPK archive segment. Select its matching _dir.vpk file as well.')
  }

  const directoryFile = directoryCandidates[0] ?? vpkFiles[0]
  const packageName = packageNameFromDirectoryFile(directoryFile.name)
  const header = await readVpkHeader(directoryFile, limits)
  const tree = await readFileRange(directoryFile, header.treeStart, header.treeSize, directoryFile.name)
  const records = parseTree(tree, header, directoryFile, nameIndex, packageName, limits)

  return new VpkSourcePackage(packageName, directoryFile, records)
}

/** Shared-package equivalent of the ZIP opener. VPK parsing currently has no non-fatal warnings. */
export async function openVpkSourcePackage(
  files: readonly File[],
  options: VpkOpenOptions = {},
): Promise<SourcePackageOpenResult> {
  return { package: await openVpkPackage(files, options), diagnostics: [] }
}

/** Convert package errors into the shape consumed by the shared import UI. */
export function vpkErrorDiagnostic(error: unknown): SourceDiagnostic {
  if (error instanceof VpkPackageError) {
    const details = [error.path, error.missingSegments?.join(', ')].filter((value): value is string => Boolean(value))
    return { id: `vpk-${error.code}`, level: 'error', message: error.message, detail: details.join(' — ') || undefined }
  }
  return { id: 'vpk-unknown-error', level: 'error', message: error instanceof Error ? error.message : String(error) }
}

function resolveLimits(options: VpkOpenOptions): Limits {
  const configured = { ...DEFAULT_VPK_SOURCE_PACKAGE_LIMITS, ...options }
  return {
    maxPackageBytes: validateLimit(configured.maxPackageBytes, 'maxPackageBytes'),
    maxFileBytes: validateLimit(configured.maxFileBytes, 'maxFileBytes'),
    maxFiles: validateLimit(configured.maxFiles, 'maxFiles'),
    maxTreeBytes: validateLimit(configured.maxTreeBytes, 'maxTreeBytes'),
    maxEntries: validateLimit(configured.maxEntries, 'maxEntries'),
    maxPreloadBytesPerEntry: validateLimit(configured.maxPreloadBytesPerEntry, 'maxPreloadBytesPerEntry'),
    maxEntryBytes: validateLimit(configured.maxEntryBytes, 'maxEntryBytes'),
  }
}

function validateLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new VpkPackageError('vpk-invalid-input', `${name} must be a positive safe integer.`)
  }
  return value
}

function validateSelectedFiles(files: readonly File[], limits: Limits): void {
  if (files.length > limits.maxFiles) {
    throw new VpkPackageError('vpk-too-many-files', `VPK imports may contain at most ${limits.maxFiles.toLocaleString()} selected files.`)
  }

  let packageBytes = 0
  for (const file of files) {
    if (!Number.isSafeInteger(file.size) || file.size < 0) {
      throw new VpkPackageError('vpk-invalid-input', `“${file.name}” has an invalid file size.`)
    }
    if (file.size > limits.maxFileBytes) {
      throw new VpkPackageError(
        'vpk-file-too-large',
        `“${file.name}” (${formatBytes(file.size)}) exceeds the ${formatBytes(limits.maxFileBytes)} per-file VPK limit.`,
        { path: file.name },
      )
    }
    packageBytes = checkedAdd(packageBytes, file.size, 'selected VPK package')
    if (packageBytes > limits.maxPackageBytes) {
      throw new VpkPackageError(
        'vpk-package-too-large',
        `The selected VPK files exceed the ${formatBytes(limits.maxPackageBytes)} package limit.`,
      )
    }
  }
}

function indexFilesByName(files: readonly File[]): ReadonlyMap<string, File> {
  const index = new Map<string, File>()
  for (const file of files) {
    const key = file.name.toLowerCase()
    if (index.has(key)) {
      throw new VpkPackageError('vpk-invalid-input', `The selected files contain duplicate name “${file.name}”.`)
    }
    index.set(key, file)
  }
  return index
}

async function readVpkHeader(file: File, limits: Limits): Promise<VpkHeader> {
  if (file.size < VPK_V1_HEADER_SIZE) {
    throw new VpkPackageError('vpk-truncated-header', `“${file.name}” is too small to be a VPK directory file.`)
  }

  const initial = await readFileRange(file, 0, Math.min(file.size, VPK_V2_HEADER_SIZE), file.name)
  const view = new DataView(initial.buffer, initial.byteOffset, initial.byteLength)
  if (view.getUint32(0, true) !== VPK_SIGNATURE) {
    throw new VpkPackageError('vpk-invalid-signature', `“${file.name}” does not have a Source VPK signature.`)
  }

  const version = view.getUint32(4, true)
  if (version !== 1 && version !== 2) {
    throw new VpkPackageError('vpk-unsupported-version', `“${file.name}” uses unsupported VPK version ${version}.`)
  }

  const headerSize = version === 1 ? VPK_V1_HEADER_SIZE : VPK_V2_HEADER_SIZE
  if (file.size < headerSize || initial.byteLength < headerSize) {
    throw new VpkPackageError('vpk-truncated-header', `“${file.name}” has a truncated VPK v${version} header.`)
  }

  const treeSize = view.getUint32(8, true)
  if (treeSize > limits.maxTreeBytes) {
    throw new VpkPackageError('vpk-invalid-tree', `The VPK directory tree (${treeSize.toLocaleString()} bytes) exceeds the configured limit.`)
  }

  const treeStart = headerSize
  const dataStart = checkedAdd(treeStart, treeSize, 'directory tree')
  let embeddedDataSize = file.size - dataStart
  if (version === 2) {
    const fileDataSectionSize = view.getUint32(12, true)
    const archiveMd5SectionSize = view.getUint32(16, true)
    const otherMd5SectionSize = view.getUint32(20, true)
    const signatureSectionSize = view.getUint32(24, true)
    const declaredEnd = checkedAdd(dataStart, fileDataSectionSize, 'VPK file data section')
    const finalEnd = checkedAdd(checkedAdd(checkedAdd(declaredEnd, archiveMd5SectionSize, 'VPK archive MD5 section'), otherMd5SectionSize, 'VPK other MD5 section'), signatureSectionSize, 'VPK signature section')
    if (finalEnd > file.size) {
      throw new VpkPackageError('vpk-invalid-tree', `“${file.name}” declares VPK v2 sections outside the file bounds.`)
    }
    embeddedDataSize = fileDataSectionSize
  }
  if (dataStart > file.size) {
    throw new VpkPackageError('vpk-invalid-tree', `“${file.name}” declares a directory tree outside the file bounds.`)
  }

  return { version, treeSize, treeStart, dataStart, embeddedDataSize }
}

function parseTree(
  tree: Uint8Array,
  header: VpkHeader,
  directoryFile: File,
  fileIndex: ReadonlyMap<string, File>,
  packageName: string,
  limits: Limits,
): Map<string, VpkRecord> {
  const reader = new TreeReader(tree)
  const records = new Map<string, VpkRecord>()
  const missingSegments = new Set<string>()

  while (true) {
    const extension = reader.string('extension')
    if (extension === '') break
    while (true) {
      const directory = reader.string('directory')
      if (directory === '') break
      while (true) {
        const filename = reader.string('filename')
        if (filename === '') break
        if (records.size >= limits.maxEntries) {
          throw new VpkPackageError('vpk-entry-limit', `The VPK contains more than ${limits.maxEntries.toLocaleString()} entries.`)
        }

        const crc = reader.uint32('entry CRC32')
        const preloadBytes = reader.uint16('entry preload byte count')
        const archiveIndex = reader.uint16('entry archive index')
        const offset = reader.uint32('entry offset')
        const archiveLength = reader.uint32('entry length')
        const terminator = reader.uint16('entry terminator')
        if (terminator !== 0xffff) {
          throw new VpkPackageError('vpk-invalid-tree', `VPK entry “${filename}” has an invalid 0x${terminator.toString(16)} terminator.`)
        }
        if (preloadBytes > limits.maxPreloadBytesPerEntry) {
          throw new VpkPackageError('vpk-entry-range', `VPK entry “${filename}” preload data exceeds the configured limit.`)
        }
        const size = checkedAdd(preloadBytes, archiveLength, `VPK entry “${filename}”`)
        if (size > limits.maxEntryBytes) {
          throw new VpkPackageError('vpk-entry-range', `VPK entry “${filename}” (${size.toLocaleString()} bytes) exceeds the configured limit.`)
        }
        const preload = reader.bytes(preloadBytes, `preload data for “${filename}”`)
        const path = buildVpkPath(directory, filename, extension)

        let dataFile: File
        let dataBaseOffset: number
        if (archiveLength === 0) {
          // A preload-only entry need not have a selected external segment.
          dataFile = directoryFile
          dataBaseOffset = 0
        } else if (archiveIndex === DIRECTORY_ARCHIVE_INDEX) {
          dataFile = directoryFile
          dataBaseOffset = header.dataStart
          assertRange(offset, archiveLength, header.embeddedDataSize, path)
        } else {
          const segmentName = `${packageName}_${archiveIndex.toString().padStart(3, '0')}.vpk`
          const segment = fileIndex.get(segmentName.toLowerCase())
          if (!segment) {
            missingSegments.add(segmentName)
            // Continue parsing so all missing segments can be reported at once.
            dataFile = directoryFile
            dataBaseOffset = 0
          } else {
            dataFile = segment
            dataBaseOffset = 0
            assertRange(offset, archiveLength, dataFile.size, path)
          }
        }

        if (records.has(path)) {
          throw new VpkPackageError('vpk-duplicate-path', `VPK contains duplicate normalized path “${path}”.`, { path })
        }
        records.set(path, { path, size, crc32: crc, preloadBytes, archiveIndex, offset, preload, dataFile, dataBaseOffset })
      }
    }
  }

  if (!reader.done) {
    throw new VpkPackageError('vpk-invalid-tree', 'VPK tree contains bytes after its final terminator.')
  }
  if (missingSegments.size > 0) {
    const names = [...missingSegments].sort()
    throw new VpkPackageError('vpk-missing-segments', `The VPK is missing ${names.length === 1 ? 'archive segment' : 'archive segments'}: ${names.join(', ')}.`, { missingSegments: names })
  }
  return records
}

function buildVpkPath(directory: string, filename: string, extension: string): string {
  const safeDirectory = directory === ' ' ? '' : directory
  const safeExtension = extension === ' ' ? '' : extension
  const rawPath = `${safeDirectory ? `${safeDirectory}/` : ''}${filename}${safeExtension ? `.${safeExtension}` : ''}`
  try {
    return normalizeSourcePath(rawPath)
  } catch (error) {
    throw new VpkPackageError('vpk-path', `VPK contains unsafe path “${rawPath}”: ${String(error)}`, { path: rawPath })
  }
}

function packageNameFromDirectoryFile(name: string): string {
  const dirMatch = /^(.*)_dir\.vpk$/i.exec(name)
  if (dirMatch) return dirMatch[1]
  return name.replace(/\.vpk$/i, '')
}

function assertRange(offset: number, length: number, fileSize: number, path: string): void {
  if (checkedAdd(offset, length, `VPK entry “${path}”`) > fileSize) {
    throw new VpkPackageError('vpk-entry-range', `VPK entry “${path}” points outside its archive file.`, { path })
  }
}

function checkedAdd(left: number, right: number, context: string): number {
  const sum = left + right
  if (!Number.isSafeInteger(sum)) {
    throw new VpkPackageError('vpk-entry-range', `${context} exceeds the maximum safe file range.`)
  }
  return sum
}

async function readFileRange(file: File, offset: number, length: number, path: string): Promise<Uint8Array> {
  assertRange(offset, length, file.size, path)
  const buffer = await file.slice(offset, offset + length).arrayBuffer()
  if (buffer.byteLength !== length) {
    throw new VpkPackageError('vpk-entry-range', `Could not read the complete requested range for “${path}”.`, { path })
  }
  return new Uint8Array(buffer)
}

function joinBytes(preload: Uint8Array, archive: Uint8Array): Uint8Array {
  if (preload.byteLength === 0) return archive
  const combined = new Uint8Array(preload.byteLength + archive.byteLength)
  combined.set(preload)
  combined.set(archive, preload.byteLength)
  return combined
}

function formatCrc32(value: number): string {
  return `0x${value.toString(16).padStart(8, '0')}`
}

function formatBytes(value: number): string {
  if (value < MEBIBYTE) return `${Math.ceil(value / 1024).toLocaleString()} KiB`
  return `${(value / MEBIBYTE).toLocaleString(undefined, { maximumFractionDigits: 1 })} MiB`
}

const CRC32_TABLE = buildCrc32Table()

export function crc32(bytes: Uint8Array): number {
  return crc32Chunks(bytes)
}

function crc32Chunks(...chunks: readonly Uint8Array[]): number {
  let value = 0xffffffff
  for (const bytes of chunks) {
    for (const byte of bytes) value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8)
  }
  return (value ^ 0xffffffff) >>> 0
}

function buildCrc32Table(): Uint32Array {
  const table = new Uint32Array(256)
  for (let index = 0; index < table.length; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) === 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1
    table[index] = value >>> 0
  }
  return table
}

class TreeReader {
  #offset = 0
  readonly #decoder = new TextDecoder('utf-8', { fatal: true })
  readonly #bytes: Uint8Array

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes
  }

  get done(): boolean {
    return this.#offset === this.#bytes.byteLength
  }

  string(context: string): string {
    const start = this.#offset
    while (this.#offset < this.#bytes.byteLength && this.#bytes[this.#offset] !== 0) this.#offset += 1
    if (this.#offset === this.#bytes.byteLength) {
      throw new VpkPackageError('vpk-invalid-tree', `VPK ${context} string is missing its null terminator.`)
    }
    let value: string
    try {
      value = this.#decoder.decode(this.#bytes.subarray(start, this.#offset))
    } catch {
      throw new VpkPackageError('vpk-invalid-tree', `VPK ${context} string is not valid UTF-8.`)
    }
    this.#offset += 1
    return value
  }

  uint16(context: string): number {
    this.#ensure(2, context)
    const value = this.#bytes[this.#offset] | (this.#bytes[this.#offset + 1] << 8)
    this.#offset += 2
    return value
  }

  uint32(context: string): number {
    this.#ensure(4, context)
    const value = (
      this.#bytes[this.#offset]
      | (this.#bytes[this.#offset + 1] << 8)
      | (this.#bytes[this.#offset + 2] << 16)
      | (this.#bytes[this.#offset + 3] << 24)
    ) >>> 0
    this.#offset += 4
    return value
  }

  bytes(length: number, context: string): Uint8Array {
    this.#ensure(length, context)
    if (length === 0) return EMPTY_BYTES
    const value = this.#bytes.subarray(this.#offset, this.#offset + length)
    this.#offset += length
    return value
  }

  #ensure(length: number, context: string): void {
    if (this.#offset + length > this.#bytes.byteLength) {
      throw new VpkPackageError('vpk-invalid-tree', `VPK tree is truncated while reading ${context}.`)
    }
  }
}

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import zlib from 'node:zlib';

const BSP_LUMP_OFFSET = 8;
const BSP_LUMP_SIZE = 16;
const BSP_PAKFILE_LUMP = 40;
const ZIP_LOCAL_FILE_HEADER = 0x04034b50;
const ZIP_CENTRAL_FILE_HEADER = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;

function findEndOfCentralDirectory(data) {
  for (let offset = data.length - 22; offset >= 0; offset--) {
    if (data.readUInt32LE(offset) === ZIP_END_OF_CENTRAL_DIRECTORY) return offset;
  }
  throw new Error('BSP pakfile does not contain a ZIP directory');
}

function parseZipEntries(data) {
  const endOffset = findEndOfCentralDirectory(data);
  const entryCount = data.readUInt16LE(endOffset + 10);
  const directorySize = data.readUInt32LE(endOffset + 12);
  const directoryOffset = data.readUInt32LE(endOffset + 16);
  const directoryEnd = directoryOffset + directorySize;
  if (directoryEnd > data.length) throw new Error('BSP pakfile ZIP directory is truncated');

  const entries = [];
  let offset = directoryOffset;
  for (let index = 0; index < entryCount; index++) {
    if (offset + 46 > directoryEnd || data.readUInt32LE(offset) !== ZIP_CENTRAL_FILE_HEADER) {
      throw new Error('BSP pakfile ZIP entry is truncated');
    }
    const nameLength = data.readUInt16LE(offset + 28);
    const extraLength = data.readUInt16LE(offset + 30);
    const commentLength = data.readUInt16LE(offset + 32);
    const entryEnd = offset + 46 + nameLength + extraLength + commentLength;
    if (entryEnd > directoryEnd) throw new Error('BSP pakfile ZIP entry metadata is truncated');
    entries.push({
      name: data.toString('utf8', offset + 46, offset + 46 + nameLength),
      compression: data.readUInt16LE(offset + 10),
      compressedSize: data.readUInt32LE(offset + 20),
      uncompressedSize: data.readUInt32LE(offset + 24),
      localOffset: data.readUInt32LE(offset + 42),
    });
    offset = entryEnd;
  }
  return entries;
}

function decompressZipLzma(data, expectedSize) {
  // ZIP method 14 stores a 4-byte LZMA version, 5-byte properties block, then
  // the raw LZMA1 stream. xz can decode the raw stream when given those props.
  if (data.length < 9) throw new Error('BSP pakfile LZMA entry is truncated');
  const properties = data[4];
  const remainder = Math.floor(properties / 9);
  const lc = properties % 9;
  const lp = remainder % 5;
  const pb = Math.floor(remainder / 5);
  const dictionary = data.readUInt32LE(5);
  const args = [
    '--format=raw',
    '--decompress',
    '--stdout',
    `--lzma1=lc=${lc},lp=${lp},pb=${pb},dict=${dictionary}`,
  ];
  try {
    return execFileSync('xz', args, {
      input: data.subarray(9),
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: Math.max(expectedSize + 1024, 1024 * 1024),
    });
  } catch (error) {
    // xz reports an unterminated raw stream for Source's LZMA entries even
    // when it has already produced the complete declared payload.
    const output = error?.stdout;
    if (Buffer.isBuffer(output) && output.length >= expectedSize) return output.subarray(0, expectedSize);
    throw new Error(`Could not decompress BSP pakfile LZMA entry: ${error?.message ?? error}`);
  }
}

export function readBspPak(bspPath) {
  const bsp = fs.readFileSync(bspPath);
  const lumpOffset = BSP_LUMP_OFFSET + BSP_PAKFILE_LUMP * BSP_LUMP_SIZE;
  const pakOffset = bsp.readInt32LE(lumpOffset);
  const pakLength = bsp.readInt32LE(lumpOffset + 4);
  if (pakOffset <= 0 || pakLength <= 0 || pakOffset + pakLength > bsp.length) {
    throw new Error(`BSP pakfile lump is missing or invalid: ${bspPath}`);
  }
  const data = bsp.subarray(pakOffset, pakOffset + pakLength);
  return { data, entries: parseZipEntries(data) };
}

export function readBspPakEntry(data, entry) {
  if (entry.localOffset + 30 > data.length || data.readUInt32LE(entry.localOffset) !== ZIP_LOCAL_FILE_HEADER) {
    throw new Error(`BSP pakfile local header is invalid: ${entry.name}`);
  }
  const nameLength = data.readUInt16LE(entry.localOffset + 26);
  const extraLength = data.readUInt16LE(entry.localOffset + 28);
  const dataOffset = entry.localOffset + 30 + nameLength + extraLength;
  const dataEnd = dataOffset + entry.compressedSize;
  if (dataEnd > data.length) throw new Error(`BSP pakfile entry is truncated: ${entry.name}`);
  const compressed = data.subarray(dataOffset, dataEnd);
  let result;
  if (entry.compression === 0) result = Buffer.from(compressed);
  else if (entry.compression === 8) result = zlib.inflateRawSync(compressed);
  else if (entry.compression === 14) result = decompressZipLzma(compressed, entry.uncompressedSize);
  else throw new Error(`Unsupported BSP pakfile compression method ${entry.compression}: ${entry.name}`);
  if (result.length !== entry.uncompressedSize) {
    throw new Error(`BSP pakfile entry size mismatch: ${entry.name}`);
  }
  return result;
}

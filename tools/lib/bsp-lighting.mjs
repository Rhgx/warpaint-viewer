// Minimal Source BSP reader for compiled per-leaf HDR ambient cubes.
// Structures and lookup behavior mirror Source SDK 2013's bspfile.h and
// vrad/leaf_ambient_lighting.cpp.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const HEADER_LUMPS = 64;
const LUMP_PLANES = 1;
const LUMP_NODES = 5;
const LUMP_LEAFS = 10;
const LUMP_LEAF_AMBIENT_INDEX_HDR = 51;
const LUMP_LEAF_AMBIENT_LIGHTING_HDR = 55;
const LUMP_WORLDLIGHTS_HDR = 54;

function lumpInfo(bsp, index) {
  if (index < 0 || index >= HEADER_LUMPS) throw new Error(`Invalid BSP lump ${index}`);
  const offset = 8 + index * 16;
  return {
    fileOffset: bsp.readInt32LE(offset),
    fileLength: bsp.readInt32LE(offset + 4),
    version: bsp.readInt32LE(offset + 8),
    uncompressedSize: bsp.readInt32LE(offset + 12),
  };
}

function decompressSourceLzma(data, expectedSize) {
  if (data.toString('ascii', 0, 4) !== 'LZMA') return data;
  const actualSize = data.readUInt32LE(4);
  const compressedSize = data.readUInt32LE(8);
  const property = data[12];
  const lc = property % 9;
  const remainder = Math.floor(property / 9);
  const lp = remainder % 5;
  const pb = Math.floor(remainder / 5);
  const dictionarySize = data.readUInt32LE(13);
  const payload = data.subarray(17, 17 + compressedSize);
  let output;
  try {
    output = execFileSync('xz', [
      '--format=raw', '--decompress', '--stdout',
      `--lzma1=lc=${lc},lp=${lp},pb=${pb},dict=${dictionarySize}`,
    ], { input: payload, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: Math.max(actualSize * 2, 16 * 1024 * 1024) });
  } catch (error) {
    // Source writes raw LZMA with a known output size and no EOS marker. xz
    // reports "Unexpected end of input" after still producing the complete
    // payload, so accept that stdout only when it exactly matches the header.
    if (error.stdout?.length >= actualSize && error.stdout.length <= actualSize + 4) output = error.stdout.subarray(0, actualSize);
    else throw new Error(`Unable to decompress BSP lighting lump; xz returned ${error.stdout?.length ?? 0}/${actualSize} bytes (${error.message})`);
  }
  const targetSize = expectedSize || actualSize;
  if (output.length !== targetSize) throw new Error(`BSP lump decompressed to ${output.length}, expected ${targetSize}`);
  return output;
}

function readLump(bsp, index) {
  const info = lumpInfo(bsp, index);
  const stored = bsp.subarray(info.fileOffset, info.fileOffset + info.fileLength);
  return { ...info, data: decompressSourceLzma(stored, info.uncompressedSize) };
}

function findLeaf(position, planes, nodes) {
  let nodeIndex = 0;
  for (let depth = 0; depth < 65536; depth++) {
    const nodeOffset = nodeIndex * 32;
    if (nodeOffset < 0 || nodeOffset + 12 > nodes.length) throw new Error(`Invalid BSP node ${nodeIndex}`);
    const planeIndex = nodes.readInt32LE(nodeOffset);
    const planeOffset = planeIndex * 20;
    const distance = position[0] * planes.readFloatLE(planeOffset)
      + position[1] * planes.readFloatLE(planeOffset + 4)
      + position[2] * planes.readFloatLE(planeOffset + 8)
      - planes.readFloatLE(planeOffset + 12);
    const child = nodes.readInt32LE(nodeOffset + (distance >= 0 ? 4 : 8));
    if (child < 0) return -child - 1;
    nodeIndex = child;
  }
  throw new Error('BSP node traversal exceeded its safety limit');
}

function leafBounds(leaves, leafIndex) {
  const offset = leafIndex * 32;
  if (offset < 0 || offset + 32 > leaves.length) throw new Error(`Invalid BSP leaf ${leafIndex}`);
  return {
    mins: [leaves.readInt16LE(offset + 8), leaves.readInt16LE(offset + 10), leaves.readInt16LE(offset + 12)],
    maxs: [leaves.readInt16LE(offset + 14), leaves.readInt16LE(offset + 16), leaves.readInt16LE(offset + 18)],
  };
}

function decodeRgbExp32(data, offset) {
  const exponent = data.readInt8(offset + 3);
  const scale = 2 ** exponent;
  // ColorRGBExp32ToVector resolves to channel * 2^exponent.
  return [data[offset] * scale, data[offset + 1] * scale, data[offset + 2] * scale];
}

export function sampleBspAmbientCube(bspPath, position) {
  const bsp = fs.readFileSync(bspPath);
  if (bsp.toString('ascii', 0, 4) !== 'VBSP') throw new Error(`Not a Source BSP: ${bspPath}`);
  const planes = readLump(bsp, LUMP_PLANES).data;
  const nodes = readLump(bsp, LUMP_NODES).data;
  const leaves = readLump(bsp, LUMP_LEAFS).data;
  const indices = readLump(bsp, LUMP_LEAF_AMBIENT_INDEX_HDR).data;
  const samples = readLump(bsp, LUMP_LEAF_AMBIENT_LIGHTING_HDR).data;

  const requestedLeaf = findLeaf(position, planes, nodes);
  let sampleLeaf = requestedLeaf;
  let sampleCount = 0;
  let firstSample = 0;
  for (let hop = 0; hop < 128; hop++) {
    const indexOffset = sampleLeaf * 4;
    sampleCount = indices.readUInt16LE(indexOffset);
    firstSample = indices.readUInt16LE(indexOffset + 2);
    if (sampleCount > 0) break;
    sampleLeaf = firstSample;
  }
  if (!sampleCount) throw new Error(`No ambient lighting samples for BSP leaf ${requestedLeaf}`);

  const { mins, maxs } = leafBounds(leaves, sampleLeaf);
  const cube = Array.from({ length: 6 }, () => [0, 0, 0]);
  let totalWeight = 0;
  for (let i = 0; i < sampleCount; i++) {
    const offset = (firstSample + i) * 28;
    const samplePosition = [0, 1, 2].map((axis) => mins[axis] + (samples[offset + 24 + axis] / 255) * (maxs[axis] - mins[axis]));
    const distanceSquared = samplePosition.reduce((sum, value, axis) => sum + (value - position[axis]) ** 2, 0);
    const weight = 1 / (distanceSquared + 1);
    totalWeight += weight;
    for (let face = 0; face < 6; face++) {
      const color = decodeRgbExp32(samples, offset + face * 4);
      for (let channel = 0; channel < 3; channel++) cube[face][channel] += color[channel] * weight;
    }
  }
  for (const face of cube) for (let channel = 0; channel < 3; channel++) face[channel] /= totalWeight;

  return {
    source: 'LUMP_LEAF_AMBIENT_LIGHTING_HDR',
    position,
    requestedLeaf,
    sampleLeaf,
    sampleCount,
    // Source order: +X, -X, +Y, -Y, +Z, -Z; already linear RGB.
    cube: cube.map((face) => face.map((value) => Math.round(value * 1e6) / 1e6)),
  };
}

export function readBspWorldLights(bspPath) {
  const bsp = fs.readFileSync(bspPath);
  if (bsp.toString('ascii', 0, 4) !== 'VBSP') throw new Error(`Not a Source BSP: ${bspPath}`);
  const data = readLump(bsp, LUMP_WORLDLIGHTS_HDR).data;
  const lights = [];
  for (let offset = 0; offset + 88 <= data.length; offset += 88) {
    const vector = (at) => [data.readFloatLE(offset + at), data.readFloatLE(offset + at + 4), data.readFloatLE(offset + at + 8)];
    lights.push({
      origin: vector(0),
      intensity: vector(12),
      normal: vector(24),
      cluster: data.readInt32LE(offset + 36),
      type: data.readInt32LE(offset + 40),
      style: data.readInt32LE(offset + 44),
      stopdot: data.readFloatLE(offset + 48),
      stopdot2: data.readFloatLE(offset + 52),
      exponent: data.readFloatLE(offset + 56),
      radius: data.readFloatLE(offset + 60),
      constantAttenuation: data.readFloatLE(offset + 64),
      linearAttenuation: data.readFloatLE(offset + 68),
      quadraticAttenuation: data.readFloatLE(offset + 72),
      flags: data.readInt32LE(offset + 76),
    });
  }
  return lights;
}

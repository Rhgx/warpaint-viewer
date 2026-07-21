export interface VTFHeader {
  verMajor: number;
  verMinor: number;
  headerSize: number;
  width: number;
  height: number;
  flags: number;
  frames: number;
  firstFrame: number;
  highResFormat: number;
  mipCount: number;
  depth: number;
  faces: number;
  imageDataOffset: number;
  lowResFormat: number;
  lowResWidth: number;
  lowResHeight: number;
  lowResImageDataOffset: number | null;
  lowResImageDataSize: number;
  sampling: VTFSamplingMetadata;
}

export interface VTFSamplingMetadata {
  clampS: boolean;
  clampT: boolean;
  pointSample: boolean;
  trilinear: boolean;
  anisotropic: boolean;
  noMip: boolean;
  noLod: boolean;
  sRGB: boolean;
}

export interface DecodedVTF {
  width: number;
  height: number;
  rgba: Uint8Array;
  format: number;
}

export const VTF_FORMAT: Readonly<Record<string, number>>;
export function getVTFSamplingMetadata(flags: number): VTFSamplingMetadata;
export function parseVTFHeader(input: Uint8Array | ArrayBuffer): VTFHeader;
export function decodeVTF(input: Uint8Array | ArrayBuffer): DecodedVTF;
export function decodeVTFFrame(input: Uint8Array | ArrayBuffer, frameIndex: number): DecodedVTF;
export function decodeVTFAllFrames(input: Uint8Array | ArrayBuffer): DecodedVTF[];
export function decodeVTFCubemap(input: Uint8Array | ArrayBuffer): DecodedVTF[];
export function parseVTFSpriteSheet(input: Uint8Array | ArrayBuffer): unknown | null;

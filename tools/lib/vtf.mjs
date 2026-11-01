// Node facade over vtf-core.mjs that returns Buffer results, for callers that use Buffer#copy.
import {
  decodeVTF as decodeCoreVTF,
  decodeVTFAllFrames as decodeCoreVTFAllFrames,
  decodeVTFCubemap as decodeCoreVTFCubemap,
  parseVTFHeader,
  parseVTFSpriteSheet,
} from './vtf-core.mjs';

export { parseVTFHeader, parseVTFSpriteSheet };

function nodeResult(decoded) {
  return {
    ...decoded,
    rgba: Buffer.from(decoded.rgba.buffer, decoded.rgba.byteOffset, decoded.rgba.byteLength),
  };
}

export function decodeVTF(input) { return nodeResult(decodeCoreVTF(input)); }
export function decodeVTFAllFrames(input) { return decodeCoreVTFAllFrames(input).map(nodeResult); }
export function decodeVTFCubemap(input) { return decodeCoreVTFCubemap(input).map(nodeResult); }

// Node-tool entry point. The parsing and decoding implementation is
// platform-neutral; this thin facade retains Buffer results for existing Node
// callers that use Buffer#copy while the browser consumes Uint8Array directly.
import {
  VTF_FORMAT,
  decodeVTF as decodeCoreVTF,
  decodeVTFAllFrames as decodeCoreVTFAllFrames,
  decodeVTFCubemap as decodeCoreVTFCubemap,
  decodeVTFFrame as decodeCoreVTFFrame,
  getVTFSamplingMetadata,
  parseVTFHeader,
  parseVTFSpriteSheet,
} from './vtf-core.mjs';

export { VTF_FORMAT, getVTFSamplingMetadata, parseVTFHeader, parseVTFSpriteSheet };

function nodeResult(decoded) {
  return {
    ...decoded,
    rgba: Buffer.from(decoded.rgba.buffer, decoded.rgba.byteOffset, decoded.rgba.byteLength),
  };
}

export function decodeVTF(input) { return nodeResult(decodeCoreVTF(input)); }
export function decodeVTFFrame(input, frameIndex) { return nodeResult(decodeCoreVTFFrame(input, frameIndex)); }
export function decodeVTFAllFrames(input) { return decodeCoreVTFAllFrames(input).map(nodeResult); }
export function decodeVTFCubemap(input) { return decodeCoreVTFCubemap(input).map(nodeResult); }

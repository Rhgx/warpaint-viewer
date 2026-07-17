// Minimal binary DMX (Datamodel Exchange) reader for Valve's .pcf particle files.
//
// PCF files start with a null-terminated ASCII header line, e.g.:
//   <!-- dmx encoding binary 2 format pcf 1 -->\n\0
// followed by the binary payload. This module supports binary encoding version 2, which is what
// TF2's weapon_unusual_*.pcf files use (verified against the actual bytes: a uint16 string-table
// count, uint16 string indices for element type names and attribute names, and inline
// null-terminated strings for both element names and string-typed attribute values). Encoding
// versions 1 and 3-5 use different index widths and/or string tables (see Valve's dmxserializers)
// and are not implemented here; parsePCF throws a clear error if it encounters one.

const ATTR_TYPE = {
  ELEMENT: 1, INT: 2, FLOAT: 3, BOOL: 4, STRING: 5, BINARY: 6, TIME: 7, COLOR: 8,
  VECTOR2: 9, VECTOR3: 10, VECTOR4: 11, QANGLE: 12, QUATERNION: 13, MATRIX: 14,
};
const ARRAY_TYPE_BASE = 14; // array type N (15..28) holds scalar type (N - 14)

export function parsePCF(buf) {
  const headerEnd = buf.indexOf(0);
  if (headerEnd < 0) throw new Error('PCF: no null-terminated header found');
  const header = buf.toString('ascii', 0, headerEnd);
  const m = header.match(/dmx encoding binary (\d+) format pcf (\d+)/);
  if (!m) throw new Error(`PCF: unrecognized DMX header: ${JSON.stringify(header)}`);
  const encodingVersion = Number(m[1]);
  const formatVersion = Number(m[2]);
  if (encodingVersion !== 2) {
    throw new Error(`PCF: unsupported DMX binary encoding version ${encodingVersion} (only version 2 is implemented; header was ${JSON.stringify(header)})`);
  }

  let p = headerEnd + 1;
  const len = buf.length;
  function need(n) {
    if (p + n > len) throw new Error(`PCF: unexpected end of file at offset ${p} (need ${n} more bytes of ${len})`);
  }
  function readCString() {
    const start = p;
    while (p < len && buf[p] !== 0) p++;
    need(1);
    const s = buf.toString('utf8', start, p);
    p++;
    return s;
  }

  // String dictionary: uint16 count, then that many null-terminated strings.
  need(2);
  const strCount = buf.readUInt16LE(p); p += 2;
  const strings = new Array(strCount);
  for (let i = 0; i < strCount; i++) strings[i] = readCString();
  function str(idx) {
    if (idx < 0 || idx >= strings.length) throw new Error(`PCF: string index ${idx} out of range (table has ${strings.length})`);
    return strings[idx];
  }

  // Element headers: int32 count, then per element: uint16 type-name string index,
  // inline null-terminated name, 16-byte GUID.
  need(4);
  const elemCount = buf.readInt32LE(p); p += 4;
  const elements = new Array(elemCount);
  for (let i = 0; i < elemCount; i++) {
    need(2);
    const typeIdx = buf.readUInt16LE(p); p += 2;
    const type = str(typeIdx);
    const name = readCString();
    need(16);
    const guid = buf.subarray(p, p + 16).toString('hex'); p += 16;
    elements[i] = { type, name, guid, attributes: {} };
  }

  function readScalar(attrType) {
    switch (attrType) {
      case ATTR_TYPE.ELEMENT: {
        need(4);
        const idx = buf.readInt32LE(p); p += 4;
        return idx >= 0 && idx < elements.length ? elements[idx] : null;
      }
      case ATTR_TYPE.INT: { need(4); const v = buf.readInt32LE(p); p += 4; return v; }
      case ATTR_TYPE.FLOAT: { need(4); const v = buf.readFloatLE(p); p += 4; return v; }
      case ATTR_TYPE.BOOL: { need(1); const v = buf.readUInt8(p); p += 1; return !!v; }
      case ATTR_TYPE.STRING: return readCString();
      case ATTR_TYPE.BINARY: {
        need(4);
        const blen = buf.readInt32LE(p); p += 4;
        need(blen);
        p += blen;
        return { binary: blen };
      }
      case ATTR_TYPE.TIME: { need(4); const v = buf.readInt32LE(p); p += 4; return v / 10000; }
      case ATTR_TYPE.COLOR: { need(4); const v = [buf[p], buf[p + 1], buf[p + 2], buf[p + 3]]; p += 4; return v; }
      case ATTR_TYPE.VECTOR2: { need(8); const v = [buf.readFloatLE(p), buf.readFloatLE(p + 4)]; p += 8; return v; }
      case ATTR_TYPE.VECTOR3: { need(12); const v = [buf.readFloatLE(p), buf.readFloatLE(p + 4), buf.readFloatLE(p + 8)]; p += 12; return v; }
      case ATTR_TYPE.VECTOR4: { need(16); const v = [buf.readFloatLE(p), buf.readFloatLE(p + 4), buf.readFloatLE(p + 8), buf.readFloatLE(p + 12)]; p += 16; return v; }
      case ATTR_TYPE.QANGLE: { need(12); const v = [buf.readFloatLE(p), buf.readFloatLE(p + 4), buf.readFloatLE(p + 8)]; p += 12; return v; }
      case ATTR_TYPE.QUATERNION: { need(16); const v = [buf.readFloatLE(p), buf.readFloatLE(p + 4), buf.readFloatLE(p + 8), buf.readFloatLE(p + 12)]; p += 16; return v; }
      case ATTR_TYPE.MATRIX: {
        need(64);
        const v = new Array(16);
        for (let i = 0; i < 16; i++) { v[i] = buf.readFloatLE(p); p += 4; }
        return v;
      }
      default:
        throw new Error(`PCF: unknown attribute type ${attrType} at offset ${p}`);
    }
  }

  function readAttrValue(attrType) {
    if (attrType > ARRAY_TYPE_BASE) {
      const baseType = attrType - ARRAY_TYPE_BASE;
      need(4);
      const count = buf.readInt32LE(p); p += 4;
      const arr = new Array(count);
      for (let i = 0; i < count; i++) arr[i] = readScalar(baseType);
      return arr;
    }
    return readScalar(attrType);
  }

  // Attribute blocks: per element, int32 attribute count, then per attribute: uint16 name string
  // index, byte type, value.
  for (let i = 0; i < elemCount; i++) {
    need(4);
    const attrCount = buf.readInt32LE(p); p += 4;
    for (let a = 0; a < attrCount; a++) {
      need(3);
      const nameIdx = buf.readUInt16LE(p); p += 2;
      const type = buf.readUInt8(p); p += 1;
      const value = readAttrValue(type);
      elements[i].attributes[str(nameIdx)] = value;
    }
  }

  // Some shipped .pcf files (e.g. weapon_unusual_cool.pcf) carry a large trailing run of ASCII
  // space (0x20) padding after the real DMX content - not a parser bug, just inert filler baked
  // into the asset on disk. Tolerate a well-formed all-space/all-null tail; anything else past
  // the parsed content means the structure was actually misread.
  if (p !== len) {
    const tail = buf.subarray(p);
    const isPadding = tail.every((byte) => byte === 0x20 || byte === 0x00);
    if (!isPadding) {
      throw new Error(`PCF: parse did not consume the whole file (consumed ${p} of ${len} bytes) - parser is likely wrong for this file`);
    }
  }

  return { encodingVersion, formatVersion, strings, elements, root: elements[0] };
}

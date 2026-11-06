import { LAYOUT_FILE_EXTENSION } from '../../showcase/boardFileName';
import { parseLayoutSlot, type SavedBoard } from './layoutSlots';
import type { ShowcaseSettings } from './showcaseSettings';
import type { AppliedLayout, ShowcaseItem, ShowcasePaint } from '../../showcase/showcaseTypes';
import type { LayoutPacking } from '../../showcase/layouts';

// .pegboard: "WPLY", u8 version, varint bodyLength, body, then (varint pictureLength, picture bytes)*.
// The body is zlib, whose checksum catches damage, over a string table and varints that index it.
// Pictures stay as they are, being compressed already.
// Files come from other people, so reading caps every size first and ends in the local save's checks.

export { LAYOUT_FILE_EXTENSION };

const MAGIC = [0x57, 0x50, 0x4c, 0x59];
const FORMAT_VERSION = 1;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
/** Far beyond a full board, and small enough that a decompression bomb stops early. */
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_STRING_BYTES = 4096;
const MAX_ITEMS = 512;
const MAX_POSITION = 2000;
/** Twice the largest size that can be typed, so a file cannot make the fit checks run away. */
const MAX_SCALE = 10;
const MAX_WEAR = 64;

/** Append only: a file stores these by position. Null is a setting that no longer exists, whose place older files still hold. */
const SETTINGS_ORDER = [
  'snapToGrid', 'grid', 'keepApart', 'spacing', 'keepInside', 'rotationSnap', 'showFootprints', 'lightAzimuth', 'lightElevation',
  'shadows', 'shadow', 'background', 'outputWidth', null, 'poseHandles', 'weaponSize',
] as const satisfies readonly (keyof ShowcaseSettings | null)[];
const PACKINGS: readonly (LayoutPacking | undefined)[] = [undefined, 'size', 'order', 'composed'];

export interface SharedLayout extends SavedBoard {
  name: string;
}

/** What went wrong with a file, in words fit to show the person who opened it. */
export class LayoutFileError extends Error {}

const damaged = () => new LayoutFileError('This .pegboard file is damaged. Ask for a new copy.');

class Writer {
  #bytes = new Uint8Array(1024);
  #length = 0;

  #reserve(extra: number): void {
    if (this.#length + extra <= this.#bytes.length) return;
    const grown = new Uint8Array(Math.max(this.#bytes.length * 2, this.#length + extra));
    grown.set(this.#bytes.subarray(0, this.#length));
    this.#bytes = grown;
  }

  byte(value: number): void {
    this.#reserve(1);
    this.#bytes[this.#length++] = value;
  }

  /** Division rather than bit shifts, which would cut values off at 32 bits. */
  varint(value: number): void {
    let rest = value;
    while (rest >= 0x80) {
      this.byte((rest % 0x80) | 0x80);
      rest = Math.floor(rest / 0x80);
    }
    this.byte(rest);
  }

  /** Grid positions and whole angles fit a varint in eighths; anything finer keeps all 64 bits, so nothing moves. */
  number(value: number): void {
    const eighths = value * 8;
    if (Number.isInteger(eighths) && Math.abs(eighths) < 2 ** 40) {
      const zigzag = eighths >= 0 ? eighths * 2 : -eighths * 2 - 1;
      this.varint(zigzag * 2);
      return;
    }
    this.varint(1);
    this.#reserve(8);
    new DataView(this.#bytes.buffer).setFloat64(this.#length, value, true);
    this.#length += 8;
  }

  bytes(value: Uint8Array): void {
    this.#reserve(value.length);
    this.#bytes.set(value, this.#length);
    this.#length += value.length;
  }

  finish(): Uint8Array {
    return this.#bytes.subarray(0, this.#length);
  }
}

class Reader {
  readonly #bytes: Uint8Array;
  #at: number;

  constructor(bytes: Uint8Array, at = 0) {
    this.#bytes = bytes;
    this.#at = at;
  }

  get at(): number {
    return this.#at;
  }

  get done(): boolean {
    return this.#at >= this.#bytes.length;
  }

  byte(): number {
    if (this.#at >= this.#bytes.length) throw damaged();
    return this.#bytes[this.#at++];
  }

  varint(): number {
    let value = 0;
    let scale = 1;
    for (;;) {
      const byte = this.byte();
      value += (byte & 0x7f) * scale;
      if (byte < 0x80) break;
      scale *= 0x80;
      if (scale > Number.MAX_SAFE_INTEGER) throw damaged();
    }
    if (!Number.isSafeInteger(value)) throw damaged();
    return value;
  }

  /** A count of things each at least `each` bytes long; checked against what is left, so a lying count allocates nothing. */
  count(each = 1): number {
    const count = this.varint();
    if (count * each > this.#bytes.length - this.#at) throw damaged();
    return count;
  }

  number(): number {
    const tagged = this.varint();
    if (tagged === 1) {
      const end = this.#at + 8;
      if (end > this.#bytes.length) throw damaged();
      const value = new DataView(this.#bytes.buffer, this.#bytes.byteOffset).getFloat64(this.#at, true);
      this.#at = end;
      if (!Number.isFinite(value)) throw damaged();
      return value;
    }
    if (tagged % 2 !== 0) throw damaged();
    const zigzag = tagged / 2;
    return (zigzag % 2 === 0 ? zigzag / 2 : -(zigzag + 1) / 2) / 8;
  }

  bytes(length: number): Uint8Array {
    const end = this.#at + length;
    if (end > this.#bytes.length) throw damaged();
    const slice = this.#bytes.subarray(this.#at, end);
    this.#at = end;
    return slice;
  }
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes.slice()]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Stops as soon as the output passes the limit, instead of inflating all of a hostile file first. */
async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const reader = new Blob([bytes.slice()]).stream().pipeThrough(new DecompressionStream('deflate')).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_BODY_BYTES) throw damaged();
      chunks.push(value);
    }
  } catch {
    // The stream's own errors say nothing useful: bad data, a failed checksum or a cut-off file.
    throw damaged();
  } finally {
    void reader.cancel().catch(() => undefined);
  }
  const joined = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    joined.set(chunk, at);
    at += chunk.length;
  }
  return joined;
}

function encodeBody(layout: SharedLayout, pictures: ReadonlyMap<string, number>): Uint8Array {
  const strings = new Map<string, number>();
  const ref = (value: string) => {
    let index = strings.get(value);
    if (index === undefined) {
      index = strings.size;
      strings.set(value, index);
    }
    return index;
  };
  const paints = new Map<string, number>();
  const paintWriter = new Writer();
  const paintRef = (paint: ShowcasePaint) => {
    const key = JSON.stringify([paint.kitId, paint.kitName, paint.team, paint.wearIndex, paint.seed]);
    let index = paints.get(key);
    if (index === undefined) {
      index = paints.size;
      paints.set(key, index);
      paintWriter.number(paint.kitId);
      paintWriter.varint(ref(paint.kitName));
      paintWriter.byte(paint.team === 'blu' ? 1 : 0);
      paintWriter.varint(paint.wearIndex);
      paintWriter.varint(ref(paint.seed));
    }
    return index;
  };

  const board = new Writer();
  board.varint(ref(layout.name));
  for (const key of SETTINGS_ORDER) {
    const value = key === null ? true : layout.settings[key];
    if (typeof value === 'boolean') board.byte(value ? 1 : 0);
    else if (typeof value === 'number') {
      board.byte(2);
      board.number(value);
    } else {
      board.byte(3);
      board.varint(ref(value));
    }
  }
  board.varint(layout.items.length);
  for (const item of layout.items) {
    board.varint(ref(item.weaponKey));
    board.varint(ref(item.weaponName));
    board.varint(paintRef(item.paint));
    board.byte((item.flipped ? 1 : 0) | (item.hidden ? 2 : 0) | (item.part !== null ? 4 : 0) | (item.image ? 8 : 0));
    for (const value of [item.x, item.y, item.roll, item.tilt, item.turn, item.scale]) board.number(value);
    const pose = Object.entries(item.pose);
    board.varint(pose.length);
    for (const [control, angle] of pose) {
      board.varint(ref(control));
      board.number(angle);
    }
    if (item.part !== null) board.varint(ref(item.part));
    board.varint(item.hiddenParts.length);
    for (const part of item.hiddenParts) board.varint(ref(part));
    if (item.image) {
      board.varint(pictures.get(item.image.assetId) ?? 0);
      board.number(item.image.aspect);
    }
  }
  const { layout: applied } = layout;
  board.byte(applied ? 1 | (applied.inward ? 2 : 0) | (applied.upright ? 4 : 0) | (applied.logoSpace ? 8 : 0) : 0);
  if (applied) {
    board.byte(PACKINGS.indexOf(applied.pack));
    board.varint(applied.rows.length);
    for (const row of applied.rows) {
      board.varint(row.length);
      for (const slot of row) {
        board.varint(ref(slot.weaponKey));
        board.varint(paintRef(slot.paint));
      }
    }
  }
  board.varint(layout.featured === null ? 0 : ref(layout.featured) + 1);
  board.varint(layout.pairs.length);
  for (const pair of layout.pairs) board.varint(ref(pair));

  const encoder = new TextEncoder();
  const body = new Writer();
  body.varint(strings.size);
  for (const value of strings.keys()) {
    const bytes = encoder.encode(value);
    body.varint(bytes.length);
    body.bytes(bytes);
  }
  body.varint(paints.size);
  body.bytes(paintWriter.finish());
  body.bytes(board.finish());
  return body.finish();
}

/** Builds the file. `readPicture` gives a picture's bytes; items whose picture is gone are left out and counted. */
export async function writeLayoutFile(layout: SharedLayout, readPicture: (assetId: string) => Promise<Blob | null>): Promise<{ file: Blob; missing: number }> {
  const assetIds = [...new Set(layout.items.flatMap((item) => (item.image ? [item.image.assetId] : [])))];
  const blobs = await Promise.all(assetIds.map(readPicture));
  const pictures = new Map<string, number>();
  const kept: Blob[] = [];
  assetIds.forEach((assetId, index) => {
    const blob = blobs[index];
    if (!blob) return;
    pictures.set(assetId, kept.length);
    kept.push(blob);
  });
  const items = layout.items.filter((item) => !item.image || pictures.has(item.image.assetId));
  const compressed = await deflate(encodeBody({ ...layout, items }, pictures));
  const head = new Writer();
  for (const byte of MAGIC) head.byte(byte);
  head.byte(FORMAT_VERSION);
  head.varint(compressed.length);
  head.bytes(compressed);
  const parts: BlobPart[] = [head.finish().slice()];
  for (const blob of kept) {
    const length = new Writer();
    length.varint(blob.size);
    parts.push(length.finish().slice(), blob);
  }
  return { file: new Blob(parts, { type: 'application/octet-stream' }), missing: layout.items.length - items.length };
}

function decodeBody(bytes: Uint8Array, pictureCount: number): unknown {
  const reader = new Reader(bytes);
  const decoder = new TextDecoder();
  const strings: string[] = [];
  const stringCount = reader.count();
  for (let index = 0; index < stringCount; index += 1) {
    const length = reader.varint();
    if (length > MAX_STRING_BYTES) throw damaged();
    strings.push(decoder.decode(reader.bytes(length)));
  }
  const string = () => {
    const value = strings[reader.varint()];
    if (value === undefined) throw damaged();
    return value;
  };
  const paints: ShowcasePaint[] = [];
  const paintCount = reader.count(4);
  for (let index = 0; index < paintCount; index += 1) {
    const kitId = reader.number();
    const kitName = string();
    const team = reader.byte() === 1 ? 'blu' : 'red';
    const wearIndex = reader.varint();
    const seed = string();
    // Seeds become BigInts when painted, which throw on anything else.
    if (wearIndex > MAX_WEAR || !/^\d{1,20}$/.test(seed)) throw damaged();
    paints.push({ kitId, kitName, team, wearIndex, seed });
  }
  const paint = () => {
    const value = paints[reader.varint()];
    if (!value) throw damaged();
    return value;
  };

  const name = string();
  const settings: Record<string, unknown> = {};
  for (const key of SETTINGS_ORDER) {
    const tag = reader.byte();
    if (tag > 3) throw damaged();
    const value = tag <= 1 ? tag === 1 : tag === 2 ? reader.number() : string();
    if (key !== null) settings[key] = value;
  }
  const itemCount = reader.count(10);
  if (itemCount > MAX_ITEMS) throw new LayoutFileError('This .pegboard file holds too many items to open.');
  const items: ShowcaseItem[] = [];
  for (let index = 0; index < itemCount; index += 1) {
    const weaponKey = string();
    const weaponName = string();
    const itemPaint = paint();
    const flags = reader.byte();
    const [x, y, roll, tilt, turn, scale] = [reader.number(), reader.number(), reader.number(), reader.number(), reader.number(), reader.number()];
    if (Math.abs(x) > MAX_POSITION || Math.abs(y) > MAX_POSITION || scale > MAX_SCALE) throw damaged();
    const pose: Record<string, number> = {};
    const poseCount = reader.count(2);
    for (let control = 0; control < poseCount; control += 1) {
      const key = string();
      Object.defineProperty(pose, key, { value: reader.number(), enumerable: true, writable: true, configurable: true });
    }
    const part = flags & 4 ? string() : null;
    const hiddenParts: string[] = [];
    const hiddenCount = reader.count();
    for (let hidden = 0; hidden < hiddenCount; hidden += 1) hiddenParts.push(string());
    let image: ShowcaseItem['image'];
    if (flags & 8) {
      const picture = reader.varint();
      if (picture >= pictureCount) throw damaged();
      image = { assetId: pictureRef(picture), aspect: reader.number() };
    }
    items.push({
      id: `item-${index + 1}`, weaponKey, weaponName, paint: itemPaint, x, y, roll, tilt, turn, flipped: (flags & 1) !== 0, scale, hidden: (flags & 2) !== 0, pose, part, hiddenParts, ...(image ? { image } : {}),
    });
  }
  const layoutFlags = reader.byte();
  let layout: AppliedLayout | null = null;
  if (layoutFlags & 1) {
    const packIndex = reader.byte();
    if (packIndex >= PACKINGS.length) throw damaged();
    const rows: AppliedLayout['rows'] = [];
    const rowCount = reader.count();
    for (let row = 0; row < rowCount; row += 1) {
      const slots: AppliedLayout['rows'][number] = [];
      const slotCount = reader.count(2);
      for (let slot = 0; slot < slotCount; slot += 1) {
        const weaponKey = string();
        slots.push({ weaponKey, paint: paint() });
      }
      rows.push(slots);
    }
    layout = { rows, pack: PACKINGS[packIndex], inward: (layoutFlags & 2) !== 0, upright: (layoutFlags & 4) !== 0, logoSpace: (layoutFlags & 8) !== 0 };
  }
  const featuredRef = reader.varint();
  const featured = featuredRef === 0 ? null : strings[featuredRef - 1] ?? null;
  const pairs: string[] = [];
  const pairCount = reader.count();
  for (let pair = 0; pair < pairCount; pair += 1) pairs.push(string());
  if (!reader.done) throw damaged();
  return { version: 1, savedAt: 0, name, items, settings, layout, featured, pairs };
}

/** Stands in for a picture's asset id until the importer has stored the picture and knows its real one. */
const pictureRef = (index: number) => `file-picture-${index}`;
export const pictureIndex = (assetId: string) => Number(assetId.slice('file-picture-'.length));

/** Reads a file and checks all of it. Rejects with a LayoutFileError when it cannot be used. Pictures are not decoded here. */
export async function readLayoutFile(file: Blob): Promise<{ layout: SharedLayout; pictures: Blob[] }> {
  if (file.size > MAX_FILE_BYTES) throw new LayoutFileError('This file is too large to be a .pegboard file.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length < MAGIC.length + 1 || MAGIC.some((byte, index) => bytes[index] !== byte)) throw new LayoutFileError('Not a .pegboard file.');
  if (bytes[MAGIC.length] > FORMAT_VERSION) throw new LayoutFileError('This board was saved by a newer version. Refresh the page and try again.');
  const reader = new Reader(bytes, MAGIC.length + 1);
  const compressed = reader.bytes(reader.varint());
  const pictures: Blob[] = [];
  while (!reader.done) {
    const length = reader.varint();
    const start = reader.at;
    reader.bytes(length);
    pictures.push(file.slice(start, start + length));
  }
  const decoded = decodeBody(await inflate(compressed), pictures.length);
  const slot = parseLayoutSlot(decoded);
  if (!slot) throw damaged();
  return { layout: { name: slot.name, items: slot.items, settings: slot.settings, layout: slot.layout, featured: slot.featured, pairs: slot.pairs }, pictures };
}

/** A file name people can recognise once it lands in their downloads. */
export function layoutFileName(name: string): string {
  const safe = name.replace(/[^\p{L}\p{N} _-]+/gu, '').trim();
  return `${safe || 'showcase-layout'}${LAYOUT_FILE_EXTENSION}`;
}

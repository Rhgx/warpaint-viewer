import { decodeVTF, parseVTFHeader } from '../../tools/lib/vtf-core.mjs';
import type { TextureMetadata } from '../data/types';
import type { SourceDiagnostic, SourcePackage } from './contracts';
import { sourcePathExtension, sourceTextureCandidates, sourceTextureIdentity } from './paths';

export interface SourceTextureProviderSnapshot {
  package: SourcePackage | null;
  generation: number;
  usedPaths: ReadonlySet<string>;
  fallbackIdentities: ReadonlySet<string>;
  diagnostics: readonly SourceDiagnostic[];
}

const MAX_DECODED_PIXELS = 16 * 1024 * 1024;

/** A single lazy Source-package layer over the normal built-in URL resolver. */
export class SourceTextureProvider {
  #package: SourcePackage | null = null;
  #generation = 0;
  #urls = new Map<string, string>();
  #metadata = new Map<string, Partial<TextureMetadata>>();
  #loads = new Map<string, Promise<string>>();
  #usedPaths = new Set<string>();
  #fallbackIdentities = new Set<string>();
  #diagnostics: SourceDiagnostic[] = [];
  private readonly fallback: (ref: string) => string;
  private readonly onChange: (() => void) | undefined;

  constructor(fallback: (ref: string) => string, onChange?: () => void) {
    this.fallback = fallback;
    this.onChange = onChange;
  }

  get generation(): number { return this.#generation; }
  get package(): SourcePackage | null { return this.#package; }

  snapshot(): SourceTextureProviderSnapshot {
    return { package: this.#package, generation: this.#generation, usedPaths: this.#usedPaths, fallbackIdentities: this.#fallbackIdentities, diagnostics: this.#diagnostics };
  }

  /** Sampling flags from an already-decoded VTF, if this Source path won. */
  metadataFor(ref: string): Partial<TextureMetadata> | undefined {
    const pkg = this.#package;
    if (!pkg) return undefined;
    try {
      const path = sourceTextureCandidates(ref).find((candidate) => pkg.has(candidate));
      return path ? this.#metadata.get(path) : undefined;
    } catch { return undefined; }
  }

  mount(next: SourcePackage, diagnostics: readonly SourceDiagnostic[] = []): void {
    const previous = this.#package;
    this.#generation += 1;
    this.#package = next;
    this.#diagnostics = [...diagnostics];
    this.#clearTransientState();
    previous?.dispose();
    this.onChange?.();
  }

  unmount(): void {
    const previous = this.#package;
    if (!previous) return;
    this.#generation += 1;
    this.#package = null;
    this.#diagnostics = [];
    this.#clearTransientState();
    previous.dispose();
    this.onChange?.();
  }

  dispose(): void { this.unmount(); this.#clearTransientState(); }

  async resolve(ref: string): Promise<string> {
    return this.#resolve(ref, true);
  }

  /**
   * Resolve a thumbnail without treating it as an asset consumed by the active
   * recipe. The workbench lists all wear/team slots, many of which are not
   * relevant to the currently composed paint.
   */
  async resolvePreview(ref: string): Promise<string> {
    return this.#resolve(ref, false);
  }

  async #resolve(ref: string, consume: boolean): Promise<string> {
    // Data URLs are individual edits and therefore precede the mounted package.
    if (ref.startsWith('data:') || ref.startsWith('blob:') || /^https?:/i.test(ref)) return ref;
    const pkg = this.#package;
    if (!pkg) return this.fallback(ref);
    let identity: string;
    let candidates: string[];
    try { identity = sourceTextureIdentity(ref); candidates = sourceTextureCandidates(ref); }
    catch { return this.fallback(ref); }
    const path = candidates.find((candidate) => pkg.has(candidate));
    if (!path) {
      if (consume && !this.#fallbackIdentities.has(identity)) { this.#fallbackIdentities.add(identity); this.onChange?.(); }
      return this.fallback(ref);
    }
    const key = `${this.#generation}:${path}`;
    const cached = this.#loads.get(key);
    if (cached) {
      const url = await cached;
      if (consume) this.#recordUsed(path);
      return url;
    }
    const generation = this.#generation;
    const load = this.#load(pkg, path, generation, ref);
    this.#loads.set(key, load);
    const url = await load;
    if (consume) this.#recordUsed(path);
    return url;
  }

  #clearTransientState(): void {
    for (const url of this.#urls.values()) URL.revokeObjectURL(url);
    this.#urls.clear(); this.#metadata.clear(); this.#loads.clear(); this.#usedPaths.clear(); this.#fallbackIdentities.clear();
  }

  async #load(pkg: SourcePackage, path: string, generation: number, fallbackRef: string): Promise<string> {
    try {
      const bytes = await pkg.read(path);
      if (generation !== this.#generation || pkg !== this.#package) throw new Error('Source package changed while this texture was loading.');
      const extension = sourcePathExtension(path);
      if (!extension) throw new Error('Package entry has no supported texture extension.');
      const decoded = await decodePackageTexture(bytes, extension);
      const url = decoded.url;
      if (generation !== this.#generation || pkg !== this.#package) { URL.revokeObjectURL(url); throw new Error('Source package changed while this texture was decoding.'); }
      this.#urls.set(path, url);
      if (decoded.metadata) this.#metadata.set(path, decoded.metadata);
      return url;
    } catch (cause) {
      // Removed/replaced packages must be completely inert. In particular, a
      // late read may not attach a diagnostic to the package that replaced it.
      if (generation !== this.#generation || pkg !== this.#package) throw cause;
      const message = cause instanceof Error ? cause.message : 'Could not decode this package texture.';
      if (!this.#diagnostics.some((entry) => entry.id === `decode:${path}`)) {
        this.#diagnostics.push({ id: `decode:${path}`, level: 'warning', message: 'Could not use package texture; the built-in asset was used instead.', detail: `${path}: ${message}` });
        this.onChange?.();
      }
      return this.fallback(fallbackRef);
    }
  }

  #recordUsed(path: string): void {
    if (this.#usedPaths.has(path)) return;
    this.#usedPaths.add(path);
    this.onChange?.();
  }
}

async function decodePackageTexture(bytes: Uint8Array, extension: string): Promise<{ url: string; metadata?: Partial<TextureMetadata> }> {
  if (extension === 'vtf') {
    const header = parseVTFHeader(bytes);
    if (!Number.isSafeInteger(header.width * header.height) || header.width * header.height > MAX_DECODED_PIXELS) throw new Error(`VTF dimensions ${header.width} x ${header.height} exceed the 16 megapixel limit.`);
    const decoded = decodeVTF(bytes);
    return { url: URL.createObjectURL(new Blob([toArrayBuffer(rgbaPng(decoded.rgba, decoded.width, decoded.height))], { type: 'image/png' })), metadata: header.sampling };
  }
  if (extension === 'tga') {
    const { TGALoader } = await import('three/addons/loaders/TGALoader.js');
    const parsed = new TGALoader().parse(toArrayBuffer(bytes));
    if (!parsed.data || !parsed.width || !parsed.height || parsed.width * parsed.height > MAX_DECODED_PIXELS) throw new Error('TGA has invalid or oversized pixel data.');
    return { url: URL.createObjectURL(new Blob([toArrayBuffer(rgbaPng(Uint8Array.from(parsed.data as ArrayLike<number>), parsed.width, parsed.height))], { type: 'image/png' })) };
  }
  const type = extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg' : `image/${extension}`;
  const blob = new Blob([toArrayBuffer(bytes)], { type });
  await validateImageDimensions(blob);
  return { url: URL.createObjectURL(blob) };
}

async function validateImageDimensions(blob: Blob): Promise<void> {
  let width: number;
  let height: number;
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(blob);
    try { width = bitmap.width; height = bitmap.height; } finally { bitmap.close(); }
  } else {
    const url = URL.createObjectURL(blob);
    try {
      const image = await new Promise<HTMLImageElement>((resolve, reject) => {
        const value = new Image();
        value.onload = () => resolve(value);
        value.onerror = () => reject(new Error('The image could not be decoded.'));
        value.src = url;
      });
      width = image.naturalWidth;
      height = image.naturalHeight;
    } finally { URL.revokeObjectURL(url); }
  }
  if (!Number.isSafeInteger(width * height) || width * height > MAX_DECODED_PIXELS) {
    throw new Error(`Image dimensions ${width} x ${height} exceed the 16 megapixel limit.`);
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = Uint8Array.from(bytes);
  return copy.buffer as ArrayBuffer;
}

function rgbaPng(data: Uint8Array, width: number, height: number): Uint8Array {
  const scanlines = new Uint8Array(height * (width * 4 + 1));
  for (let y = 0; y < height; y += 1) scanlines.set(data.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  const header = new Uint8Array(13); const view = new DataView(header.buffer);
  view.setUint32(0, width); view.setUint32(4, height); header.set([8, 6, 0, 0, 0], 8);
  const chunks = [pngChunk('IHDR', header), pngChunk('IDAT', zlibStore(scanlines)), pngChunk('IEND', new Uint8Array())];
  const out = new Uint8Array(8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0)); out.set([137, 80, 78, 71, 13, 10, 26, 10]);
  let offset = 8; for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; } return out;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(data.length + 12); const view = new DataView(chunk.buffer); view.setUint32(0, data.length);
  for (let i = 0; i < 4; i += 1) chunk[4 + i] = type.charCodeAt(i); chunk.set(data, 8);
  let crc = 0xffffffff;
  for (let i = 4; i < data.length + 8; i += 1) { crc ^= chunk[i]; for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  view.setUint32(data.length + 8, (crc ^ 0xffffffff) >>> 0); return chunk;
}

function zlibStore(data: Uint8Array): Uint8Array {
  const blocks = Math.ceil(data.length / 0xffff); const out = new Uint8Array(2 + data.length + blocks * 5 + 4); out.set([0x78, 0x01]);
  let from = 0; let to = 2;
  while (from < data.length) { const size = Math.min(0xffff, data.length - from); out[to] = from + size === data.length ? 1 : 0; out[to + 1] = size & 255; out[to + 2] = size >>> 8; out[to + 3] = (~size) & 255; out[to + 4] = (~size) >>> 8; out.set(data.subarray(from, from + size), to + 5); from += size; to += size + 5; }
  let a = 1; let b = 0; for (const value of data) { a = (a + value) % 65521; b = (b + a) % 65521; } new DataView(out.buffer).setUint32(to, ((b << 16) | a) >>> 0); return out;
}

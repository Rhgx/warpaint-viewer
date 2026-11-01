import type { TextureMetadata } from '../data/types';
import type { SourceDiagnostic, SourcePackage } from './contracts';
import {
  isSupportedTexturePath,
  normalizeSourcePath,
  sourcePathExtension,
  sourceTextureCandidates,
  sourceTextureIdentity,
} from './paths';
import { readPackageWeaponMaterial, type PackageMaterial } from './vmt';
import { encodeRgbaPng } from './png';
import { opaqueRgbaThumbnail, SOURCE_THUMBNAIL_SIDE } from './thumbnail';

export interface SourceTextureProviderSnapshot {
  package: SourcePackage | null;
  generation: number;
  usedPaths: ReadonlySet<string>;
  fallbackIdentities: ReadonlySet<string>;
  /**
   * Refs bound by filename rather than exact path (possible only for a rootIsMaterials
   * package), keyed by texture identity.
   */
  nameMatchedPaths: ReadonlyMap<string, string>;
  /** Identities whose filename stem matched two or more package entries, so were deliberately left unmatched. */
  ambiguousNameMatches: ReadonlySet<string>;
  /** Weapon key -> the package VMT currently standing in for its material. */
  materialPaths: ReadonlyMap<string, string>;
  diagnostics: readonly SourceDiagnostic[];
}

const MAX_DECODED_PIXELS = 16 * 1024 * 1024;

/** A single lazy Source-package layer over the normal built-in URL resolver. */
export class SourceTextureProvider {
  #package: SourcePackage | null = null;
  #generation = 0;
  #urls = new Map<string, string>();
  #metadata = new Map<string, Partial<TextureMetadata>>();
  #thumbnailUrls = new Map<string, string>();
  #loads = new Map<string, Promise<string>>();
  #cubemapLoads = new Map<string, Promise<string[] | null>>();
  #cubemapUrls = new Set<string>();
  #usedPaths = new Set<string>();
  #fallbackIdentities = new Set<string>();
  #nameMatchedPaths = new Map<string, string>();
  #ambiguousNameMatches = new Set<string>();
  #nameIndexPackage: SourcePackage | null = null;
  #nameIndexByStem: Map<string, string[]> | null = null;
  #materials = new Map<string, Promise<PackageMaterial | null>>();
  #materialPaths = new Map<string, string>();
  #diagnostics: SourceDiagnostic[] = [];
  #notificationPending = false;
  #notificationToken = 0;
  private readonly fallback: (ref: string) => string;
  private readonly onChange: (() => void) | undefined;
  private readonly hasBuiltIn: (ref: string) => boolean;

  constructor(
    fallback: (ref: string) => string,
    onChange?: () => void,
    /** Whether the viewer ships a texture, used to keep import warnings to
     * inputs that really have nowhere to come from. Assumes it does when the
     * caller cannot say. */
    hasBuiltIn: (ref: string) => boolean = () => true,
  ) {
    this.fallback = fallback;
    this.onChange = onChange;
    this.hasBuiltIn = hasBuiltIn;
  }

  get generation(): number { return this.#generation; }
  get package(): SourcePackage | null { return this.#package; }

  snapshot(): SourceTextureProviderSnapshot {
    return {
      package: this.#package,
      generation: this.#generation,
      usedPaths: this.#usedPaths,
      fallbackIdentities: this.#fallbackIdentities,
      nameMatchedPaths: this.#nameMatchedPaths,
      ambiguousNameMatches: this.#ambiguousNameMatches,
      materialPaths: this.#materialPaths,
      diagnostics: this.#diagnostics,
    };
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
    this.#notifyImmediately();
  }

  unmount(): void {
    const previous = this.#package;
    if (!previous) return;
    this.#generation += 1;
    this.#package = null;
    this.#diagnostics = [];
    this.#clearTransientState();
    previous.dispose();
    this.#notifyImmediately();
  }

  dispose(): void { this.unmount(); this.#clearTransientState(); }

  async resolve(ref: string): Promise<string> {
    return this.#resolve(ref, true);
  }

  /**
   * Resolve a preview without marking it as used by the active recipe, since the
   * workbench lists every wear and team slot.
   */
  async resolvePreview(ref: string): Promise<string> {
    return this.#resolve(ref, false);
  }

  /** Resolve an imported six-face VTF cubemap, or null when the package does not provide it. */
  async resolveCubemap(ref: string): Promise<string[] | null> {
    const pkg = this.#package;
    if (!pkg) return null;
    const path = this.packagePathFor(ref);
    if (!path || sourcePathExtension(path) !== 'vtf') return null;
    const key = `${this.#generation}:${path}`;
    const cached = this.#cubemapLoads.get(key);
    if (cached) return cached;
    const generation = this.#generation;
    const load = pkg.read(path).then(async (bytes) => {
      const { decodeVtfCubemapToPng } = await import('./vtfDecode');
      const faces = await decodeVtfCubemapToPng(bytes);
      if (generation !== this.#generation || pkg !== this.#package) return null;
      const urls = faces.map((png) => URL.createObjectURL(new Blob([png], { type: 'image/png' })));
      urls.forEach((url) => this.#cubemapUrls.add(url));
      this.#recordUsed(path);
      return urls;
    }).catch(() => null);
    this.#cubemapLoads.set(key, load);
    return load;
  }

  /** A package-scoped preview produced during its first texture decode. */
  async resolveThumbnail(ref: string): Promise<string> {
    const url = await this.#resolve(ref, false);
    const path = this.packagePathFor(ref);
    return path ? this.#thumbnailUrls.get(path) ?? url : url;
  }

  /**
   * The package entry a ref binds to, or undefined, without loading anything. Shares
   * #resolve's rules, so an export packs what the viewer draws: some packs ask for
   * `patterns/FFV3/` while shipping loose files at the root, which only the filename
   * fallback binds.
   */
  packagePathFor(ref: string): string | undefined {
    const pkg = this.#package;
    if (!pkg) return undefined;
    let identity: string;
    let candidates: string[];
    try { identity = sourceTextureIdentity(ref); candidates = sourceTextureCandidates(ref); }
    catch { return undefined; }
    const exact = candidates.find((candidate) => pkg.has(candidate));
    if (exact) return exact;
    if (!pkg.rootIsMaterials) return undefined;
    const nameMatch = this.#matchByName(pkg, identity);
    return nameMatch && nameMatch !== 'ambiguous' ? nameMatch : undefined;
  }

  /**
   * Resolves a canonical path into a rootless package, where installers keep files in
   * folders the definitions do not name. Exact paths win, then a unique filename match.
   * Export writes under the requested path, never this read path.
   */
  packagePathForFile(requestedPath: string): string | undefined {
    const pkg = this.#package;
    if (!pkg) return undefined;
    let canonical: string;
    try { canonical = normalizeSourcePath(requestedPath); }
    catch { return undefined; }
    if (pkg.has(canonical)) return canonical;
    if (!pkg.rootIsMaterials) return undefined;
    const filename = canonical.slice(canonical.lastIndexOf('/') + 1);
    const matches = [...pkg.entries.keys()].filter(
      (path) => path.slice(path.lastIndexOf('/') + 1) === filename,
    );
    return matches.length === 1 ? matches[0] : undefined;
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
    let path = candidates.find((candidate) => pkg.has(candidate));
    // A rootIsMaterials package has no materials/ tree, so as a last resort (never ahead of
    // an exact hit) bind by filename.
    if (!path && pkg.rootIsMaterials) {
      const nameMatch = this.#matchByName(pkg, identity);
      if (nameMatch === 'ambiguous') {
        if (consume && !this.#ambiguousNameMatches.has(identity)) { this.#ambiguousNameMatches.add(identity); this.#notifySoon(); }
      } else if (nameMatch) {
        path = nameMatch;
        if (consume && this.#nameMatchedPaths.get(identity) !== nameMatch) { this.#nameMatchedPaths.set(identity, nameMatch); this.#notifySoon(); }
      }
    }
    if (!path) {
      if (consume && !this.#fallbackIdentities.has(identity)) { this.#fallbackIdentities.add(identity); this.#notifySoon(); }
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

  /**
   * The material this package supplies for a weapon, or null to keep the built-in one.
   * Packs ship replacement VMTs next to their textures, while manifest.json only carries
   * the stock material.
   */
  async resolveMaterial(weaponKey: string, materialOverrideId?: string): Promise<PackageMaterial | null> {
    const pkg = this.#package;
    if (!pkg || !weaponKey) return null;
    const key = `${this.#generation}:${weaponKey}:${materialOverrideId ?? ''}`;
    const cached = this.#materials.get(key);
    if (cached) return cached;
    const generation = this.#generation;
    const load = this.#loadMaterial(pkg, weaponKey, materialOverrideId, generation);
    this.#materials.set(key, load);
    return load;
  }

  async #loadMaterial(
    pkg: SourcePackage,
    weaponKey: string,
    materialOverrideId: string | undefined,
    generation: number,
  ): Promise<PackageMaterial | null> {
    const lookup = await readPackageWeaponMaterial(pkg, weaponKey, materialOverrideId);
    // A package removed or replaced mid-read must leave no trace behind.
    if (generation !== this.#generation || pkg !== this.#package) return null;
    if (lookup.status === 'none') return null;
    if (lookup.status === 'ambiguous') {
      this.#addDiagnostic({
        id: `material-ambiguous:${weaponKey}`,
        level: 'warning',
        message: `Several materials in this package are named ${weaponKey}.vmt, so the built-in material was kept.`,
        detail: lookup.paths.join(', '),
      });
      return null;
    }
    if (lookup.status === 'failed') {
      this.#addDiagnostic({
        id: `material-failed:${lookup.path}`,
        level: 'warning',
        message: 'Could not read this package material; the built-in one was used instead.',
        detail: `${lookup.path}: ${lookup.message}`,
      });
      return null;
    }

    const { material } = lookup;
    this.#recordUsed(material.path);
    if (this.#materialPaths.get(weaponKey) !== material.path) {
      this.#materialPaths.set(weaponKey, material.path);
      this.#notifySoon();
    }
    if (material.nameMatched) {
      this.#addDiagnostic({
        id: `material-name-matched:${material.path}`,
        level: 'info',
        message: 'Bound this material by file name; the package does not place it at a Source material path.',
        detail: material.path,
      });
    }
    if (material.unsupported.length) {
      this.#addDiagnostic({
        id: `material-unsupported:${material.path}`,
        level: 'warning',
        message: `This material uses ${listPhrase(material.unsupported)}, which this viewer does not reproduce.`,
        detail: material.path,
      });
    }
    // A stock texture the package omits is normal and resolves to the built-in. Warn only
    // when neither side has the input, since it will not be drawn.
    const unresolvable = material.missingTextures.filter((ref) => !this.hasBuiltIn(ref));
    const envmapTexture = material.material.envmapTexture;
    const missingEnvmap = envmapTexture && unresolvable.includes(envmapTexture)
      ? envmapTexture
      : null;
    if (missingEnvmap) {
      this.#addDiagnostic({
        id: `material-missing-envmap:${material.path}`,
        level: 'warning',
        message: 'This material\'s $envmap is not present in the package or bundled TF2 cubemaps, so the editor cubemap was used.',
        detail: missingEnvmap,
      });
    }
    const otherUnresolvable = unresolvable.filter((ref) => ref !== missingEnvmap);
    if (otherUnresolvable.length) {
      this.#addDiagnostic({
        id: `material-missing-textures:${material.path}`,
        level: 'warning',
        message: `This material names ${otherUnresolvable.length.toLocaleString()} texture${otherUnresolvable.length === 1 ? '' : 's'} that neither the package nor this viewer has, so ${otherUnresolvable.length === 1 ? 'it is' : 'they are'} left out.`,
        detail: otherUnresolvable.join(', '),
      });
    }
    return material;
  }

  #addDiagnostic(diagnostic: SourceDiagnostic): void {
    if (this.#diagnostics.some((entry) => entry.id === diagnostic.id)) return;
    this.#diagnostics.push(diagnostic);
    this.#notifySoon();
  }

  #clearTransientState(): void {
    for (const url of this.#urls.values()) URL.revokeObjectURL(url);
    for (const url of this.#cubemapUrls) URL.revokeObjectURL(url);
    for (const url of this.#thumbnailUrls.values()) URL.revokeObjectURL(url);
    this.#urls.clear(); this.#cubemapUrls.clear(); this.#cubemapLoads.clear(); this.#thumbnailUrls.clear(); this.#metadata.clear(); this.#loads.clear(); this.#usedPaths.clear(); this.#fallbackIdentities.clear();
    this.#nameMatchedPaths.clear(); this.#ambiguousNameMatches.clear();
    this.#materials.clear(); this.#materialPaths.clear();
    this.#nameIndexPackage = null; this.#nameIndexByStem = null;
  }

  /**
   * Binds an identity to the package entry with its filename stem. Two or more such
   * entries are ambiguous by design: a wrong guess would silently apply the wrong texture.
   */
  #matchByName(pkg: SourcePackage, identity: string): string | 'ambiguous' | undefined {
    if (this.#nameIndexPackage !== pkg) {
      this.#nameIndexPackage = pkg;
      this.#nameIndexByStem = buildNameIndex(pkg);
    }
    const stem = identity.slice(identity.lastIndexOf('/') + 1);
    const matches = this.#nameIndexByStem?.get(stem);
    if (!matches || matches.length === 0) return undefined;
    if (matches.length > 1) return 'ambiguous';
    return matches[0];
  }

  async #load(pkg: SourcePackage, path: string, generation: number, fallbackRef: string): Promise<string> {
    try {
      const bytes = await pkg.read(path);
      if (generation !== this.#generation || pkg !== this.#package) throw new Error('Source package changed while this texture was loading.');
      const extension = sourcePathExtension(path);
      if (!extension) throw new Error('Package entry has no supported texture extension.');
      const decoded = await decodePackageTexture(bytes, extension);
      const url = decoded.url;
      if (generation !== this.#generation || pkg !== this.#package) {
        URL.revokeObjectURL(url);
        if (decoded.thumbnailUrl) URL.revokeObjectURL(decoded.thumbnailUrl);
        throw new Error('Source package changed while this texture was decoding.');
      }
      this.#urls.set(path, url);
      if (decoded.thumbnailUrl) this.#thumbnailUrls.set(path, decoded.thumbnailUrl);
      if (decoded.metadata) this.#metadata.set(path, decoded.metadata);
      return url;
    } catch (cause) {
      // A removed or replaced package must leave no trace, so a late read may not add a diagnostic.
      if (generation !== this.#generation || pkg !== this.#package) throw cause;
      const message = cause instanceof Error ? cause.message : 'Could not decode this package texture.';
      this.#addDiagnostic({
        id: `decode:${path}`,
        level: 'warning',
        message: 'Could not use package texture; the built-in asset was used instead.',
        detail: `${path}: ${message}`,
      });
      return this.fallback(fallbackRef);
    }
  }

  #recordUsed(path: string): void {
    if (this.#usedPaths.has(path)) return;
    this.#usedPaths.add(path);
    this.#notifySoon();
  }

  /** Texture resolution completes in bursts, so one summary update covers them.
   * Mount and remove stay immediate. */
  #notifySoon(): void {
    if (!this.onChange || this.#notificationPending) return;
    this.#notificationPending = true;
    const token = ++this.#notificationToken;
    const flush = () => {
      if (token !== this.#notificationToken) return;
      this.#notificationPending = false;
      this.onChange?.();
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(flush);
    else queueMicrotask(flush);
  }

  #notifyImmediately(): void {
    // Cancels a queued summary update, so mount or remove renders exactly once.
    this.#notificationPending = false;
    this.#notificationToken += 1;
    this.onChange?.();
  }
}

function listPhrase(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * Groups a rootIsMaterials package's texture entries by filename stem, so a ref with no
 * exact path can bind to a same-named file elsewhere in the pack.
 */
function buildNameIndex(pkg: SourcePackage): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const path of pkg.entries.keys()) {
    if (!isSupportedTexturePath(path)) continue;
    // isSupportedTexturePath guarantees a dot that is neither first nor last in the filename.
    const filename = path.slice(path.lastIndexOf('/') + 1);
    const stem = filename.slice(0, filename.lastIndexOf('.'));
    const list = index.get(stem);
    if (list) list.push(path); else index.set(stem, [path]);
  }
  return index;
}

async function decodePackageTexture(
  bytes: Uint8Array,
  extension: string,
): Promise<{ url: string; thumbnailUrl?: string; metadata?: Partial<TextureMetadata> }> {
  if (extension === 'vtf') {
    // VTF and PNG work runs in a lazy Worker, so reads do not block the active paint.
    const { decodeVtfToPng } = await import('./vtfDecode');
    const decoded = await decodeVtfToPng(bytes, { maxPixels: MAX_DECODED_PIXELS });
    return {
      url: URL.createObjectURL(new Blob([decoded.png], { type: 'image/png' })),
      thumbnailUrl: URL.createObjectURL(new Blob([decoded.thumbnailPng], { type: 'image/png' })),
      metadata: decoded.header.sampling,
    };
  }
  if (extension === 'tga') {
    const { TGALoader } = await import('three/addons/loaders/TGALoader.js');
    const parsed = new TGALoader().parse(toArrayBuffer(bytes));
    if (!parsed.data || !parsed.width || !parsed.height || parsed.width * parsed.height > MAX_DECODED_PIXELS) throw new Error('TGA has invalid or oversized pixel data.');
    const png = await encodeRgbaPng(Uint8Array.from(parsed.data as ArrayLike<number>), parsed.width, parsed.height);
    const thumbnailPng = await encodeRgbaPng(
      opaqueRgbaThumbnail(
        Uint8Array.from(parsed.data as ArrayLike<number>),
        parsed.width,
        parsed.height,
      ),
      SOURCE_THUMBNAIL_SIDE,
      SOURCE_THUMBNAIL_SIDE,
    );
    return {
      url: URL.createObjectURL(new Blob([png], { type: 'image/png' })),
      thumbnailUrl: URL.createObjectURL(new Blob([thumbnailPng], { type: 'image/png' })),
    };
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

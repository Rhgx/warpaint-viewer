import type { WeaponMaterial } from '../data/types';
import type { SourcePackage } from './contracts';
import { isSupportedTexturePath, normalizeSourcePath, sourcePathExtension, sourceTextureCandidates, sourceTextureIdentity } from './paths';

// Runtime VMT support for imported packages.
//
// tools/extract/warpaints.mjs reads each stock weapon's VMT out of the game VPKs and
// bakes it into manifest.json, so the built-in war paints never need a parser
// in the browser. Community war paints do: packs routinely ship replacement
// materials next to their textures (see the "VMT's/" folder of ghastly_guns,
// which turns the weapon glow on and makes the paint alpha-tested), and the
// baked-in weapon material says nothing about those.
//
// This is the same VMT -> WeaponMaterial mapping the pipeline performs
// (tools/extract/warpaints.mjs resolveWeaponMaterials), ported so a mounted package can
// override the material the same way the game would.

// KeyValues

type KvValue = string | KvBlock | (string | KvBlock)[];
interface KvBlock { [key: string]: KvValue }

/**
 * Minimal Valve KeyValues (text) reader: quoted and unquoted tokens, nested
 * blocks, `//` comments, `#base` directives ignored, duplicate keys collapsed
 * into an array. Ported from tools/lib/kv.mjs so the browser and the pipeline
 * read the same files the same way.
 */
function parseKeyValues(text: string): KvBlock {
  let index = 0;
  const length = text.length;

  function skipWhitespace(): void {
    while (index < length) {
      const char = text[index];
      if (char === ' ' || char === '\t' || char === '\r' || char === '\n') { index += 1; continue; }
      if (char === '/' && text[index + 1] === '/') {
        while (index < length && text[index] !== '\n') index += 1;
        continue;
      }
      break;
    }
  }

  function readToken(): '{' | '}' | { str: string } | null {
    skipWhitespace();
    if (index >= length) return null;
    const char = text[index];
    if (char === '{' || char === '}') { index += 1; return char; }
    if (char === '"') {
      index += 1;
      let value = '';
      while (index < length && text[index] !== '"') {
        if (text[index] === '\\' && index + 1 < length) {
          const next = text[index + 1];
          if (next === '"' || next === '\\') { value += next; index += 2; continue; }
        }
        value += text[index];
        index += 1;
      }
      index += 1;
      return { str: value };
    }
    let value = '';
    while (index < length) {
      const current = text[index];
      if (current === ' ' || current === '\t' || current === '\r' || current === '\n'
        || current === '{' || current === '}' || current === '"') break;
      if (current === '/' && text[index + 1] === '/') break;
      value += current;
      index += 1;
    }
    return { str: value };
  }

  function addKey(target: KvBlock, key: string, value: string | KvBlock): void {
    const existing = target[key];
    if (existing === undefined) { target[key] = value; return; }
    if (Array.isArray(existing)) existing.push(value);
    else target[key] = [existing, value];
  }

  function parseBlock(): KvBlock {
    const block: KvBlock = {};
    for (;;) {
      const token = readToken();
      if (token === null || token === '}') break;
      if (token === '{') continue;
      const key = token.str;
      const value = readToken();
      if (value === null) break;
      if (value === '{') addKey(block, key, parseBlock());
      else if (value === '}') { addKey(block, key, ''); break; }
      else if (key[0] !== '#') addKey(block, key, value.str);
    }
    return block;
  }

  const root: KvBlock = {};
  skipWhitespace();
  while (index < length) {
    const token = readToken();
    if (token === null) break;
    if (token === '{' || token === '}') continue;
    const key = token.str;
    const value = readToken();
    if (value === null) { addKey(root, key, ''); break; }
    if (value === '{') addKey(root, key, parseBlock());
    else if (value === '}') addKey(root, key, '');
    else if (key[0] !== '#') addKey(root, key, value.str);
    skipWhitespace();
  }
  return root;
}

/** KeyValues keys are case-insensitive in Source; VMT authors rely on that. */
function kvGet(block: KvBlock | undefined, key: string): KvValue | undefined {
  if (!block) return undefined;
  const direct = block[key];
  if (direct !== undefined) return direct;
  const lower = key.toLowerCase();
  for (const candidate of Object.keys(block)) {
    if (candidate.toLowerCase() === lower) return block[candidate];
  }
  return undefined;
}

// VMT -> WeaponMaterial

function kvString(value: KvValue | undefined): string | undefined {
  if (typeof value === 'string') return value;
  // A duplicated key keeps its last value, matching Source's own overwrite.
  if (Array.isArray(value)) {
    for (let i = value.length - 1; i >= 0; i -= 1) {
      if (typeof value[i] === 'string') return value[i] as string;
    }
  }
  return undefined;
}

function vmtVector(value: KvValue | undefined): number[] | null {
  const raw = kvString(value);
  if (raw == null) return null;
  const numbers = raw.replace(/[[\]{}]/g, ' ').trim().split(/\s+/).map(Number).filter((n) => Number.isFinite(n));
  return numbers.length ? numbers : null;
}

function vmtBool(body: KvBlock, key: string, fallback = false): boolean {
  const value = vmtVector(kvGet(body, key));
  return value ? value[0] !== 0 : fallback;
}

function vmtNumber(body: KvBlock, key: string, fallback: number): number {
  const value = vmtVector(kvGet(body, key));
  return value ? value[0] : fallback;
}

function vmtColor(body: KvBlock, key: string): [number, number, number] | null;
function vmtColor(body: KvBlock, key: string, fallback: [number, number, number]): [number, number, number];
function vmtColor(body: KvBlock, key: string, fallback: [number, number, number] | null = null): [number, number, number] | null {
  const value = vmtVector(kvGet(body, key));
  if (!value) return fallback;
  if (value.length === 1) return [value[0], value[0], value[0]];
  return value.length >= 3 ? [value[0], value[1], value[2]] : fallback;
}

function hasProxy(body: KvBlock, name: string): boolean {
  const proxies = kvGet(body, 'proxies');
  if (!proxies || typeof proxies !== 'object' || Array.isArray(proxies)) return false;
  return kvGet(proxies, name) !== undefined;
}

/**
 * Turns a raw material reference into the viewer's public texture path, the
 * same shape tools/lib/resolve.mjs texturePublicPath produces. Lowercased for
 * the same reason src/protodefs/decoder.ts lowercases recipe refs: Source
 * treats material paths case-insensitively and the pipeline writes every file
 * lowercased, so a VMT's casing is not meaningful.
 */
function texturePublicPath(reference: string | undefined): string | null {
  if (!reference) return null;
  const path = reference.trim().replace(/\\/g, '/')
    .replace(/^materials\//i, '')
    .replace(/\.(?:vtf|tga|psd|png|webp)$/i, '');
  return path ? `textures/${path}.webp`.toLowerCase() : null;
}

/** Shaders whose parameters this mapping actually describes. */
const KNOWN_SHADERS = new Set(['vertexlitgeneric', 'unlitgeneric', 'skin', 'weaponinvis', 'patch']);

/**
 * VMT parameters that visibly change a weapon in game but that this viewer
 * does not reproduce, so an imported material can say so rather than silently
 * dropping them.
 */
const UNSUPPORTED_PARAMETERS: { key: string; label: string }[] = [
  { key: '$translucent', label: 'sorted translucency' },
  { key: '$additive', label: 'additive blending' },
  { key: '$envmapmask', label: 'a separate env-map mask texture' },
  { key: '$blendtintbybasealpha', label: 'base-alpha tint blending' },
];

/**
 * Detail blend modes this viewer implements, which is every TCOMBINE_* mode
 * from common_ps_fxc.h except the two self-shadowed-bump ones: those read the
 * detail texture as an ssbump basis, and nothing in the viewer produces one.
 */
const SUPPORTED_DETAIL_MODES = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

interface ParsedVmt {
  shader: string;
  material: WeaponMaterial;
  /** Every texture the material names, in `textures/<path>.webp` form. */
  textureRefs: string[];
  /** Visible features of this VMT the viewer does not reproduce. */
  unsupported: string[];
}

/**
 * Maps one VMT onto the viewer's material parameters. A VMT is self-contained
 * in Source, so unset parameters take shader defaults rather than inheriting
 * from the weapon's built-in material.
 */
/** @public Used by tools/verify/vmt-parity.mjs through its generated SSR entry. */
export function parseWeaponMaterialVmt(text: string): ParsedVmt {
  const root = parseKeyValues(text);
  const shaderKey = Object.keys(root)[0] ?? '';
  const candidate = root[shaderKey];
  const body: KvBlock = candidate && typeof candidate === 'object' && !Array.isArray(candidate) ? candidate : {};

  const phongExponent = vmtVector(kvGet(body, '$phongexponent'));
  const phongExponentFactor = vmtVector(kvGet(body, '$phongexponentfactor'));
  const bumpMap = kvString(kvGet(body, '$bumpmap'));
  const exponentTexture = kvString(kvGet(body, '$phongexponenttexture'));
  const lightwarpTexture = kvString(kvGet(body, '$lightwarptexture'));
  const envmapTexture = texturePublicPath(kvString(kvGet(body, '$envmap')));
  // Source only reads $envmaptint when the material has an $envmap; a material
  // with a cubemap but no explicit tint reflects it at full strength.
  const hasEnvMap = kvGet(body, '$envmap') !== undefined;
  const scroll = vmtVector(kvGet(body, '$emissiveblendscrollvector'));

  const selfIllum = vmtBool(body, '$selfillum');
  const selfIllumMask = selfIllum ? texturePublicPath(kvString(kvGet(body, '$selfillummask'))) : null;
  const emissiveBlend = vmtBool(body, '$emissiveblendenabled');
  const detailTexture = texturePublicPath(kvString(kvGet(body, '$detail')));
  const detailBlendMode = Math.trunc(vmtNumber(body, '$detailblendmode', 0));

  const material: WeaponMaterial = {
    phongExponent: phongExponent ? phongExponent[0] : null,
    phongBoost: vmtNumber(body, '$phongboost', 1),
    envmapTint: vmtColor(body, '$envmaptint', hasEnvMap ? [1, 1, 1] : [0, 0, 0]),
    envmapTexture,
    normalMap: texturePublicPath(bumpMap),
    phong: vmtBool(body, '$phong'),
    phongExponentFactor: phongExponentFactor ? phongExponentFactor[0] : null,
    phongExponentTexture: texturePublicPath(exponentTexture),
    lightwarpTexture: texturePublicPath(lightwarpTexture),
    halfLambert: vmtBool(body, '$halflambert'),
    baseMapAlphaPhongMask: vmtBool(body, '$basemapalphaphongmask'),
    baseMapAlphaEnvmapMask: vmtBool(body, '$basealphaenvmapmask'),
    normalMapAlphaEnvmapMask: vmtBool(body, '$normalmapalphaenvmapmask'),
    phongAlbedoTint: vmtBool(body, '$phongalbedotint'),
    phongTint: vmtColor(body, '$phongtint'),
    phongFresnelRanges: vmtColor(body, '$phongfresnelranges', [0, 0.5, 1]),
    rimLight: vmtBool(body, '$rimlight'),
    rimLightExponent: vmtNumber(body, '$rimlightexponent', 4),
    rimLightBoost: vmtNumber(body, '$rimlightboost', 1),
    rimMask: vmtBool(body, '$rimmask'),
    ...(selfIllum ? {
      selfIllum: true,
      selfIllumMask,
      selfIllumTint: vmtColor(body, '$selfillumtint', [1, 1, 1]),
      selfIllumFresnel: vmtBool(body, '$selfillumfresnel'),
      selfIllumFresnelMinMaxExp: vmtColor(body, '$selfillumfresnelminmaxexp', [0, 1, 1]),
      modelGlowColor: hasProxy(body, 'modelglowcolor'),
    } : {}),
    ...(vmtBool(body, '$alphatest') ? {
      alphaTest: true,
      // A material that asks for alpha testing without naming a cutoff gets
      // the shader's own default rather than "discard nothing".
      alphaTestReference: vmtNumber(body, '$alphatestreference', 0.5) || 0.5,
      // Without this the test is a binary cut, which is not what a war paint
      // whose composited alpha sits just over the reference is asking for.
      alphaToCoverage: vmtBool(body, '$allowalphatocoverage'),
    } : {}),
    // Defaults from vertexlitgeneric_dx9_helper.cpp InitParamsVertexLitGeneric.
    ...(detailTexture && SUPPORTED_DETAIL_MODES.has(detailBlendMode) ? {
      detailTexture,
      detailBlendMode,
      detailScale: vmtNumber(body, '$detailscale', 4),
      detailBlendFactor: vmtNumber(body, '$detailblendfactor', 1),
      detailTint: vmtColor(body, '$detailtint', [1, 1, 1]),
    } : {}),
    // Defaults from the SHADER_PARAM declarations in vertexlitgeneric_dx9.cpp.
    ...(emissiveBlend ? {
      emissiveBlend: true,
      emissiveBlendStrength: vmtNumber(body, '$emissiveblendstrength', 1),
      emissiveBlendTint: vmtColor(body, '$emissiveblendtint', [1, 1, 1]),
      emissiveBlendBaseTexture: texturePublicPath(kvString(kvGet(body, '$emissiveblendbasetexture'))),
      emissiveBlendTexture: texturePublicPath(kvString(kvGet(body, '$emissiveblendtexture'))),
      emissiveBlendFlowTexture: texturePublicPath(kvString(kvGet(body, '$emissiveblendflowtexture'))),
      emissiveBlendScrollVector: [scroll?.[0] ?? 0.11, scroll?.[1] ?? 0.124] as [number, number],
    } : {}),
  };

  const textureRefs = [
    material.envmapTexture,
    material.normalMap,
    material.phongExponentTexture,
    material.lightwarpTexture,
    material.selfIllumMask,
    material.detailTexture,
    material.emissiveBlendBaseTexture,
    material.emissiveBlendTexture,
    material.emissiveBlendFlowTexture,
  ].filter((ref): ref is string => !!ref);

  const unsupported = UNSUPPORTED_PARAMETERS
    .filter(({ key }) => kvGet(body, key) !== undefined)
    .map(({ label }) => label);
  const shader = shaderKey || 'VertexLitGeneric';
  if (!KNOWN_SHADERS.has(shader.toLowerCase())) {
    unsupported.push(`the ${shader} shader (drawn as VertexLitGeneric)`);
  }
  if (detailTexture && !SUPPORTED_DETAIL_MODES.has(detailBlendMode)) {
    unsupported.push(`detail blend mode ${detailBlendMode}`);
  }

  return { shader, material, textureRefs, unsupported };
}

// Package lookup

export interface PackageMaterialPathIndex {
  readonly paths: ReadonlySet<string>;
  readonly uniqueFilenames: ReadonlySet<string>;
}

/** Indexes VMT paths once so material override rows do not rescan a large archive. */
export function indexPackageMaterialPaths(pkg: SourcePackage): PackageMaterialPathIndex {
  const paths = new Set<string>();
  const filenameCounts = new Map<string, number>();
  for (const path of pkg.entries.keys()) {
    if (sourcePathExtension(path) !== 'vmt') continue;
    paths.add(path);
    const filename = path.slice(path.lastIndexOf('/') + 1);
    filenameCounts.set(filename, (filenameCounts.get(filename) ?? 0) + 1);
  }
  return {
    paths,
    uniqueFilenames: new Set(
      [...filenameCounts].flatMap(([filename, count]) => count === 1 ? [filename] : []),
    ),
  };
}

/** Matches the exact override path or one unambiguous relocated VMT filename. */
export function packageHasMaterialOverride(
  index: PackageMaterialPathIndex,
  materialOverrideId: string,
): boolean {
  let path: string;
  try { path = `${sourceTextureIdentity(materialOverrideId.replace(/\.vmt$/i, ''))}.vmt`; }
  catch { return false; }
  if (index.paths.has(path)) return true;
  return index.uniqueFilenames.has(path.slice(path.lastIndexOf('/') + 1));
}

/**
 * Where a package would place the material for this weapon, most specific
 * first. A war paint's material override is what the game actually loads for
 * a painted weapon, so a package replacing it outranks the plain weapon
 * material. The rest mirror the model paths tools/extract/warpaints.mjs resolves
 * (`c_models/<key>/<key>` for most weapons, `workshop/` for the Steam
 * Workshop imports, and the two flatter historical layouts).
 */
function weaponMaterialIdentities(weaponKey: string, materialOverrideId?: string): string[] {
  const identities = materialOverrideId ? [materialOverrideId] : [];
  identities.push(
    `models/weapons/c_models/${weaponKey}/${weaponKey}`,
    `models/workshop/weapons/c_models/${weaponKey}/${weaponKey}`,
    `models/weapons/c_models/${weaponKey}`,
    `models/weapons/c_items/${weaponKey}`,
  );
  return identities;
}

/** VMTs are plain text, but authors' editors leave byte-order marks behind. */
function decodeVmtText(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes.subarray(3));
  }
  return new TextDecoder('utf-8').decode(bytes);
}

function vmtStemIndex(pkg: SourcePackage): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const path of pkg.entries.keys()) {
    if (sourcePathExtension(path) !== 'vmt') continue;
    const filename = path.slice(path.lastIndexOf('/') + 1);
    const stem = filename.slice(0, -4);
    const existing = index.get(stem);
    if (existing) existing.push(path);
    else index.set(stem, [path]);
  }
  return index;
}

/**
 * Whether the package can serve this texture reference, by exact Source path
 * or (for a package with no materials/ tree of its own) by file name, matching
 * how SourceTextureProvider will go looking for it when the material is used.
 */
function packageHasTexture(pkg: SourcePackage, ref: string, textureStems: Set<string> | null): boolean {
  let candidates: string[];
  try { candidates = sourceTextureCandidates(ref); }
  catch { return true; }
  if (candidates.some((candidate) => pkg.has(candidate))) return true;
  if (!textureStems) return false;
  const identity = candidates[0];
  const filename = identity.slice(identity.lastIndexOf('/') + 1);
  return textureStems.has(filename.slice(0, filename.lastIndexOf('.')));
}

function textureStemIndex(pkg: SourcePackage): Set<string> {
  const stems = new Set<string>();
  for (const path of pkg.entries.keys()) {
    const extension = sourcePathExtension(path);
    if (!extension || !isSupportedTexturePath(path)) continue;
    const filename = path.slice(path.lastIndexOf('/') + 1);
    stems.add(filename.slice(0, filename.length - (extension.length + 1)));
  }
  return stems;
}

export interface PackageMaterial extends ParsedVmt {
  /** Canonical package path the material was read from. */
  path: string;
  /** True when the file was bound by name because no exact path matched. */
  nameMatched: boolean;
  /** Texture refs this material names that the package does not provide. */
  missingTextures: string[];
}

export type PackageMaterialLookup =
  | { status: 'found'; material: PackageMaterial }
  | { status: 'none' }
  | { status: 'ambiguous'; paths: string[] }
  | { status: 'failed'; path: string; message: string };

/**
 * Finds and parses the material a mounted package supplies for one weapon.
 *
 * Exact Source paths win. Failing that a single `<weaponKey>.vmt` anywhere in
 * the package is accepted, because packs regularly ship their materials in a
 * loose folder for the installer to repath by hand (ghastly_guns keeps them in
 * `VMT's/`). The weapon key is a specific enough file name to bind on; two
 * files sharing it are reported rather than guessed between, the same rule
 * SourceTextureProvider applies to name-matched textures.
 */
export async function readPackageWeaponMaterial(
  pkg: SourcePackage,
  weaponKey: string,
  materialOverrideId?: string,
): Promise<PackageMaterialLookup> {
  let path: string | undefined;
  let nameMatched = false;
  for (const identity of weaponMaterialIdentities(weaponKey, materialOverrideId)) {
    let candidate: string;
    try { candidate = normalizeSourcePath(`materials/${identity}.vmt`); }
    catch { continue; }
    if (pkg.has(candidate)) { path = candidate; break; }
  }
  if (!path) {
    const matches = vmtStemIndex(pkg).get(weaponKey.toLowerCase()) ?? [];
    if (matches.length > 1) return { status: 'ambiguous', paths: matches };
    if (matches.length === 1) { path = matches[0]; nameMatched = true; }
  }
  if (!path) return { status: 'none' };

  try {
    const parsed = parseWeaponMaterialVmt(decodeVmtText(await pkg.read(path)));
    const textureStems = pkg.rootIsMaterials ? textureStemIndex(pkg) : null;
    const missingTextures = parsed.textureRefs.filter((ref) => !packageHasTexture(pkg, ref, textureStems));
    return { status: 'found', material: { ...parsed, path, nameMatched, missingTextures } };
  } catch (cause) {
    return { status: 'failed', path, message: cause instanceof Error ? cause.message : 'Could not read this material.' };
  }
}

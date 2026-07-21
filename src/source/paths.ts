import { SourcePackageError } from './contracts';

export const SUPPORTED_TEXTURE_EXTENSIONS = [
  'vtf',
  'tga',
  'png',
  'webp',
  'jpg',
  'jpeg',
] as const;

export type SupportedTextureExtension = (typeof SUPPORTED_TEXTURE_EXTENSIONS)[number];

const SUPPORTED_TEXTURE_EXTENSION_SET = new Set<string>(SUPPORTED_TEXTURE_EXTENSIONS);
const SOURCE_EXTENSION_PATTERN = /\.(?:vtf|tga|psd|png|webp|jpe?g)$/i;

export interface NormalizeSourcePathOptions {
  /**
   * Recipe references occasionally contain a harmless leading separator. ZIP
   * entries must leave this false so absolute archive paths are rejected.
   */
  allowLeadingSeparators?: boolean;
  /** Directory markers are only useful while validating an archive index. */
  allowEmpty?: boolean;
}

/**
 * Converts a path into the case-insensitive Source asset identity. It is
 * deliberately stricter than URL normalization: no relative traversal, drive
 * paths, controls, or absolute archive paths are permitted.
 */
export function normalizeSourcePath(input: string, options: NormalizeSourcePathOptions = {}): string {
  if (typeof input !== 'string') {
    throw new SourcePackageError('invalid-path', 'Source paths must be strings.');
  }
  if (input.length === 0) {
    if (options.allowEmpty) return '';
    throw new SourcePackageError('invalid-path', 'Source paths cannot be empty.');
  }
  if (hasControlCharacter(input)) {
    throw new SourcePackageError('invalid-path', 'Source paths cannot contain null bytes or control characters.', input);
  }

  let path = input.replace(/\\/g, '/');
  if (/^[a-z]:/i.test(path)) {
    throw new SourcePackageError('absolute-path', 'Drive-qualified paths are not valid Source paths.', input);
  }
  if (path.startsWith('/')) {
    if (!options.allowLeadingSeparators) {
      throw new SourcePackageError('absolute-path', 'Absolute paths are not valid Source paths.', input);
    }
    path = path.replace(/^\/+/, '');
  }

  const components: string[] = [];
  for (const component of path.split('/')) {
    if (component.length === 0) continue;
    if (component === '.' || component === '..') {
      throw new SourcePackageError('path-traversal', 'Source paths cannot contain relative traversal components.', input);
    }
    components.push(component);
  }
  if (components.length === 0) {
    if (options.allowEmpty) return '';
    throw new SourcePackageError('invalid-path', 'Source paths cannot be empty.', input);
  }
  return components.join('/').toLowerCase();
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.charCodeAt(index);
    if (codePoint === 0 || codePoint < 0x20 || codePoint === 0x7f) return true;
  }
  return false;
}

/** Returns the extension without its dot for a canonical Source path. */
export function sourcePathExtension(path: string): string | undefined {
  const filename = path.slice(path.lastIndexOf('/') + 1);
  const extensionIndex = filename.lastIndexOf('.');
  if (extensionIndex <= 0 || extensionIndex === filename.length - 1) return undefined;
  return filename.slice(extensionIndex + 1).toLowerCase();
}

export function isSupportedTexturePath(path: string): boolean {
  const extension = sourcePathExtension(path);
  return extension !== undefined && SUPPORTED_TEXTURE_EXTENSION_SET.has(extension);
}

/**
 * Maps either a generated viewer URL (`textures/foo.webp`) or a Source
 * material reference into an extension-free `materials/...` asset identity.
 */
export function sourceTextureIdentity(reference: string): string {
  let path = normalizeSourcePath(reference, { allowLeadingSeparators: true });
  if (path.startsWith('textures/')) path = path.slice('textures/'.length);
  else if (path.startsWith('materials/')) path = path.slice('materials/'.length);
  path = path.replace(SOURCE_EXTENSION_PATTERN, '');
  if (!path) {
    throw new SourcePackageError('invalid-texture-reference', 'Texture references must name a material.', reference);
  }
  return normalizeSourcePath(`materials/${path}`);
}

/**
 * Orders package texture lookup deterministically. Explicit supported
 * extensions are attempted before the documented Source-compatible priority.
 */
export function sourceTextureCandidates(reference: string): string[] {
  const normalized = normalizeSourcePath(reference, { allowLeadingSeparators: true });
  const explicitExtension = sourcePathExtension(normalized);
  const identity = sourceTextureIdentity(normalized);
  // Generated viewer URLs always end in .webp, but that is the built-in
  // fallback encoding rather than an authored Source extension. Do not let it
  // outrank a package VTF for the same Source material identity.
  const generatedViewerUrl = normalized.startsWith('textures/');
  const extensions = !generatedViewerUrl && explicitExtension && SUPPORTED_TEXTURE_EXTENSION_SET.has(explicitExtension)
    ? [explicitExtension, ...SUPPORTED_TEXTURE_EXTENSIONS.filter((extension) => extension !== explicitExtension)]
    : SUPPORTED_TEXTURE_EXTENSIONS;
  return extensions.map((extension) => `${identity}.${extension}`);
}

/** Removes the supported extension, leaving an exact Source identity. */
export function sourcePathStem(path: string): string {
  const canonical = normalizeSourcePath(path);
  const extension = sourcePathExtension(canonical);
  return extension && SUPPORTED_TEXTURE_EXTENSION_SET.has(extension)
    ? canonical.slice(0, -(extension.length + 1))
    : canonical;
}

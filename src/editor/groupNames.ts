import reference from './groupNames.generated.json';

interface GroupNameEntry {
  readonly weapon: string;
  readonly groups: Readonly<Record<string, string>>;
}

interface GroupNameReference {
  readonly source: Readonly<{ title: string; url: string }>;
  readonly textures: Readonly<Record<string, GroupNameEntry>>;
}

const GROUP_NAME_REFERENCE = reference as GroupNameReference;

/**
 * The reference guide deliberately names every small element covered by a
 * group. That is invaluable documentation, but it makes a poor chip label.
 * Keep the guide's wording for titles and assistive labels, and use this
 * compact, deterministic summary for the visible editor UI.
 */
export function formatGroupNameForDisplay(name: string, maxLength = 42): string {
  const normalized = name.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;

  // Parenthetical notes are useful reference detail, but not part of the
  // immediate identity of a paintable part (for example, wear-map caveats).
  const withoutNotes = normalized.replace(/\s*\([^)]*\)/g, '').trim();
  if (withoutNotes.length <= maxLength) return withoutNotes;

  // Prefer retaining complete named parts over a character-level ellipsis.
  // A precise "+ N more" is short without pretending those parts do not
  // exist, and the full guide wording remains available in the tooltip.
  const parts = withoutNotes.split(/\s+\+\s+/).filter(Boolean);
  if (parts.length > 1) {
    for (let visibleCount = parts.length - 1; visibleCount >= 1; visibleCount -= 1) {
      const hiddenCount = parts.length - visibleCount;
      const candidate = `${parts.slice(0, visibleCount).join(' + ')} + ${hiddenCount} more`;
      if (candidate.length <= maxLength) return candidate;
    }
  }

  // Single, unusually descriptive guide entries have no safe semantic split.
  // Stop at a word boundary so their visible prefix remains exact.
  const ellipsis = '…';
  const cutAt = Math.max(1, maxLength - ellipsis.length);
  const prefix = withoutNotes.slice(0, cutAt);
  const boundary = prefix.lastIndexOf(' ');
  return `${(boundary > 0 ? prefix.slice(0, boundary) : prefix).trimEnd()}${ellipsis}`;
}

/**
 * Canonicalize a source-engine material reference for the local name table.
 * The compositor accepts several filename spellings (with extension, leading
 * `materials/`, or Windows separators); the guide lists the material path.
 */
export function normalizeGroupTextureReference(value: string): string {
  return value
    .trim()
    .replace(/\\/g, '/')
    .replace(/^materials\//i, '')
    .replace(/^textures\//i, '')
    .replace(/\.(?:vmt|vtf|webp|png)$/i, '')
    .replace(/^\/+/, '')
    .toLowerCase();
}

/**
 * Look up the visible part represented by a compositor bucket. Source group
 * maps occasionally use a nearby red value rather than an exact multiple of
 * 16, so the editor must compare with the same rounded bucket rule as the
 * shader instead of manufacturing a raw id from the bucket.
 */
export function lookupGroupNameForBucket(groupsRef: string, bucket: number): string | null {
  if (!Number.isInteger(bucket) || bucket < 1 || bucket > 16) return null;
  const texture = GROUP_NAME_REFERENCE.textures[normalizeGroupTextureReference(groupsRef)];
  if (!texture) return null;
  const names = new Set(Object.entries(texture.groups)
    .filter(([rawId]) => Math.round(Number(rawId) / 16) === bucket)
    .map(([, name]) => name));
  return names.size === 1 ? [...names][0] : null;
}

/**
 * Return the curated visible name for one raw group-map id, if one is known.
 * `null` means the reference does not cover this texture/id; callers should
 * use a neutral fallback rather than imply that the game supplied a name.
 */
export function lookupGroupName(groupsRef: string, rawGroupId: number): string | null {
  if (!Number.isInteger(rawGroupId) || rawGroupId < 1 || rawGroupId > 255) return null;
  const texture = GROUP_NAME_REFERENCE.textures[normalizeGroupTextureReference(groupsRef)];
  return texture?.groups[String(rawGroupId)] ?? null;
}

/** The named weapon represented by a reference texture, when the guide has it. */
export function lookupGroupNameWeapon(groupsRef: string): string | null {
  return GROUP_NAME_REFERENCE.textures[normalizeGroupTextureReference(groupsRef)]?.weapon ?? null;
}

export interface CompatibleGroupTexture {
  readonly ref: string;
  readonly label: string;
}

function groupTextureLayoutNumber(ref: string): number | null {
  const base = ref.split('/').at(-1) ?? ref;
  const match = base.match(/_groups(?:_?0*([1-9]\d*))?$/i);
  if (!match) return null;
  return match[1] === undefined ? 1 : Number(match[1]);
}

/** Return every curated stock group-map layout for the same weapon. */
export function compatibleGroupTextures(groupsRef: string): CompatibleGroupTexture[] {
  const current = GROUP_NAME_REFERENCE.textures[normalizeGroupTextureReference(groupsRef)];
  if (!current) return [];
  return Object.entries(GROUP_NAME_REFERENCE.textures)
    .filter(([, entry]) => entry.weapon === current.weapon)
    .map(([ref]) => ({ ref, number: groupTextureLayoutNumber(ref) }))
    .sort((left, right) => {
      if (left.number !== null && right.number !== null && left.number !== right.number) return left.number - right.number;
      if (left.number !== null) return -1;
      if (right.number !== null) return 1;
      return left.ref.localeCompare(right.ref);
    })
    .map(({ ref, number }, index) => ({
      ref,
      label: `Layout ${number ?? index + 1}`,
    }));
}

export const groupNameReferenceSource = GROUP_NAME_REFERENCE.source;

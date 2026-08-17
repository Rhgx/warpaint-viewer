interface GroupNameEntry {
  readonly weapon: string;
  readonly groups: Readonly<Record<string, string>>;
}

interface GroupNameReference {
  readonly source: Readonly<{ title: string; url: string }>;
  readonly textures: Readonly<Record<string, GroupNameEntry>>;
}

let groupNameReference: GroupNameReference | null = null;
let groupNameReferencePromise: Promise<void> | null = null;

/** Load the larger curated stock-weapon reference only when the editor needs it. */
export function loadGroupNameReference(): Promise<void> {
  if (groupNameReference) return Promise.resolve();
  if (!groupNameReferencePromise) {
    groupNameReferencePromise = import('./groupNames.generated.json').then(({ default: reference }) => {
      groupNameReference = reference as GroupNameReference;
    }).catch((cause) => {
      groupNameReferencePromise = null;
      throw cause;
    });
  }
  return groupNameReferencePromise;
}

// The community weapon guide does not cover the War Paint preview item. These
// names describe its stable texture-atlas regions and three visible paint cans.
const PAINTKIT_TOOL_GROUP_NAMES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'models/items/paintkit_tool/p_paintkit_tool_groups_two': {
    16: 'Upper Display', 32: 'Lower Display', 192: 'Canvas Back Cross Brace', 208: 'Paint Can Bodies',
    224: 'Left Paint Can Cap', 240: 'Center Paint Can Cap', 255: 'Right Paint Can Cap',
  },
  'models/items/paintkit_tool/p_paintkit_tool_groups_three': {
    16: 'Upper Display', 32: 'Center Display', 48: 'Lower Display', 192: 'Canvas Back Cross Brace',
    208: 'Paint Can Bodies', 224: 'Left Paint Can Cap', 240: 'Center Paint Can Cap', 255: 'Right Paint Can Cap',
  },
  'models/items/paintkit_tool/p_paintkit_tool_groups_three_large': {
    16: 'Large Upper Display', 32: 'Center Display', 48: 'Lower Display', 192: 'Canvas Back Cross Brace',
    208: 'Paint Can Bodies', 224: 'Left Paint Can Cap', 240: 'Center Paint Can Cap', 255: 'Right Paint Can Cap',
  },
  'models/items/paintkit_tool/p_paintkit_tool_groups_four': {
    16: 'Bottom Display', 48: 'Top Display', 80: 'Middle Display', 255: 'Display Dividers',
    32: 'Left Paint Can Cap', 64: 'Center Paint Can Cap', 96: 'Right Paint Can Cap', 128: 'Paint Can Bodies', 192: 'Canvas Back Cross Brace',
  },
  'models/items/paintkit_tool/p_paintkit_tool_groups_four_02': {
    255: 'Top Display', 16: 'Upper-Middle Display', 48: 'Lower-Middle Display', 80: 'Bottom Display',
    32: 'Left Paint Can Cap', 64: 'Center Paint Can Cap', 96: 'Right Paint Can Cap', 128: 'Paint Can Bodies', 192: 'Canvas Back Cross Brace',
    208: 'Canvas Back Panel', 144: 'Left Paint Can Label', 160: 'Center Paint Can Label', 176: 'Right Paint Can Label',
  },
  'models/items/paintkit_tool/p_paintkit_tool_groups_four_equal': {
    16: 'Top Display', 48: 'Upper-Middle Display', 80: 'Lower-Middle Display', 255: 'Bottom Display',
    32: 'Left Paint Can Cap', 64: 'Center Paint Can Cap', 96: 'Right Paint Can Cap', 128: 'Paint Can Bodies', 192: 'Canvas Back Cross Brace',
    208: 'Canvas Back Panel', 144: 'Left Paint Can Label', 160: 'Center Paint Can Label', 176: 'Right Paint Can Label',
  },
  'models/items/paintkit_tool/p_paintkit_tool_groups_left': {
    48: 'Left Display Upper', 80: 'Left Display Center', 112: 'Left Display Lower',
    16: 'Right Display', 32: 'Left Paint Can Cap', 64: 'Center Paint Can Cap', 96: 'Right Paint Can Cap',
    128: 'Paint Can Bodies', 192: 'Canvas Back Cross Brace', 208: 'Canvas Back Panel', 255: 'Display Divider',
    144: 'Left Paint Can Label', 160: 'Center Paint Can Label', 176: 'Right Paint Can Label',
  },
};

function additionalGroupName(groupsRef: string, rawGroupId: number): string | null {
  return PAINTKIT_TOOL_GROUP_NAMES[normalizeGroupTextureReference(groupsRef)]?.[String(rawGroupId)] ?? null;
}

/** Conventional Albedo assignments used by the stock War Paint preview item. */
export function preferredAlbedoGroupIds(groupsRef: string): readonly number[] {
  const normalized = normalizeGroupTextureReference(groupsRef);
  const groups = PAINTKIT_TOOL_GROUP_NAMES[normalized];
  if (!groups) return [];
  const defaults = normalized.endsWith('/p_paintkit_tool_groups_four')
    ? [144, 160, 176, 192, 255]
    : [144, 160, 176, 192];
  return defaults.filter((groupId) => groups[String(groupId)] !== undefined);
}

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
  const supplemental = additionalGroupName(groupsRef, bucket === 16 ? 255 : bucket * 16);
  if (supplemental) return supplemental;
  const texture = groupNameReference?.textures[normalizeGroupTextureReference(groupsRef)];
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
  const supplemental = additionalGroupName(groupsRef, rawGroupId);
  if (supplemental) return supplemental;
  const texture = groupNameReference?.textures[normalizeGroupTextureReference(groupsRef)];
  return texture?.groups[String(rawGroupId)] ?? null;
}

/** The named weapon represented by a reference texture, when the guide has it. */
export function lookupGroupNameWeapon(groupsRef: string): string | null {
  const normalized = normalizeGroupTextureReference(groupsRef);
  if (PAINTKIT_TOOL_GROUP_NAMES[normalized]) return 'War Paint';
  return groupNameReference?.textures[normalized]?.weapon ?? null;
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
  const normalized = normalizeGroupTextureReference(groupsRef);
  if (PAINTKIT_TOOL_GROUP_NAMES[normalized]) {
    return Object.keys(PAINTKIT_TOOL_GROUP_NAMES).map((ref, index) => ({
      ref,
      label: `Layout ${index + 1}`,
    }));
  }
  const current = groupNameReference?.textures[normalized];
  if (!current) return [];
  return Object.entries(groupNameReference?.textures ?? {})
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

export const groupNameReferenceSource = {
  title: 'War Paint Texture Groups Reference for War Paint Authors',
  url: 'https://steamcommunity.com/sharedfiles/filedetails/?id=3035470027',
} as const;

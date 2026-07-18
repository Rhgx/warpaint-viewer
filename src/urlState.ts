// Pure helpers for syncing a slice of app state to the URL's query string
// and parsing it back out on boot. Deliberately has no imports (not even the
// pure viewer/presets module) so it stays trivial to reason about; params
// with a closed enum of valid ids (sheen, effect, light) are format-checked
// here but not validated against the live preset lists, since the viewer
// layer already falls back safely on an unknown preset id.
//
// App.tsx owns the actual read/write timing (debounce, "don't write before
// boot picks a default", manifest-aware fallback for kit/weapon), this
// module only turns a query string into validated primitives and back.

export interface ParsedUrlState {
  kitId: number | null;
  weaponKey: string | null;
  seed: string | null;
  wearIndex: number | null;
  team: 'red' | 'blu' | null;
  sheen: string | null;
  unusual: string | null;
  preset: string | null;
  projection: 'perspective' | 'orthographic' | null;
  fov: number | null;
}

export interface SerializableUrlState {
  kitId: number | null;
  weaponKey: string;
  seed: string;
  wearIndex: number;
  team: 'red' | 'blu';
  sheen: string;
  unusual: string;
  preset: string;
  projection: 'perspective' | 'orthographic';
  fov: number;
}

// Params this module reads/writes. Anything else already on the URL
// (selftest, data, perftest, sortdesc, ...) is preserved untouched by
// serializeUrlState.
const OWNED_PARAMS = ['kit', 'weapon', 'seed', 'wear', 'team', 'sheen', 'effect', 'light', 'proj', 'fov'] as const;

export const URL_STATE_DEFAULTS = {
  wearIndex: 0,
  team: 'red' as const,
  sheen: 'none',
  unusual: 'none',
  preset: 'inspect',
  projection: 'perspective' as const,
  fov: 75,
};

const FOV_MIN = 30;
const FOV_MAX = 110;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function parseUrlState(search: string): ParsedUrlState {
  const params = new URLSearchParams(search);

  const kitRaw = params.get('kit');
  const kitId = kitRaw !== null && /^\d+$/.test(kitRaw) ? Number(kitRaw) : null;

  const weaponRaw = params.get('weapon');
  const weaponKey = weaponRaw && weaponRaw.trim() ? weaponRaw : null;

  // Mirrors the manual seed field's own commit path (Inspector.tsx): digits
  // only, capped at 20 of them, then wrapped into the same 64-bit range a
  // composited seed actually uses.
  const seedRaw = params.get('seed');
  const seed = seedRaw && /^\d+$/.test(seedRaw)
    ? BigInt.asUintN(64, BigInt(seedRaw.slice(0, 20))).toString()
    : null;

  const wearRaw = params.get('wear');
  const wearIndex = wearRaw !== null && /^\d+$/.test(wearRaw) ? clamp(Number(wearRaw), 0, 4) : null;

  const teamRaw = params.get('team');
  const team = teamRaw === 'red' || teamRaw === 'blu' ? teamRaw : null;

  const sheenRaw = params.get('sheen');
  const sheen = sheenRaw && sheenRaw.trim() ? sheenRaw : null;

  const unusualRaw = params.get('effect');
  const unusual = unusualRaw && unusualRaw.trim() ? unusualRaw : null;

  const presetRaw = params.get('light');
  const preset = presetRaw && presetRaw.trim() ? presetRaw : null;

  const projRaw = params.get('proj');
  const projection = projRaw === 'ortho' ? 'orthographic' : projRaw === 'perspective' ? 'perspective' : null;

  const fovRaw = params.get('fov');
  const fov = fovRaw !== null && /^\d+$/.test(fovRaw) ? clamp(Number(fovRaw), FOV_MIN, FOV_MAX) : null;

  return { kitId, weaponKey, seed, wearIndex, team, sheen, unusual, preset, projection, fov };
}

// Rewrites only the params this module owns, leaving everything else on the
// current query string (order, unrelated flags) intact. Returns the full
// query string including a leading '?', or '' if empty.
export function serializeUrlState(currentSearch: string, state: SerializableUrlState): string {
  const params = new URLSearchParams(currentSearch);
  for (const key of OWNED_PARAMS) params.delete(key);

  if (state.kitId != null) params.set('kit', String(state.kitId));
  if (state.weaponKey) params.set('weapon', state.weaponKey);
  if (state.seed) params.set('seed', state.seed);
  if (state.wearIndex !== URL_STATE_DEFAULTS.wearIndex) params.set('wear', String(state.wearIndex));
  if (state.team !== URL_STATE_DEFAULTS.team) params.set('team', state.team);
  if (state.sheen !== URL_STATE_DEFAULTS.sheen) params.set('sheen', state.sheen);
  if (state.unusual !== URL_STATE_DEFAULTS.unusual) params.set('effect', state.unusual);
  if (state.preset !== URL_STATE_DEFAULTS.preset) params.set('light', state.preset);
  if (state.projection !== URL_STATE_DEFAULTS.projection) {
    params.set('proj', state.projection === 'orthographic' ? 'ortho' : state.projection);
  }
  if (state.fov !== URL_STATE_DEFAULTS.fov) params.set('fov', String(state.fov));

  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

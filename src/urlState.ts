// Compact, versioned share-state codec. The binary payload lives in #v= so it
// is not sent to the web server; unrelated query flags remain untouched.

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

export interface SerializedUrlState {
  search: string;
  hash: string;
}

const LEGACY_PARAMS = ['view', 'kit', 'weapon', 'seed', 'wear', 'team', 'sheen', 'effect', 'light', 'proj', 'fov'] as const;

export const URL_STATE_DEFAULTS = {
  wearIndex: 0,
  team: 'red' as const,
  sheen: 'none',
  unusual: 'none',
  preset: 'inspect',
  projection: 'perspective' as const,
  fov: 75,
};

const VERSION = 1;
const FOV_MIN = 30;
const FOV_MAX = 110;

const FLAG_BLU = 1 << 0;
const FLAG_ORTHO = 1 << 1;
const FLAG_WEAR = 1 << 2;
const FLAG_SHEEN = 1 << 3;
const FLAG_EFFECT = 1 << 4;
const FLAG_LIGHT = 1 << 5;
const FLAG_FOV = 1 << 6;

// These positions are part of the public share-link schema. Append new ids;
// never reorder or remove an existing entry.
const WEAPON_IDS = [
  'c_amputator', 'c_atom_launcher', 'c_back_scratcher', 'c_battleaxe', 'c_bazaar_sniper',
  'c_blackbox', 'c_claidheamohmor', 'c_crusaders_crossbow', 'c_degreaser', 'c_demo_cannon',
  'c_demo_sultan_sword', 'c_detonator', 'c_flameball', 'c_flamethrower', 'c_gatling_gun',
  'c_grenadelauncher', 'c_holymackerel', 'c_jag', 'c_knife', 'c_lochnload', 'c_medigun',
  'c_minigun', 'c_pistol', 'c_powerjack', 'c_quadball', 'c_reserve_shooter', 'c_revolver',
  'c_riding_crop', 'c_rocketlauncher', 'c_russian_riot', 'c_scattergun', 'c_scimitar',
  'c_scorch_shot', 'c_shortstop', 'c_shotgun', 'c_smg', 'c_sniperrifle', 'c_soda_popper',
  'c_stickybomb_launcher', 'c_tele_shotgun', 'c_tomislav', 'c_trenchgun', 'c_ubersaw',
  'c_winger_pistol', 'c_wrench',
] as const;

const SHEEN_IDS = ['none', 'team_shine', 'deadly_daffodil', 'manndarin', 'mean_green', 'agonizing_emerald', 'villainous_violet', 'hot_rod'] as const;
const EFFECT_IDS = ['none', 'hot', 'isotope', 'cool', 'energy_orb'] as const;
const LIGHT_IDS = ['inspect', 'daylight', 'overcast', 'indoors', 'night'] as const;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

class Writer {
  readonly bytes: number[] = [];

  uint(value: number) {
    let current = Math.floor(value);
    do {
      let byte = current % 128;
      current = Math.floor(current / 128);
      if (current) byte |= 0x80;
      this.bytes.push(byte);
    } while (current);
  }

  uint64(value: bigint) {
    let current = BigInt.asUintN(64, value);
    for (let i = 0; i < 8; i++) {
      this.bytes.push(Number(current & 0xffn));
      current >>= 8n;
    }
  }

  text(value: string) {
    const encoded = new TextEncoder().encode(value);
    this.uint(encoded.length);
    this.bytes.push(...encoded);
  }

  stableId(value: string, table: readonly string[]) {
    const index = table.indexOf(value);
    this.uint(index < 0 ? 0 : index + 1);
    if (index < 0) this.text(value);
  }
}

class Reader {
  private offset = 0;
  private readonly bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  get done() { return this.offset === this.bytes.length; }

  uint(): number {
    let value = 0;
    let multiplier = 1;
    for (let i = 0; i < 8; i++) {
      const byte = this.bytes[this.offset++];
      if (byte == null) throw new Error('Unexpected end of share state');
      value += (byte & 0x7f) * multiplier;
      if (!(byte & 0x80)) {
        if (!Number.isSafeInteger(value)) throw new Error('Share integer is too large');
        return value;
      }
      multiplier *= 128;
    }
    throw new Error('Invalid share integer');
  }

  uint64(): bigint {
    let value = 0n;
    for (let i = 0; i < 8; i++) {
      const byte = this.bytes[this.offset++];
      if (byte == null) throw new Error('Unexpected end of share state');
      value |= BigInt(byte) << BigInt(i * 8);
    }
    return value;
  }

  text(): string {
    const length = this.uint();
    const end = this.offset + length;
    if (end > this.bytes.length) throw new Error('Unexpected end of share state');
    const value = new TextDecoder('utf-8', { fatal: true }).decode(this.bytes.subarray(this.offset, end));
    this.offset = end;
    return value;
  }

  stableId(table: readonly string[]): string {
    const id = this.uint();
    if (id === 0) return this.text();
    const value = table[id - 1];
    if (!value) throw new Error('Unknown stable share id');
    return value;
  }
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid share encoding');
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export function encodeShareState(state: SerializableUrlState): string | null {
  if (state.kitId == null || !state.weaponKey || !state.seed) return null;

  let flags = 0;
  if (state.team !== URL_STATE_DEFAULTS.team) flags |= FLAG_BLU;
  if (state.projection !== URL_STATE_DEFAULTS.projection) flags |= FLAG_ORTHO;
  if (state.wearIndex !== URL_STATE_DEFAULTS.wearIndex) flags |= FLAG_WEAR;
  if (state.sheen !== URL_STATE_DEFAULTS.sheen) flags |= FLAG_SHEEN;
  if (state.unusual !== URL_STATE_DEFAULTS.unusual) flags |= FLAG_EFFECT;
  if (state.preset !== URL_STATE_DEFAULTS.preset) flags |= FLAG_LIGHT;
  if (state.fov !== URL_STATE_DEFAULTS.fov) flags |= FLAG_FOV;

  const writer = new Writer();
  writer.uint(VERSION);
  writer.uint(flags);
  writer.uint(state.kitId);
  writer.stableId(state.weaponKey, WEAPON_IDS);
  writer.uint64(BigInt(state.seed));
  if (flags & FLAG_WEAR) writer.uint(clamp(state.wearIndex, 0, 4));
  if (flags & FLAG_SHEEN) writer.stableId(state.sheen, SHEEN_IDS);
  if (flags & FLAG_EFFECT) writer.stableId(state.unusual, EFFECT_IDS);
  if (flags & FLAG_LIGHT) writer.stableId(state.preset, LIGHT_IDS);
  if (flags & FLAG_FOV) writer.uint(clamp(state.fov, FOV_MIN, FOV_MAX) - FOV_MIN);
  return toBase64Url(Uint8Array.from(writer.bytes));
}

export function decodeShareState(payload: string): ParsedUrlState | null {
  try {
    const reader = new Reader(fromBase64Url(payload));
    if (reader.uint() !== VERSION) return null;
    const flags = reader.uint();
    if (flags & ~0x7f) return null;
    const kitId = reader.uint();
    const weaponKey = reader.stableId(WEAPON_IDS);
    const seed = reader.uint64().toString();
    const wearIndex = flags & FLAG_WEAR ? clamp(reader.uint(), 0, 4) : null;
    const sheen = flags & FLAG_SHEEN ? reader.stableId(SHEEN_IDS) : null;
    const unusual = flags & FLAG_EFFECT ? reader.stableId(EFFECT_IDS) : null;
    const preset = flags & FLAG_LIGHT ? reader.stableId(LIGHT_IDS) : null;
    const fov = flags & FLAG_FOV ? clamp(reader.uint() + FOV_MIN, FOV_MIN, FOV_MAX) : null;
    if (!reader.done) return null;

    return {
      kitId,
      weaponKey,
      seed,
      wearIndex,
      team: flags & FLAG_BLU ? 'blu' : null,
      sheen,
      unusual,
      preset,
      projection: flags & FLAG_ORTHO ? 'orthographic' : null,
      fov,
    };
  } catch {
    return null;
  }
}

export function parseUrlState(search: string, hash = ''): ParsedUrlState {
  const fragment = new URLSearchParams(hash.replace(/^#/, ''));
  const shared = fragment.get('v');
  if (shared) {
    const decoded = decodeShareState(shared);
    if (decoded) return decoded;
  }

  // Temporary migration fallback for the original readable query format.
  const params = new URLSearchParams(search);
  const kitRaw = params.get('kit');
  const kitId = kitRaw !== null && /^\d+$/.test(kitRaw) ? Number(kitRaw) : null;
  const weaponRaw = params.get('weapon');
  const weaponKey = weaponRaw && weaponRaw.trim() ? weaponRaw : null;
  const seedRaw = params.get('seed');
  const seed = seedRaw && /^\d+$/.test(seedRaw) ? BigInt.asUintN(64, BigInt(seedRaw.slice(0, 20))).toString() : null;
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

export function serializeUrlState(currentSearch: string, state: SerializableUrlState): SerializedUrlState {
  const params = new URLSearchParams(currentSearch);
  for (const key of LEGACY_PARAMS) params.delete(key);
  const qs = params.toString();
  const payload = encodeShareState(state);
  return { search: qs ? `?${qs}` : '', hash: payload ? `#v=${payload}` : '' };
}

import * as THREE from 'three';

// Embedded VTF 7.3+ sprite-sheet resource, converted at extraction time to
// just clamp + uv rect per frame (see tools/extract-effects.mjs
// sheetToIndexShape). Every sheet currently extracted has frameCount 1 per
// sequence (no intra-sheet animation), so "frames" here is a single [x0,y0,x1,y1].
export interface ParticleSheet {
  sequences: Array<{ clamp: boolean; frames: Array<[number, number, number, number]> }>;
}

export interface ParticleIndexEntry {
  file?: string;
  frames?: number;
  width?: number;
  height?: number;
  additive?: boolean;
  shader?: string | null;
  sheet?: ParticleSheet;
  // Set for materials confirmed absent from the TF2 install itself (see extract-effects.mjs'
  // KNOWN_MISSING_MATERIALS - currently empty; kept as real infrastructure for the day a genuinely
  // missing material shows up in a correctly-extracted .pcf). No `file` exists for these entries;
  // SystemInstance keeps simulating particles that use this material but skips creating their
  // render side, matching how the real game silently fails to draw a particle system whose
  // material can't be resolved.
  missing?: boolean;
}

export type ParticleIndex = Record<string, ParticleIndexEntry>;

// Per-weapon attachment control points, in GEOMETRY space (the same space as
// the glb vertex positions: raw, uncentered). v2 entries carry the attachment
// orientation ({pos, quat}); v1 entries are bare [x, y, z] positions and get
// the fixed Source-to-glb axis convention as their frame.
export type AttachmentEntryJson = [number, number, number] | { pos: [number, number, number]; quat: [number, number, number, number] };
export type AttachmentsJson = Record<string, Record<string, AttachmentEntryJson>>;

let particleIndexPromise: Promise<ParticleIndex> | null = null;
export function loadParticleIndex(): Promise<ParticleIndex> {
  if (!particleIndexPromise) {
    const base = import.meta.env.BASE_URL;
    particleIndexPromise = fetch(`${base}data/effects/particles/index.json`).then((r) => {
      if (!r.ok) throw new Error(`particles index.json fetch failed: ${r.status}`);
      return r.json() as Promise<ParticleIndex>;
    });
  }
  return particleIndexPromise;
}

const particleTextureCache = new Map<string, Promise<THREE.Texture>>();
export function loadParticleTexture(file: string): Promise<THREE.Texture> {
  let promise = particleTextureCache.get(file);
  if (!promise) {
    const base = import.meta.env.BASE_URL;
    promise = new THREE.TextureLoader().loadAsync(`${base}data/effects/particles/${file}`).then((t) => {
      t.colorSpace = THREE.SRGBColorSpace;
      t.wrapS = THREE.ClampToEdgeWrapping;
      t.wrapT = THREE.ClampToEdgeWrapping;
      t.needsUpdate = true;
      return t;
    });
    particleTextureCache.set(file, promise);
  }
  return promise;
}

let sharedDotTexture: THREE.Texture | null = null;
export function dotTexture(): THREE.Texture {
  if (sharedDotTexture) return sharedDotTexture;
  const size = 64;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d')!;
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.4, 'rgba(255,255,255,0.7)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  sharedDotTexture = new THREE.CanvasTexture(c);
  sharedDotTexture.colorSpace = THREE.SRGBColorSpace;
  return sharedDotTexture;
}

export async function resolveParticleTexture(
  materialRef: unknown,
): Promise<{ texture: THREE.Texture; frames: number; additive: boolean; sheet: ParticleSheet | null }> {
  if (typeof materialRef === 'string') {
    try {
      const index = await loadParticleIndex();
      const entry = index[materialRef];
      // entry.missing (no `file`) is resolved synchronously before this ever runs - see the
      // materialMissing check in SystemInstance's constructor - so this branch is defensive only.
      if (entry && !entry.missing && entry.file) {
        const texture = await loadParticleTexture(entry.file);
        const additive = typeof entry.additive === 'boolean' ? entry.additive : true;
        return { texture, frames: Math.max(1, entry.frames ?? 1), additive, sheet: entry.sheet ?? null };
      }
    } catch {
      // fall through to the generated fallback dot
    }
  }
  return { texture: dotTexture(), frames: 1, additive: true, sheet: null };
}

export function numOr(v: unknown, def: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : def;
}

export function colorFromArray(v: unknown): THREE.Color | null {
  if (!Array.isArray(v) || v.length < 3) return null;
  return new THREE.Color().setRGB(v[0] / 255, v[1] / 255, v[2] / 255, THREE.SRGBColorSpace);
}

const warnedOnce = new Set<string>();
export function warnOnce(key: string, msg: string) {
  if (warnedOnce.has(key)) return;
  warnedOnce.add(key);
  console.warn(`[warpaint-viewer] ${msg}`);
}

// Fixed attachment frame used when attachments.json still carries bare [x,y,z]
// positions (format v1): Source attachment-local +X (forward) maps to glb +Z,
// +Y (left) to glb -X, +Z (up) to glb +Y. This is the same convention the old
// mapAttachmentLocal swizzle encoded, expressed as a rotation so all CP-local
// math can go through one quaternion path.
export const DEFAULT_ATTACHMENT_QUAT = new THREE.Quaternion().setFromRotationMatrix(
  new THREE.Matrix4().set(
    0, -1, 0, 0,
    0, 0, 1, 0,
    1, 0, 0, 0,
    0, 0, 0, 1,
  ),
);

export interface AttachmentAnchor {
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
}

export function parseAttachmentEntry(entry: AttachmentEntryJson | undefined): AttachmentAnchor | null {
  if (!entry) return null;
  if (Array.isArray(entry)) {
    return { pos: new THREE.Vector3(entry[0], entry[1], entry[2]), quat: DEFAULT_ATTACHMENT_QUAT.clone() };
  }
  const p = entry.pos;
  const q = entry.quat;
  if (!Array.isArray(p) || p.length < 3) return null;
  const quat = Array.isArray(q) && q.length >= 4
    ? new THREE.Quaternion(q[0], q[1], q[2], q[3]).normalize()
    : DEFAULT_ATTACHMENT_QUAT.clone();
  return { pos: new THREE.Vector3(p[0], p[1], p[2]), quat };
}

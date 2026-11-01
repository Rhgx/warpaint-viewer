import * as THREE from 'three';

// Embedded VTF 7.3+ sprite sheet, converted at extraction time to a clamp and uv rect
// per frame. Every extracted sheet has one frame per sequence, so a frame is [x0,y0,x1,y1].
export interface ParticleSheet {
  sequences: Array<{ clamp: boolean; frames: Array<[number, number, number, number]> }>;
}

interface ParticleIndexEntry {
  file?: string;
  frames?: number;
  width?: number;
  height?: number;
  additive?: boolean;
  shader?: string | null;
  sheet?: ParticleSheet;
  // Set for materials confirmed absent from the TF2 install. These have no `file`, so
  // SystemInstance simulates their particles but skips the render side, as the game does.
  missing?: boolean;
}

export type ParticleIndex = Record<string, ParticleIndexEntry>;

// Per-weapon attachment control points in geometry space (raw, uncentered, like the glb
// vertices). v2 adds an orientation ({pos, quat}); v3 also keeps the parent bone. v1 is
// bare [x, y, z] and gets the fixed Source-to-glb frame (DEFAULT_ATTACHMENT_QUAT).
type AttachmentEntryJson = [number, number, number] | {
  pos: [number, number, number];
  quat: [number, number, number, number];
  bone?: string;
};
export type AttachmentsJson = Record<string, Record<string, AttachmentEntryJson>>;
export interface HitboxJson {
  min: [number, number, number];
  max: [number, number, number];
  transform: [number, number, number, number, number, number, number, number, number, number, number, number];
  fallback?: 'hull';
}
export type HitboxesJson = Record<string, HitboxJson[]>;

let particleIndexPromise: Promise<ParticleIndex> | null = null;
let hitboxesPromise: Promise<HitboxesJson> | null = null;
export function loadHitboxes(): Promise<HitboxesJson> {
  if (!hitboxesPromise) {
    const base = import.meta.env.BASE_URL;
    hitboxesPromise = fetch(`${base}data/effects/hitboxes.json`).then((r) => {
      if (!r.ok) throw new Error(`hitboxes.json fetch failed: ${r.status}`);
      return r.json() as Promise<HitboxesJson>;
    });
  }
  return hitboxesPromise;
}

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
function loadParticleTexture(file: string): Promise<THREE.Texture> {
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
      // Missing entries are resolved in SystemInstance's constructor, so this is defensive only.
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

// Frame for v1 bare [x, y, z] attachments: Source +X (forward) maps to glb +Z, +Y (left)
// to glb -X, and +Z (up) to glb +Y. Stored as a quaternion so all CP math takes one path.
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
  bone?: string;
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
  return { pos: new THREE.Vector3(p[0], p[1], p[2]), quat, bone: entry.bone };
}

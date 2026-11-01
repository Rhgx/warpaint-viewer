// Mockup engine for the collection showcase board: a pegboard in the style of
// Valve's case announcements where painted weapons are dragged onto a grid,
// rotated within limits, posed, and exported as one image.
//
// The board runs its own renderer and its own compositor, so every weapon on
// it can carry a different war paint without touching the main viewer.

import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { Compositor, type ComposeResult } from '../compositor/compositor';
import { configureTf2Material, createTf2Uniforms, type Tf2Uniforms } from '../viewer/materialConfig';
import { TF2_VERTEXLIT_CACHE_KEY, installTf2VertexLit } from '../viewer/shaders/vertexlit';
import { loadEditorEnvCube, makeEnvCube } from '../viewer/env';
import type { RecipeNode, TextureResolver } from '../compositor/types';
import type { TextureMetadata, WeaponEntry, WeaponMaterial } from '../data/types';
import type { LayoutPacking, LayoutRows } from './layouts';
import { HANGING_PARTS, POSE_RIGS, WEAPON_PARTS, defaultPose, isRigged, partOf, type PoseControl, type RestBone, type WeaponPart } from './poseRigs';

export const BOARD_WIDTH = 200;
export const BOARD_HEIGHT = 112;
const FRAME_SIDE = 7;
const RESTING_LIFT = 1.4;
const CARRY_LIFT = 7;
/** Tilt and turn stay small so every weapon still reads as a side profile on the pegboard. */
export const TILT_LIMIT = 30;
/** How big a weapon at 100% is relative to its in-game size; every weapon shares it, so relative sizes stay true. */
const BASE_SCALE = 1.5;
/** Sizes a layout may give its weapons: the size slider's top, and small enough for a full board. */
const LAYOUT_SCALE = { min: 0.25, max: 1.5 };
/**
 * Paint resolutions a weapon may get: composed no larger than it is drawn (on
 * screen or in an export), so small weapons never wait on full-size textures.
 */
const PAINT_SIZE = { min: 256, max: 1024 };
/**
 * Sources are never decoded below this. Decoding costs the same at any size,
 * so one size shared by most paints decodes each texture once and lets a
 * layout decode its sources before it is picked.
 */
const MIN_SOURCE_SIZE = 512;
/** Paint texels per drawn pixel along the weapon; its side covers only part of the paint. */
const PAINT_TEXELS_PER_PIXEL = 1.25;
const SILHOUETTE_PX_PER_CELL = 8;
const MAX_CELL_MARKERS = 6000;
const HISTORY_LIMIT = 100;

/**
 * Dual-core laptops with integrated graphics get a smaller, cheaper shadow map.
 * Matches the device heuristics the compositor cache already uses.
 */
const LOW_END = (navigator.hardwareConcurrency ?? 8) <= 4
  || ((navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8) <= 4;

const copyItem = (item: ShowcaseItem): ShowcaseItem => ({ ...item, paint: { ...item.paint }, pose: { ...item.pose }, hiddenParts: [...item.hiddenParts] });

export type GridSize = 'fine' | 'normal' | 'coarse';
export const GRID_CELL: Record<GridSize, number> = { fine: 1.25, normal: 2.5, coarse: 5 };
export type BoardBackground = 'framed' | 'pegboard' | 'transparent';

/** The paint on one item, with its own wear, team and pattern seed. */
export interface ShowcasePaint {
  kitId: number;
  kitName: string;
  team: 'red' | 'blu';
  wearIndex: number;
  seed: string;
}

export interface ShowcaseItem {
  id: string;
  weaponKey: string;
  weaponName: string;
  paint: ShowcasePaint;
  x: number;
  y: number;
  roll: number;
  tilt: number;
  turn: number;
  flipped: boolean;
  /** Size on the board as a multiple of the default size, which keeps sizes true to each other. */
  scale: number;
  /** Hidden layers stay in the list but are not drawn, exported, or checked for fit. */
  hidden: boolean;
  pose: Record<string, number>;
  /** Set when this item is a piece taken out of its weapon, such as a shell. */
  part: string | null;
  /** Pieces of this weapon left out of it, usually because they were taken out. */
  hiddenParts: readonly string[];
}

/** Where a pose control's drag handle is on screen, in canvas pixels. */
export interface PoseHandle {
  controlId: string;
  x: number;
  y: number;
}

export type FitProblem = { kind: 'outside' } | { kind: 'overlap'; otherName: string } | null;

export interface ShowcaseSnapshot {
  items: readonly ShowcaseItem[];
  selectedId: string | null;
  problems: Readonly<Record<string, FitProblem>>;
  /** Live feedback while dragging or rotating; null when idle. */
  pending: { id: string; problem: FitProblem } | null;
  dragging: boolean;
  canUndo: boolean;
  canRedo: boolean;
}

export interface ShowcaseBoardOptions {
  canvas: HTMLCanvasElement;
  weapons: readonly WeaponEntry[];
  modelUrl: (weapon: WeaponEntry, rigged: boolean) => string;
  resolveTexture: TextureResolver;
  textureMetadata?: Record<string, TextureMetadata>;
  textureMetadataResolver?: (ref: string) => Partial<TextureMetadata> | undefined;
  resolveRecipe: (kitId: number, weaponKey: string, team: 'red' | 'blu', wearIndex: number) => Promise<RecipeNode | null>;
  /** The material a paint swaps in for a weapon, if any; otherwise the weapon wears its own. */
  materialOverride: (weaponKey: string, kitId: number) => WeaponMaterial | undefined;
  /** Face URLs for a material's $envmap, or null to reflect the default cubemap. */
  resolveCubemap: (ref: string) => Promise<string[] | null>;
}

interface Footprint {
  /** Every covered cell; other weapons keep their distance from all of them. */
  cells: Set<number>;
  /** Cells the weapon itself covers, leaving out pieces allowed past the board's edge. */
  solid: Set<number>;
  /** Bounds of the weapon without those pieces, relative to its position. */
  body: { minX: number; minY: number; maxX: number; maxY: number };
  /** Covered silhouette pixels, row 0 at the top. */
  mask: Uint8Array;
  maskWidth: number;
  maskHeight: number;
  originX: number;
  originY: number;
  width: number;
  height: number;
  minZ: number;
  maxZ: number;
  version: number;
}

interface ItemRuntime {
  item: ShowcaseItem;
  root: THREE.Group;
  orient: THREE.Group;
  meshes: THREE.Mesh[];
  bones: Map<string, RestBone>;
  footprint: Footprint | null;
  material: THREE.MeshPhongMaterial;
  uniforms: Tf2Uniforms;
  /** Which material settings and maps the TF2 shader is configured with. */
  materialKey: string;
  /** The material names its own $envmap rather than reflecting the board's default. */
  customEnvMap?: boolean;
  /** Height of whatever this weapon rests on when overlaps are allowed. */
  stackZ: number;
  /**
   * Posed vertex positions below the rotation, so a rotation only needs one
   * matrix per vertex instead of re-skinning. Rebuilt when the pose or side changes.
   */
  local: {
    key: string;
    positions: Float32Array[];
    projected: Float32Array[];
    indices: (ArrayLike<number> | null)[];
    /** Per mesh, 1 for each vertex on a piece allowed to hang past the board's edge. */
    hanging: (Uint8Array | null)[];
  } | null;
  /** The paint the material shows or is waiting on. */
  paintKey: string;
  /** Settles once the material's own maps (normal, phong, cubemap...) are on. */
  materialReady: Promise<void>;
  /** Resolution of the paint it wears or is waiting on; it only ever grows. */
  paintSize: number;
  /** Which bones' triangles are drawn; changes when a piece is taken out or put back. */
  visibility: string;
  /** Per mesh, the vertices still drawn and the triangles renumbered onto them; null draws everything. */
  subsets: (MeshSubset | null)[];
}

interface MeshSubset {
  used: Uint32Array;
  /** Triangles numbered by position in `used`, for the footprint. */
  index: Uint32Array;
  /** The same triangles on the original vertices, for drawing. */
  drawIndex: Uint32Array;
}

interface DragState {
  id: string;
  grabX: number;
  grabY: number;
  fromX: number;
  fromY: number;
  external: boolean;
  candidate: { x: number; y: number } | null;
}

const cellKey = (i: number, j: number) => (i + 2048) * 4096 + (j + 2048);
const keyI = (key: number) => Math.floor(key / 4096) - 2048;
const keyJ = (key: number) => (key % 4096) - 2048;

let idCounter = 0;

/**
 * The viewer's TF2 VertexLitGeneric shading on a board weapon: phong and
 * environment reflections masked by the paint's alpha, rim light, and the
 * self-illuminated sheen of Macaw override materials. The shader decodes the
 * sRGB composite itself.
 */
function makeTf2Material(uniforms: Tf2Uniforms, envMap: THREE.CubeTexture): THREE.MeshPhongMaterial {
  const material = new THREE.MeshPhongMaterial({
    color: 0x9a9a9a,
    shininess: 30,
    specular: new THREE.Color(0x333333),
    envMap,
    combine: THREE.AddOperation,
    reflectivity: 1,
  });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    installTf2VertexLit(shader);
  };
  material.customProgramCacheKey = () => `${TF2_VERTEXLIT_CACHE_KEY}-showcase`;
  return material;
}

/**
 * The TF2 shader leaves out three's 1/pi Lambert factor, as Source does, so
 * lights run at Source strength and the board's own Lambert surfaces are
 * brightened by pi to look as they always have.
 */
const SOURCE_LIGHT_SCALE = 1 / Math.PI;

function pegboardTexture(): THREE.CanvasTexture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#6b5843';
  ctx.fillRect(0, 0, size, size);
  // Fibre noise keeps large boards from looking flat.
  for (let i = 0; i < 260; i += 1) {
    ctx.fillStyle = `rgba(${Math.random() < 0.5 ? '40,30,20' : '150,125,95'},${0.06 + Math.random() * 0.06})`;
    ctx.fillRect(Math.random() * size, Math.random() * size, 1 + Math.random() * 3, 1);
  }
  const hole = ctx.createRadialGradient(size / 2 - 2, size / 2 - 2, 1, size / 2, size / 2, size * 0.2);
  hole.addColorStop(0, '#1d150e');
  hole.addColorStop(0.75, '#2c2117');
  hole.addColorStop(1, 'rgba(60,45,32,0)');
  ctx.fillStyle = hole;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size * 0.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(180,150,115,0.35)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(size / 2 + 0.5, size / 2 + 0.5, size * 0.19, 0.1 * Math.PI, 0.65 * Math.PI);
  ctx.stroke();
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 8;
  return texture;
}

function vignetteTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 288;
  const ctx = canvas.getContext('2d')!;
  const gradient = ctx.createRadialGradient(256, 144, 60, 256, 144, 300);
  gradient.addColorStop(0, 'rgba(0,0,0,0)');
  gradient.addColorStop(1, 'rgba(0,0,0,0.55)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 512, 288);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function frameTexture(width: number, height: number): THREE.CanvasTexture {
  const scale = 8;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext('2d')!;
  const metal = ctx.createLinearGradient(0, 0, canvas.width * 0.35, canvas.height);
  metal.addColorStop(0, '#4a4d52');
  metal.addColorStop(0.45, '#2b2e32');
  metal.addColorStop(1, '#1f2225');
  ctx.fillStyle = metal;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const lip = (FRAME_SIDE - 0.6) * scale;
  ctx.strokeStyle = '#8d9196';
  ctx.lineWidth = 0.8 * scale;
  ctx.strokeRect(lip, lip, canvas.width - lip * 2, canvas.height - lip * 2);
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.lineWidth = scale * 0.5;
  ctx.strokeRect(scale * 0.4, scale * 0.4, canvas.width - scale * 0.8, canvas.height - scale * 0.8);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

type Axis = 0 | 1 | 2;
const AXIS_VECTORS = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];

/**
 * Weapons whose thinnest axis is not the side worth showing. The crossbow is
 * widest across its limbs, but reads best in profile like the other guns.
 */
const FACE_AXIS_OVERRIDES: Record<string, Axis> = { c_crusaders_crossbow: 0 };

/**
 * Weapons that rest standing rather than lying: the Back Scratcher hangs like
 * a rake on a pegboard, handle down and head up with its tines toward the viewer.
 */
const RESTING_ROLL: Record<string, number> = { c_back_scratcher: -90 };

/** Weapons whose working end rests pointing right, where every other weapon's points left. */
const FACES_RIGHT = new Set(['c_powerjack']);

/** The roll a weapon rests at; a piece taken out of one lies flat. */
export function restingRoll(weaponKey: string, part: string | null): number {
  return part ? 0 : RESTING_ROLL[weaponKey] ?? 0;
}

/**
 * Rest orientation on the board: the longest axis runs left to right and the
 * thinnest axis faces the camera, so guns lie in profile and blades show their
 * flat face. The authored inventory icon camera picks which of the two faces.
 */
function baseOrientation(weapon: WeaponEntry, size: THREE.Vector3): THREE.Quaternion {
  const extents = [size.x, size.y, size.z];
  const byLength = ([0, 1, 2] as Axis[]).sort((a, b) => extents[b] - extents[a]);
  const longAxis = byLength[0];
  let viewAxis = FACE_AXIS_OVERRIDES[weapon.key] ?? byLength[2];
  const forward = weapon.iconCamera?.forward;
  if (!(weapon.key in FACE_AXIS_OVERRIDES) && forward && extents[byLength[2]] > extents[byLength[1]] * 0.85) {
    // Nearly as wide as it is tall (a fish, a round blade), so thickness says
    // little about which side is the face; the icon looks at the right one.
    viewAxis = Math.abs(forward[byLength[1]]) > Math.abs(forward[byLength[2]]) ? byLength[1] : byLength[2];
  }
  if (viewAxis === longAxis) viewAxis = byLength[2];
  const upAxis = ([0, 1, 2] as Axis[]).find((axis) => axis !== longAxis && axis !== viewAxis)!;
  const side = (weapon.iconCamera?.position[viewAxis] ?? 1) >= 0 ? 1 : -1;
  const view = AXIS_VECTORS[viewAxis].clone().multiplyScalar(side);
  const long = AXIS_VECTORS[longAxis].clone();
  // Pick the long direction that keeps the remaining axis pointing up.
  if (new THREE.Vector3().crossVectors(view, long).dot(AXIS_VECTORS[upAxis]) < 0) long.negate();
  const up = new THREE.Vector3().crossVectors(view, long);
  const basis = new THREE.Matrix4().makeBasis(long, up, view);
  return new THREE.Quaternion().setFromRotationMatrix(basis).invert();
}

/**
 * Vertex positions after skinning, in the space `toLocal` maps the mesh into.
 * One combined matrix per bone, so each vertex costs a few multiply-adds
 * rather than a full bone transform per influence.
 */
function posedPositions(mesh: THREE.Mesh, toLocal: THREE.Matrix4, used: Uint32Array | null = null): Float32Array {
  const position = mesh.geometry.getAttribute('position');
  const count = used ? used.length : position.count;
  const out = new Float32Array(count * 3);
  if (!(mesh instanceof THREE.SkinnedMesh)) {
    const e = toLocal.elements;
    for (let slot = 0; slot < count; slot += 1) {
      const index = used ? used[slot] : slot;
      const x = position.getX(index), y = position.getY(index), z = position.getZ(index);
      out[slot * 3] = e[0] * x + e[4] * y + e[8] * z + e[12];
      out[slot * 3 + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
      out[slot * 3 + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
    }
    return out;
  }
  const { bones, boneInverses } = mesh.skeleton;
  const head = toLocal.clone().multiply(mesh.bindMatrixInverse);
  const finals = bones.map((bone, index) => head.clone().multiply(bone.matrixWorld).multiply(boneInverses[index]).multiply(mesh.bindMatrix).elements);
  const skinIndex = mesh.geometry.getAttribute('skinIndex');
  const skinWeight = mesh.geometry.getAttribute('skinWeight');
  for (let slot = 0; slot < count; slot += 1) {
    const index = used ? used[slot] : slot;
    const x = position.getX(index), y = position.getY(index), z = position.getZ(index);
    let ox = 0, oy = 0, oz = 0;
    for (let k = 0; k < 4; k += 1) {
      const weight = skinWeight.getComponent(index, k);
      if (!weight) continue;
      const bone = skinIndex.getComponent(index, k);
      const e = finals[bone];
      ox += weight * (e[0] * x + e[4] * y + e[8] * z + e[12]);
      oy += weight * (e[1] * x + e[5] * y + e[9] * z + e[13]);
      oz += weight * (e[2] * x + e[6] * y + e[10] * z + e[14]);
    }
    out[slot * 3] = ox;
    out[slot * 3 + 1] = oy;
    out[slot * 3 + 2] = oz;
  }
  return out;
}

/**
 * For each bone, the foot of the part riding on it: the middle of its lowest
 * edge in the weapon's rest pose, stored in the bone's own space.
 */
function findPartBases(mesh: THREE.SkinnedMesh, bones: Map<string, RestBone>): void {
  const owner = dominantBones(mesh);
  const position = mesh.geometry.getAttribute('position');
  const point = new THREE.Vector3();
  const lowest = new Map<string, number>();
  owner.forEach((name, vertex) => {
    point.fromBufferAttribute(position, vertex).applyMatrix4(mesh.bindMatrix);
    lowest.set(name, Math.min(lowest.get(name) ?? Infinity, point.y));
  });
  const feet = new Map<string, { sum: THREE.Vector3; count: number }>();
  owner.forEach((name, vertex) => {
    point.fromBufferAttribute(position, vertex).applyMatrix4(mesh.bindMatrix);
    if (point.y > (lowest.get(name) ?? Infinity) + 0.3) return;
    const foot = feet.get(name) ?? { sum: new THREE.Vector3(), count: 0 };
    foot.sum.add(point);
    foot.count += 1;
    feet.set(name, foot);
  });
  mesh.skeleton.bones.forEach((bone, index) => {
    const rest = bones.get(bone.name);
    const foot = feet.get(bone.name);
    if (!rest || !foot || rest.base) return;
    rest.base = foot.sum.divideScalar(foot.count).applyMatrix4(mesh.skeleton.boneInverses[index]);
  });
}

/** The bone with the most weight on each vertex, by name. */
const dominantBoneCache = new WeakMap<THREE.BufferGeometry, string[]>();
function dominantBones(mesh: THREE.SkinnedMesh): string[] {
  const cached = dominantBoneCache.get(mesh.geometry);
  if (cached) return cached;
  const skinIndex = mesh.geometry.getAttribute('skinIndex');
  const skinWeight = mesh.geometry.getAttribute('skinWeight');
  const names = mesh.skeleton.bones.map((bone) => bone.name);
  const out: string[] = [];
  for (let index = 0; index < skinIndex.count; index += 1) {
    let best = 0;
    for (let k = 1; k < 4; k += 1) if (skinWeight.getComponent(index, k) > skinWeight.getComponent(index, best)) best = k;
    out.push(names[skinIndex.getComponent(index, best)] ?? '');
  }
  dominantBoneCache.set(mesh.geometry, out);
  return out;
}

/**
 * Triangles that belong to a set of weapon parts (most of their corners are
 * on them), or everything else, as an index plus the vertices it uses.
 */
function partSubset(mesh: THREE.SkinnedMesh, parts: readonly WeaponPart[], keep: boolean): MeshSubset {
  const owner = dominantBones(mesh);
  const inPart = (vertex: number) => parts.some((part) => part.bones.includes(owner[vertex]));
  const source = mesh.geometry.getIndex();
  const count = source ? source.count : owner.length;
  const kept: number[] = [];
  for (let corner = 0; corner + 2 < count; corner += 3) {
    const a = source ? source.getX(corner) : corner;
    const b = source ? source.getX(corner + 1) : corner + 1;
    const c = source ? source.getX(corner + 2) : corner + 2;
    const inside = Number(inPart(a)) + Number(inPart(b)) + Number(inPart(c)) >= 2;
    if (inside === keep) kept.push(a, b, c);
  }
  const index = new Uint32Array(kept);
  const remap = new Map<number, number>();
  const used: number[] = [];
  const compact = new Uint32Array(index.length);
  index.forEach((vertex, corner) => {
    let slot = remap.get(vertex);
    if (slot === undefined) {
      slot = used.length;
      remap.set(vertex, slot);
      used.push(vertex);
    }
    compact[corner] = slot;
  });
  return { used: new Uint32Array(used), index: compact, drawIndex: index };
}

export class ShowcaseBoard {
  readonly renderer: THREE.WebGLRenderer;
  readonly #options: ShowcaseBoardOptions;
  readonly #scene = new THREE.Scene();
  readonly #camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 2000);
  readonly #loader = new GLTFLoader();
  readonly #gltfs = new Map<string, Promise<GLTF>>();
  readonly #materialMaps = new Map<string, Promise<THREE.Texture | null>>();
  readonly #cubemaps = new Map<string, Promise<THREE.CubeTexture | null>>();
  /** What weapons reflect when their material names no cubemap: TF2's item preview cubemap. */
  #envMap = makeEnvCube(0x9fb8d6, 0x40382c);
  /** Ambient light on weapons, Source's six-sided ambient cube, shared by all of them. */
  readonly #ambientCube = Array.from({ length: 6 }, () => new THREE.Vector3(0.4, 0.4, 0.4));
  /** Composited paints by paint key, shared by every item wearing the same one. */
  readonly #paints = new Map<string, Promise<ComposeResult | null>>();
  /** Lower-detail composites on show while a paint streams in, by paint key. */
  readonly #previews = new Map<string, ComposeResult>();
  readonly #retiredPreviews = new Set<ComposeResult>();
  #paintSweep = 0;
  readonly #compositor: Compositor;
  readonly #runtimes = new Map<string, ItemRuntime>();
  readonly #listeners = new Set<() => void>();
  readonly #raycaster = new THREE.Raycaster();
  readonly #board: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshLambertMaterial>;
  readonly #shadowBoard: THREE.Mesh<THREE.PlaneGeometry, THREE.ShadowMaterial>;
  readonly #vignette: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  readonly #frame: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshLambertMaterial>;
  readonly #ghost: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  readonly #cells: THREE.InstancedMesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  readonly #resizeObserver: ResizeObserver;
  #items: ShowcaseItem[] = [];
  #selectedId: string | null = null;
  #pending: ShowcaseSnapshot['pending'] = null;
  #snapshot: ShowcaseSnapshot;
  #drag: DragState | null = null;
  /** Last pose of each item that passed the fit rules; edits that end invalid return to it. */
  readonly #lastValid = new Map<string, Pick<ShowcaseItem, 'roll' | 'tilt' | 'turn' | 'flipped' | 'scale' | 'pose'>>();
  #grid: GridSize = 'normal';
  #spacing = 1;
  #showGrid = false;
  #snap = true;
  #keepApart = true;
  #keepInside = true;
  readonly #light: THREE.DirectionalLight;
  readonly #ambient: THREE.HemisphereLight;
  readonly #clipPlanes = [
    new THREE.Plane(new THREE.Vector3(-1, 0, 0), BOARD_WIDTH / 2),
    new THREE.Plane(new THREE.Vector3(1, 0, 0), BOARD_WIDTH / 2),
    new THREE.Plane(new THREE.Vector3(0, -1, 0), BOARD_HEIGHT / 2),
    new THREE.Plane(new THREE.Vector3(0, 1, 0), BOARD_HEIGHT / 2),
  ];
  #background: BoardBackground = 'framed';
  #shadows = true;
  #raf = 0;
  #snapshotStale = false;
  #problemsKey = '';
  /** The weapon in the middle of a rotation or pose drag, until it settles. */
  #liveEditId: string | null = null;
  #liveRulesKey = '';
  #notifyQueued = false;
  /** Latest pointer position of a drag, applied once per frame. */
  #queuedPointer: { x: number; y: number } | null = null;
  /** Items whose rotation, size, or pose changed and need a new footprint this frame. */
  readonly #reshapeQueue = new Set<string>();
  #ghostVersion = -1;
  readonly #ghostCanvas = document.createElement('canvas');
  #footprintVersion = 0;
  #ghostSize = '';
  #dirty = true;
  #disposed = false;
  /** Each mesh's full geometry, kept while a subset of it is drawn. */
  readonly #sourceGeometry = new WeakMap<THREE.Mesh, THREE.BufferGeometry>();
  readonly #subsetGeometry = new Map<string, { geometry: THREE.BufferGeometry; subset: MeshSubset }>();

  constructor(options: ShowcaseBoardOptions) {
    this.#options = options;
    const renderer = new THREE.WebGLRenderer({ canvas: options.canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, LOW_END ? 1.25 : 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    // three r186 folds the old soft variant into PCF; the map size sets the quality tier.
    renderer.shadowMap.type = THREE.PCFShadowMap;
    // Weapons allowed past the board edge are cut where the frame begins.
    renderer.localClippingEnabled = true;
    this.renderer = renderer;
    this.#compositor = new Compositor(options.resolveTexture, {
      renderer,
      size: 1024,
      textureMetadata: options.textureMetadata,
      textureMetadataResolver: options.textureMetadataResolver,
    });

    this.#camera.position.set(0, 0, 600);
    this.#ambient = new THREE.HemisphereLight(0xfff4e6, 0x3a3128, 1.35 * SOURCE_LIGHT_SCALE);
    this.#scene.add(this.#ambient);
    const light = new THREE.DirectionalLight(0xffffff, 2.1 * SOURCE_LIGHT_SCALE);
    this.#light = light;
    this.#placeLight(125, 55);
    light.castShadow = true;
    light.shadow.mapSize.setScalar(LOW_END ? 1024 : 2048);
    light.shadow.camera.left = -130;
    light.shadow.camera.right = 130;
    light.shadow.camera.top = 90;
    light.shadow.camera.bottom = -90;
    light.shadow.camera.near = 10;
    light.shadow.camera.far = 500;
    light.shadow.bias = -0.0004;
    light.shadow.normalBias = 0.03;
    this.#scene.add(light, light.target);
    this.#syncAmbientCube();
    loadEditorEnvCube((texture) => {
      if (this.#disposed) {
        texture.dispose();
        return;
      }
      const fallback = this.#envMap;
      this.#envMap = texture;
      for (const runtime of this.#runtimes.values()) {
        if (!runtime.customEnvMap) runtime.material.envMap = texture;
      }
      fallback.dispose();
      this.#dirty = true;
    });

    const pegboard = pegboardTexture();
    this.#board = new THREE.Mesh(
      new THREE.PlaneGeometry(BOARD_WIDTH, BOARD_HEIGHT),
      new THREE.MeshLambertMaterial({ map: pegboard, color: new THREE.Color(Math.PI, Math.PI, Math.PI) }),
    );
    this.#board.receiveShadow = true;
    this.#shadowBoard = new THREE.Mesh(
      new THREE.PlaneGeometry(BOARD_WIDTH, BOARD_HEIGHT),
      new THREE.ShadowMaterial({ opacity: 0.4 }),
    );
    this.#shadowBoard.receiveShadow = true;
    this.#shadowBoard.visible = false;
    this.#vignette = new THREE.Mesh(
      new THREE.PlaneGeometry(BOARD_WIDTH, BOARD_HEIGHT),
      new THREE.MeshBasicMaterial({ map: vignetteTexture(), transparent: true, depthWrite: false }),
    );
    this.#vignette.position.z = 0.02;
    const frameWidth = BOARD_WIDTH + FRAME_SIDE * 2;
    const frameHeight = BOARD_HEIGHT + FRAME_SIDE * 2;
    this.#frame = new THREE.Mesh(
      new THREE.PlaneGeometry(frameWidth, frameHeight),
      new THREE.MeshLambertMaterial({ map: frameTexture(frameWidth, frameHeight), color: new THREE.Color(Math.PI, Math.PI, Math.PI) }),
    );
    this.#frame.position.set(0, 0, -0.5);
    this.#scene.add(this.#frame, this.#board, this.#shadowBoard, this.#vignette);

    this.#ghost = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      // Drawn over the carried weapon so the landing spot stays readable.
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.6, depthWrite: false, depthTest: false, clippingPlanes: this.#clipPlanes }),
    );
    this.#ghost.visible = false;
    this.#ghost.renderOrder = 10;
    this.#cells = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.32, depthWrite: false }),
      MAX_CELL_MARKERS,
    );
    this.#cells.count = 0;
    this.#cells.renderOrder = 1;
    this.#cells.frustumCulled = false;
    this.#scene.add(this.#ghost, this.#cells);
    this.#applyGridTexture();


    options.canvas.addEventListener('pointerdown', this.#onPointerDown);
    options.canvas.addEventListener('pointermove', this.#onCanvasHover);
    this.#resizeObserver = new ResizeObserver(() => this.#resize());
    this.#resizeObserver.observe(options.canvas);
    this.#snapshot = this.#buildSnapshot();
    this.#resize();
    this.#raf = requestAnimationFrame(this.#frameLoop);
  }

  // ---------- store ----------

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getSnapshot = (): ShowcaseSnapshot => {
    if (this.#snapshotStale) {
      this.#snapshotStale = false;
      this.#snapshot = this.#buildSnapshot();
    }
    return this.#snapshot;
  };

  /**
   * Mark the board changed. Listeners hear about it once per frame, so a burst
   * of pointer events re-renders the panel at most once per frame.
   */
  #emit(): void {
    this.#dirty = true;
    this.#snapshotStale = true;
    this.#notifyQueued = true;
  }

  /**
   * Parts that did not change keep their identity, so the panel sections that
   * show them can skip re-rendering while a weapon is dragged or turned.
   */
  #buildSnapshot(): ShowcaseSnapshot {
    const previous = this.#snapshot;
    const problemsKey = `${this.#footprintVersion}|${this.#rulesKey()}`;
    let problems = previous?.problems;
    const live = this.#liveEditId;
    if (previous && live && this.#liveRulesKey === this.#rulesKey() && previous.items.length === this.#items.length) {
      // During a rotation or pose drag the edited weapon is the only one whose
      // fit can change; everything is re-checked when the gesture settles.
      const liveItem = this.#items.find((item) => item.id === live);
      const problem = liveItem ? this.#problemAt(live, liveItem.x, liveItem.y) : null;
      if (JSON.stringify(previous.problems[live] ?? null) !== JSON.stringify(problem)) problems = { ...previous.problems, [live]: problem };
    } else if (!previous || previous.items !== this.#items || this.#problemsKey !== problemsKey) {
      const next: Record<string, FitProblem> = {};
      for (const item of this.#items) next[item.id] = this.#problemAt(item.id, item.x, item.y);
      problems = next;
      this.#problemsKey = problemsKey;
    }
    const pending = previous?.pending && this.#pending && previous.pending.id === this.#pending.id
      && JSON.stringify(previous.pending.problem) === JSON.stringify(this.#pending.problem) ? previous.pending : this.#pending;
    return {
      items: this.#items,
      selectedId: this.#selectedId,
      problems: problems ?? {},
      pending,
      dragging: !!this.#drag,
      canUndo: this.#past.length > 0 && !this.#restoring,
      canRedo: this.#future.length > 0 && !this.#restoring,
    };
  }

  #rulesKey(): string {
    return `${this.#grid}|${this.#spacing}|${this.#keepApart}|${this.#keepInside}`;
  }

  // ---------- board settings ----------

  setGrid(grid: GridSize): void {
    this.#grid = grid;
    this.#applyGridTexture();
    for (const runtime of this.#runtimes.values()) this.#refreshFootprint(runtime);
    this.#emit();
  }

  setSpacing(cells: number): void {
    this.#spacing = cells;
    this.#emit();
  }

  setShowGrid(show: boolean): void {
    this.#showGrid = show;
    this.#updateCellMarkers();
  }

  setBackground(background: BoardBackground): void {
    this.#background = background;
    this.#board.visible = background !== 'transparent';
    this.#vignette.visible = background !== 'transparent';
    this.#shadowBoard.visible = background === 'transparent' && this.#shadows;
    this.#frame.visible = background === 'framed';
    this.#dirty = true;
    this.#resize();
  }

  setSnap(snap: boolean): void {
    this.#snap = snap;
  }

  setKeepApart(keepApart: boolean): void {
    this.#keepApart = keepApart;
    this.#restack();
    this.#updateCellMarkers();
    this.#emit();
  }

  setKeepInside(keepInside: boolean): void {
    this.#keepInside = keepInside;
    this.#updateCellMarkers();
    this.#emit();
  }

  /**
   * Where the light comes from, as seen on the board: azimuth 0 is the right
   * edge and 90 the top. A lower elevation grazes the board for longer shadows.
   */
  setLight(azimuth: number, elevation: number): void {
    this.#placeLight(azimuth, elevation);
    this.#dirty = true;
  }

  /** Whether weapons cast shadows on the board. */
  setShadows(enabled: boolean): void {
    this.#shadows = enabled;
    this.#light.castShadow = enabled;
    // On a transparent background the shadows are all the board shows.
    this.#shadowBoard.visible = this.#background === 'transparent' && enabled;
    this.#dirty = true;
  }

  /** 0 keeps the board evenly lit, 1 gives hard, dark shadows. */
  setShadowStrength(strength: number): void {
    this.#light.intensity = (0.8 + strength * 2.2) * SOURCE_LIGHT_SCALE;
    this.#ambient.intensity = (2.2 - strength * 1.4) * SOURCE_LIGHT_SCALE;
    this.#syncAmbientCube();
    this.#dirty = true;
  }

  /**
   * Weapons take their ambient from the ambient cube instead of three's light:
   * the board's sky colour above, its ground colour below, matching the
   * hemisphere light the board itself is lit by.
   */
  #syncAmbientCube(): void {
    const sky = this.#ambient.color.clone().multiplyScalar(this.#ambient.intensity);
    const ground = this.#ambient.groundColor.clone().multiplyScalar(this.#ambient.intensity);
    const side = sky.clone().lerp(ground, 0.5);
    // Source order +x, -x, +y, -y, +z, -z; board +y is up the board, +z faces the viewer.
    const faces = [side, side, sky, ground, sky.clone().lerp(side, 0.5), side];
    faces.forEach((color, index) => this.#ambientCube[index].set(color.r, color.g, color.b));
    this.#dirty = true;
  }

  #placeLight(azimuth: number, elevation: number): void {
    const az = THREE.MathUtils.degToRad(azimuth);
    const el = THREE.MathUtils.degToRad(THREE.MathUtils.clamp(elevation, 15, 89));
    const distance = 230;
    this.#light.position.set(
      Math.cos(az) * Math.cos(el) * distance,
      Math.sin(az) * Math.cos(el) * distance,
      Math.sin(el) * distance,
    );
  }

  #applyGridTexture(): void {
    const map = this.#board.material.map;
    if (!map) return;
    const cell = GRID_CELL[this.#grid];
    map.repeat.set(BOARD_WIDTH / cell, BOARD_HEIGHT / cell);
    // Holes sit on the cell corners, which are the snap points.
    map.offset.set(0.5, 0.5);
    map.needsUpdate = true;
    this.#dirty = true;
  }

  // ---------- items ----------

  async addAt(weaponKey: string, paint: ShowcasePaint, x?: number, y?: number): Promise<string | null> {
    const runtime = await this.#createRuntime(weaponKey, paint);
    if (!runtime) return null;
    const spot = x !== undefined && y !== undefined ? { x, y } : this.#findFreeSpot(runtime);
    if (!spot) {
      this.#disposeRuntime(runtime);
      return null;
    }
    runtime.item.x = spot.x;
    runtime.item.y = spot.y;
    this.#commitRuntime(runtime);
    this.select(runtime.item.id);
    return runtime.item.id;
  }

  /** Start dragging a new weapon from the tray; it follows the pointer until dropped. */
  async beginExternalDrag(weaponKey: string, paint: ShowcasePaint, clientX: number, clientY: number): Promise<void> {
    this.#cancelExternalDrag();
    window.addEventListener('pointermove', this.#onWindowMove);
    window.addEventListener('pointerup', this.#onWindowUp);
    this.#lastPointer = { x: clientX, y: clientY };
    this.#pendingExternal = true;
    const runtime = await this.#createRuntime(weaponKey, paint);
    if (!this.#pendingExternal || !runtime) {
      if (runtime) this.#disposeRuntime(runtime);
      return;
    }
    this.#pendingExternal = false;
    runtime.root.visible = false;
    this.#runtimes.set(runtime.item.id, runtime);
    this.#scene.add(runtime.root);
    this.#drag = { id: runtime.item.id, grabX: 0, grabY: 0, fromX: 0, fromY: 0, external: true, candidate: null };
    this.select(runtime.item.id);
    this.#dragTo(this.#lastPointer.x, this.#lastPointer.y);
    if (this.#releasedWhileLoading) {
      this.#releasedWhileLoading = false;
      this.#onWindowUp();
    }
  }

  #pendingExternal = false;
  #releasedWhileLoading = false;
  /** Board states before and after the current one; each entry is a full item list. */
  #past: ShowcaseItem[][] = [];
  #future: ShowcaseItem[][] = [];
  #committed: ShowcaseItem[] = [];
  #restoring = false;
  #lastPointer = { x: 0, y: 0 };

  #cancelExternalDrag(): void {
    this.#pendingExternal = false;
    this.#releasedWhileLoading = false;
    window.removeEventListener('pointermove', this.#onWindowMove);
    window.removeEventListener('pointerup', this.#onWindowUp);
  }

  undo(): void {
    const previous = this.#past.pop();
    if (!previous || this.#restoring) return;
    this.#future.push(this.#committed);
    void this.#restore(previous);
  }

  redo(): void {
    const next = this.#future.pop();
    if (!next || this.#restoring) return;
    this.#past.push(this.#committed);
    void this.#restore(next);
  }

  #checkpoint(): void {
    if (this.#restoring) return;
    this.#flushReshapes();
    const current = this.#items.map(copyItem);
    if (JSON.stringify(current) === JSON.stringify(this.#committed)) return;
    this.#past.push(this.#committed);
    if (this.#past.length > HISTORY_LIMIT) this.#past.shift();
    this.#future = [];
    this.#committed = current;
  }

  async #restore(target: ShowcaseItem[]): Promise<void> {
    this.#restoring = true;
    this.#emit();
    try {
      const wanted = new Set(target.map((item) => item.id));
      for (const runtime of [...this.#runtimes.values()]) {
        if (!wanted.has(runtime.item.id)) this.#disposeRuntime(runtime);
      }
      const items: ShowcaseItem[] = [];
      for (const saved of target) {
        let runtime = this.#runtimes.get(saved.id);
        // A removed weapon comes back under its old id, so later steps still find it.
        runtime ??= (await this.#createRuntime(saved.weaponKey, saved.paint, saved.id, saved.part)) ?? undefined;
        if (!runtime) continue;
        runtime.item = copyItem(saved);
        void this.#applyPaint(runtime);
        if (!runtime.root.parent) this.#scene.add(runtime.root);
        this.#reshape(runtime);
        this.#rememberValid(runtime);
        items.push(runtime.item);
      }
      this.#items = items;
      this.#committed = target.map(copyItem);
      if (this.#selectedId && !wanted.has(this.#selectedId)) this.#selectedId = null;
      this.#restack();
      this.#updateCellMarkers();
    } finally {
      this.#restoring = false;
      this.#emit();
    }
  }

  select(id: string | null): void {
    this.#selectedId = id;
    this.#updateCellMarkers();
    this.#emit();
  }

  update(id: string, patch: Partial<Pick<ShowcaseItem, 'roll' | 'tilt' | 'turn' | 'flipped' | 'scale' | 'pose'>>): void {
    const runtime = this.#runtimes.get(id);
    if (!runtime) return;
    Object.assign(runtime.item, patch);
    runtime.item.tilt = THREE.MathUtils.clamp(runtime.item.tilt, -TILT_LIMIT, TILT_LIMIT);
    runtime.item.turn = THREE.MathUtils.clamp(runtime.item.turn, -TILT_LIMIT, TILT_LIMIT);
    // The weapon turns right away; its footprint and fit follow on the next frame.
    this.#applyTransform(runtime);
    this.#replaceItem(runtime);
    this.#reshapeQueue.add(id);
    if (this.#liveEditId !== id) {
      // Start from a fully checked board, then track just this weapon.
      this.#liveEditId = null;
      this.#snapshotStale = true;
      this.getSnapshot();
      this.#liveEditId = id;
      this.#liveRulesKey = this.#rulesKey();
    }
    this.#emit();
  }

  /** Re-measure everything edited since the last frame, then re-check the fit once. */
  #flushReshapes(): void {
    if (!this.#reshapeQueue.size) return;
    let lastId: string | null = null;
    for (const id of this.#reshapeQueue) {
      const runtime = this.#runtimes.get(id);
      if (!runtime) continue;
      this.#reshape(runtime);
      lastId = id;
    }
    this.#reshapeQueue.clear();
    this.#restack();
    const runtime = lastId ? this.#runtimes.get(lastId) : undefined;
    if (runtime && lastId) {
      const problem = this.#problemAt(lastId, runtime.item.x, runtime.item.y);
      if (!problem) this.#rememberValid(runtime);
      this.#pending = problem ? { id: lastId, problem } : null;
    }
    this.#updateCellMarkers();
    this.#emit();
  }

  /**
   * Turn by a step. A weapon being carried turns in hand and keeps following
   * the pointer (its fit is checked on drop); one on the board settles, so a
   * turn that does not fit springs back.
   */
  rotateBy(id: string, degrees: number): void {
    const runtime = this.#runtimes.get(id);
    if (!runtime) return;
    const roll = ((((runtime.item.roll + degrees + 180) % 360) + 360) % 360) - 180;
    if (this.#drag?.id === id) {
      runtime.item.roll = roll;
      this.#reshape(runtime);
      this.#replaceItem(runtime);
      this.#dragTo(this.#lastPointer.x, this.#lastPointer.y);
      return;
    }
    this.update(id, { roll });
    this.settle(id);
  }

  /** The weapon being carried, if any; keyboard rotation applies to it first. */
  get heldId(): string | null {
    return this.#drag?.id ?? null;
  }

  nudge(id: string, dx: number, dy: number): void {
    this.#flushReshapes();
    const runtime = this.#runtimes.get(id);
    if (!runtime) return;
    const cell = GRID_CELL[this.#grid];
    const x = runtime.item.x + dx * cell;
    const y = runtime.item.y + dy * cell;
    if (this.#problemAt(id, x, y)) return;
    runtime.item.x = x;
    runtime.item.y = y;
    this.#replaceItem(runtime);
    this.#restack();
    this.#checkpoint();
    this.#updateCellMarkers();
    this.#emit();
  }

  remove(id: string): void {
    const runtime = this.#runtimes.get(id);
    if (!runtime) return;
    if (this.#selectedId === id) this.select(null);
    this.#items = this.#items.filter((item) => item.id !== id);
    this.#disposeRuntime(runtime);
    this.#restack();
    this.#checkpoint();
    this.#emit();
  }

  async duplicate(id: string): Promise<void> {
    const source = this.#runtimes.get(id)?.item;
    if (!source) return;
    const runtime = await this.#createRuntime(source.weaponKey, source.paint, undefined, source.part);
    if (!runtime) return;
    Object.assign(runtime.item, { roll: source.roll, tilt: source.tilt, turn: source.turn, flipped: source.flipped, scale: source.scale, pose: { ...source.pose }, hiddenParts: [...source.hiddenParts] });
    this.#reshape(runtime);
    const spot = this.#findFreeSpot(runtime);
    if (!spot) {
      this.#disposeRuntime(runtime);
      return;
    }
    runtime.item.x = spot.x;
    runtime.item.y = spot.y;
    this.#commitRuntime(runtime);
    this.select(runtime.item.id);
  }

  clear(): void {
    // A layout still loading would otherwise land on the cleared board.
    this.#layoutRequest += 1;
    this.select(null);
    for (const runtime of [...this.#runtimes.values()]) this.#disposeRuntime(runtime);
    this.#items = [];
    this.#checkpoint();
    this.#emit();
  }

  #layoutRequest = 0;

  /**
   * Replace the board with a layout as one undo step. Every weapon loads first,
   * then all share one size, chosen to fill the board, so true sizes stay true
   * to each other. With `pack`, the rows only name the weapons; they are
   * regrouped into rows or columns, by size or in the listed order, whichever
   * lets them be largest.
   */
  async applyLayout(rows: LayoutRows, pack?: LayoutPacking, inward = false, upright = false): Promise<void> {
    const request = (this.#layoutRequest += 1);
    const loaded = await Promise.all(rows.map((row) => Promise.all(row.map((slot) => this.#createRuntime(slot.weaponKey, slot.paint, undefined, null, true)))));
    const groups = loaded.map((row) => row.filter((runtime): runtime is ItemRuntime => !!runtime)).filter((row) => row.length > 0);
    if (request !== this.#layoutRequest || this.#disposed) {
      // A newer layout was picked while this one loaded.
      for (const runtime of groups.flat()) this.#disposeRuntime(runtime);
      return;
    }
    this.#cancelExternalDrag();
    this.#drag = null;
    this.select(null);
    const keep = new Set(groups.flat());
    for (const runtime of [...this.#runtimes.values()]) if (!keep.has(runtime)) this.#disposeRuntime(runtime);
    this.#items = [];
    if (groups.length) this.#arrange(groups, pack, inward, upright);
    // Painted once at their final size, so none composes at 100% only to shrink.
    for (const runtime of groups.flat()) void this.#applyPaint(runtime);
    this.#restack();
    this.#checkpoint();
    this.#updateCellMarkers();
    this.#emit();
  }

  #arrange(rows: ItemRuntime[][], pack: LayoutPacking | undefined, inward: boolean, upright: boolean): void {
    const cell = GRID_CELL[this.#grid];
    // Space around and between weapons: the spacing rule plus a cell, so
    // rounding positions to the grid never brings two too close.
    const gap = (this.#keepApart ? this.#spacing + 1 : 1) * cell;
    const hangs = (runtime: ItemRuntime) => runtime.item.weaponKey in HANGING_PARTS && !runtime.item.part;
    /** Groups run across the board (rows) or down it (columns, `vertical`). */
    type Grouping = { groups: ItemRuntime[][]; vertical: boolean };
    type Box = { minX: number; maxX: number; minY: number; maxY: number };

    // Every weapon is measured unflipped at 100%. Turning one round mirrors
    // its outline and its size scales with it, so these serve every candidate.
    for (const runtime of rows.flat()) {
      Object.assign(runtime.item, { roll: restingRoll(runtime.item.weaponKey, runtime.item.part), tilt: 0, turn: 0, scale: 1, flipped: false });
      const hanging = HANGING_PARTS[runtime.item.weaponKey];
      if (hanging && !runtime.item.part) runtime.item.pose = { ...runtime.item.pose, ...hanging.pose };
      this.#reshape(runtime);
    }
    const mirror = (box: Box, flip: boolean): Box => (flip ? { ...box, minX: -box.maxX, maxX: -box.minX } : box);
    // Outlines for a facing, mirrored when it differs from the one measured.
    const full = (runtime: ItemRuntime, flip: boolean): Box => {
      const footprint = runtime.footprint;
      if (!footprint) return { minX: 0, maxX: 0, minY: 0, maxY: 0 };
      const box = { minX: footprint.originX, maxX: footprint.originX + footprint.width, minY: footprint.originY, maxY: footprint.originY + footprint.height };
      return mirror(box, flip !== runtime.item.flipped);
    };
    const body = (runtime: ItemRuntime, flip: boolean): Box => (runtime.footprint ? mirror(runtime.footprint.body, flip !== runtime.item.flipped) : full(runtime, flip));
    // Muzzles point left unflipped. Facing inward, weapons before the middle
    // of their row (or columns left of the middle) turn round to face right,
    // and one that rests facing right turns round past the middle instead.
    let turnInward = inward;
    const flipOf = ({ groups, vertical }: Grouping, groupIndex: number, index: number) => {
      const { item } = groups[groupIndex][index];
      // A weapon resting upright would turn its back to the viewer.
      if (!turnInward || restingRoll(item.weaponKey, item.part)) return false;
      const [position, count] = vertical ? [groupIndex, groups.length] : [index, groups[groupIndex].length];
      const middle = (count - 1) / 2;
      return FACES_RIGHT.has(item.weaponKey) && !item.part ? position > middle + 0.01 : position < middle - 0.01;
    };
    // The space a weapon needs. Its height leaves out a hanging piece, which
    // runs off the bottom; its width keeps it, unless the weapon ends the
    // bottom row with the piece on the outer side, where it runs off that edge.
    const space = (grouping: Grouping, groupIndex: number, index: number): Box => {
      const runtime = grouping.groups[groupIndex][index];
      const flip = flipOf(grouping, groupIndex, index);
      const outline = full(runtime, flip);
      if (!hangs(runtime)) return outline;
      const own = body(runtime, flip);
      const box = { ...outline, minY: own.minY, maxY: own.maxY };
      const group = grouping.groups[groupIndex];
      if (!grouping.vertical && groupIndex === grouping.groups.length - 1) {
        if (index === 0) box.minX = Math.max(box.minX, own.minX);
        if (index === group.length - 1) box.maxX = Math.min(box.maxX, own.maxX);
      }
      return box;
    };
    const along = (box: Box, vertical: boolean) => (vertical ? box.maxY - box.minY : box.maxX - box.minX);
    // How much the weapons can grow before a group runs out of length or the groups out of room.
    const fit = (grouping: Grouping) => {
      const { groups, vertical } = grouping;
      const length = vertical ? BOARD_HEIGHT : BOARD_WIDTH;
      const breadth = vertical ? BOARD_WIDTH : BOARD_HEIGHT;
      let byLength = Infinity;
      let thickness = 0;
      groups.forEach((group, groupIndex) => {
        const boxes = group.map((_, index) => space(grouping, groupIndex, index));
        byLength = Math.min(byLength, (length - gap * (group.length + 1)) / Math.max(1, boxes.reduce((sum, box) => sum + along(box, vertical), 0)));
        thickness += Math.max(...boxes.map((box) => along(box, !vertical)));
      });
      return Math.min(byLength, (breadth - gap * (groups.length + 1)) / Math.max(1, thickness));
    };
    // Weapons with a hanging piece go along the bottom so it can run off the edge.
    const sinkHanging = (groups: ItemRuntime[][]): ItemRuntime[][] => {
      if (!groups.some((group) => group.some(hangs))) return groups;
      if (pack) {
        const rest = groups.map((group) => group.filter((runtime) => !hangs(runtime)));
        const bottom = [...rest.pop() ?? [], ...groups.flat().filter(hangs)];
        return [...rest, bottom].filter((group) => group.length > 0);
      }
      // A fixed layout keeps its rows together, such as a RED and BLU pair.
      return [...groups.filter((group) => !group.some(hangs)), ...groups.filter((group) => group.some(hangs))];
    };

    const search = (): { grouping: Grouping; score: number } => {
      let best: Grouping = { groups: sinkHanging(rows), vertical: false };
      let bestFit = pack ? 0 : fit(best);
      if (pack) {
        const all = rows.flat();
        // Columns would hang a piece over the weapon below, so a board with one sticks to rows.
        for (const vertical of all.some(hangs) ? [false] : [false, true]) {
          const size = (runtime: ItemRuntime, alongGroup: boolean) => along(full(runtime, false), alongGroup === vertical);
          // By size, sorted by thickness so each group holds weapons of a
          // similar size; either way cut into runs of about equal length.
          const sorted = pack === 'size' ? [...all].sort((a, b) => size(b, false) - size(a, false)) : all;
          const total = sorted.reduce((sum, runtime) => sum + size(runtime, true), 0);
          for (let count = 1; count <= Math.min(6, sorted.length); count += 1) {
            const groups: ItemRuntime[][] = [[]];
            let length = 0;
            for (const runtime of sorted) {
              const extent = size(runtime, true);
              if (groups.length < count && groups[groups.length - 1].length && length + extent / 2 > (total * groups.length) / count) groups.push([]);
              groups[groups.length - 1].push(runtime);
              length += extent;
            }
            const candidate = { groups: vertical ? groups : sinkHanging(groups), vertical };
            const candidateFit = fit(candidate);
            if (candidateFit > bestFit) {
              best = candidate;
              bestFit = candidateFit;
            }
          }
        }
      }
      return { grouping: best, score: bestFit };
    };
    // Weapons already resting upright keep their roll either way.
    const setRoll = (standing: boolean) => {
      for (const runtime of rows.flat()) {
        const rest = restingRoll(runtime.item.weaponKey, runtime.item.part);
        runtime.item.roll = standing && !rest ? -90 : rest;
        this.#reshape(runtime);
      }
    };
    let { grouping: best } = search();
    if (upright && !rows.flat().some(hangs)) {
      // Standing upright, tips up like a weapon rack. Turning round would only
      // show the other side there, so nothing faces inward.
      const lying = fit(best);
      setRoll(true);
      turnInward = false;
      const standing = search();
      if (Math.min(standing.score, LAYOUT_SCALE.max) > Math.min(lying, LAYOUT_SCALE.max)) best = standing.grouping;
      else {
        setRoll(false);
        turnInward = inward;
      }
    }
    const factor = THREE.MathUtils.clamp(Math.floor(Math.min(fit(best), LAYOUT_SCALE.max) * 100) / 100, LAYOUT_SCALE.min, LAYOUT_SCALE.max);
    const { groups, vertical } = best;
    // Weapons whose hanging piece runs straight off a side edge, by that edge.
    const sideways = new Map<ItemRuntime, 'left' | 'right'>();
    groups.forEach((group, groupIndex) => group.forEach((runtime, index) => {
      runtime.item.scale = factor;
      runtime.item.flipped = flipOf(best, groupIndex, index);
      this.#reshape(runtime);
      const hanging = HANGING_PARTS[runtime.item.weaponKey];
      if (!hanging || runtime.item.part || vertical || groupIndex !== groups.length - 1) return;
      const outline = full(runtime, runtime.item.flipped);
      const own = body(runtime, runtime.item.flipped);
      const side = outline.maxX - own.maxX > own.minX - outline.minX ? 'right' : 'left';
      if ((side === 'left' && index === 0) || (side === 'right' && index === group.length - 1)) {
        runtime.item.pose = { ...runtime.item.pose, ...hanging.sidePose };
        this.#reshape(runtime);
        sideways.set(runtime, side);
      }
    }));

    // Measured again at the final size and facing.
    const boxes = groups.map((group, groupIndex) => group.map((_, index) => space(best, groupIndex, index)));
    const length = vertical ? BOARD_HEIGHT : BOARD_WIDTH;
    const breadth = vertical ? BOARD_WIDTH : BOARD_HEIGHT;
    const thickness = boxes.map((group) => Math.max(...group.map((box) => along(box, !vertical))));
    const freeAcross = Math.max(0, breadth - thickness.reduce((sum, value) => sum + value, 0)) / (groups.length + 1);
    // Rows fill from the top, columns from the left; positions run from the board's corner.
    let groupStart = freeAcross;
    groups.forEach((group, groupIndex) => {
      const groupCenter = groupStart + thickness[groupIndex] / 2;
      groupStart += thickness[groupIndex] + freeAcross;
      const freeAlong = Math.max(0, length - boxes[groupIndex].reduce((sum, box) => sum + along(box, vertical), 0)) / (group.length + 1);
      let itemStart = freeAlong;
      group.forEach((runtime, index) => {
        const box = boxes[groupIndex][index];
        const itemCenter = itemStart + along(box, vertical) / 2;
        itemStart += along(box, vertical) + freeAlong;
        const centerX = -BOARD_WIDTH / 2 + (vertical ? groupCenter : itemCenter);
        const centerY = BOARD_HEIGHT / 2 - (vertical ? itemCenter : groupCenter);
        // A hanging piece's weapon sits against the edge the piece runs off.
        const side = sideways.get(runtime);
        const x = side === 'right' ? Math.floor((BOARD_WIDTH / 2 - gap - box.maxX) / cell) * cell
          : side === 'left' ? Math.ceil((-BOARD_WIDTH / 2 + gap - box.minX) / cell) * cell
            : Math.round((centerX - (box.minX + box.maxX) / 2) / cell) * cell;
        const y = hangs(runtime) && !side && !vertical && groupIndex === groups.length - 1
          ? Math.round((-BOARD_HEIGHT / 2 + gap - box.minY) / cell) * cell
          : Math.round((centerY - (box.minY + box.maxY) / 2) / cell) * cell;
        // Rounding to the grid can still bring two weapons a cell too close.
        const spot = this.#problemAt(runtime.item.id, x, y) ? this.#nearestFreeSpot(runtime.item.id, x, y, 4) ?? { x, y } : { x, y };
        runtime.item.x = spot.x;
        runtime.item.y = spot.y;
        runtime.root.visible = true;
        if (!runtime.root.parent) this.#scene.add(runtime.root);
        this.#applyTransform(runtime);
        this.#rememberValid(runtime);
        this.#items = [...this.#items, runtime.item];
      });
    });
  }

  /** Change one item's paint, wear, team or pattern seed, as one undo step. */
  setPaint(id: string, patch: Partial<ShowcasePaint>): void {
    const runtime = this.#runtimes.get(id);
    if (!runtime) return;
    runtime.item = { ...runtime.item, paint: { ...runtime.item.paint, ...patch } };
    this.#items = this.#items.map((item) => (item.id === id ? runtime.item : item));
    void this.#applyPaint(runtime);
    this.#checkpoint();
    this.#emit();
  }

  #replaceItem(runtime: ItemRuntime): void {
    runtime.item = { ...runtime.item, pose: { ...runtime.item.pose } };
    this.#items = this.#items.map((item) => (item.id === runtime.item.id ? runtime.item : item));
  }

  #commitRuntime(runtime: ItemRuntime): void {
    this.#runtimes.set(runtime.item.id, runtime);
    if (!runtime.root.parent) this.#scene.add(runtime.root);
    runtime.root.visible = true;
    this.#applyTransform(runtime);
    this.#rememberValid(runtime);
    this.#items = [...this.#items, runtime.item];
    this.#restack();
    this.#checkpoint();
  }

  #loadModel(weapon: WeaponEntry): Promise<GLTF> {
    const url = this.#options.modelUrl(weapon, isRigged(weapon.key));
    let pending = this.#gltfs.get(url);
    if (!pending) {
      pending = this.#loader.loadAsync(url);
      this.#gltfs.set(url, pending);
    }
    return pending;
  }

  /**
   * Fetch a layout's models and recipes and decode its sources ahead of a
   * click that may follow, such as while the pointer rests on its button.
   */
  preload(rows: LayoutRows): void {
    const paints = new Set<string>();
    for (const { weaponKey, paint } of rows.flat()) {
      const weapon = this.#options.weapons.find((entry) => entry.key === weaponKey);
      if (!weapon) continue;
      void this.#loadModel(weapon).catch(() => null);
      const key = `${paint.kitId}|${weaponKey}|${paint.team}|${paint.wearIndex}|${paint.seed}`;
      if (paints.has(key)) continue;
      paints.add(key);
      void this.#options.resolveRecipe(paint.kitId, weaponKey, paint.team, paint.wearIndex).then((recipe) => {
        if (recipe && !this.#disposed) this.#compositor.prefetchSources(recipe, paint.seed, MIN_SOURCE_SIZE);
      }).catch(() => null);
    }
  }

  /** `deferPaint` leaves painting to the caller, for weapons about to be resized. */
  async #createRuntime(weaponKey: string, paint: ShowcasePaint, id?: string, partId: string | null = null, deferPaint = false): Promise<ItemRuntime | null> {
    const weapon = this.#options.weapons.find((entry) => entry.key === weaponKey);
    if (!weapon) return null;
    const part = partOf(weaponKey, partId);
    if (partId && !part) return null;
    try {
      const gltf = await this.#loadModel(weapon);
      if (this.#disposed) return null;
      const model = cloneSkinned(gltf.scene);
      const uniforms = createTf2Uniforms();
      // Shared, so changing the board's ambient light reaches every weapon at once.
      uniforms.uTf2AmbientCube.value = this.#ambientCube;
      const material = makeTf2Material(uniforms, this.#envMap);
      material.clippingPlanes = this.#clipPlanes;
      const meshes: THREE.Mesh[] = [];
      const bones = new Map<string, RestBone>();
      model.updateMatrixWorld(true);
      const modelInverse = model.getWorldQuaternion(new THREE.Quaternion()).invert();
      model.traverse((object) => {
        if (object instanceof THREE.Bone) {
          const restInModel = modelInverse.clone().multiply(object.getWorldQuaternion(new THREE.Quaternion()));
          bones.set(object.name, { bone: object, position: object.position.clone(), quaternion: object.quaternion.clone(), modelInverse: restInModel.invert(), base: null });
        }
        if (object instanceof THREE.Mesh) {
          object.material = material;
          object.castShadow = true;
          object.receiveShadow = true;
          object.frustumCulled = false;
          meshes.push(object);
        }
      });
      for (const mesh of meshes) if (mesh instanceof THREE.SkinnedMesh) findPartBases(mesh, bones);
      const item: ShowcaseItem = {
        id: id ?? `item-${(idCounter += 1)}`,
        weaponKey,
        weaponName: part ? `${weapon.name} ${part.label.toLowerCase()}` : weapon.name,
        paint,
        x: 0,
        y: 0,
        roll: restingRoll(weaponKey, part?.id ?? null),
        tilt: 0,
        turn: 0,
        flipped: false,
        scale: 1,
        hidden: false,
        pose: part ? {} : defaultPose(weaponKey),
        part: part?.id ?? null,
        hiddenParts: [],
      };
      const runtime: ItemRuntime = { item, root: new THREE.Group(), orient: new THREE.Group(), meshes, bones, footprint: null, material, uniforms, materialKey: '', stackZ: 0, local: null, paintKey: '', materialReady: Promise.resolve(), paintSize: 0, visibility: '', subsets: [] };
      this.#syncVisibility(runtime);
      // Measured on what is drawn, so a loose reload piece floating beside the
      // weapon does not throw off its centre.
      model.updateMatrixWorld(true);
      const box = new THREE.Box3();
      const corner = new THREE.Vector3();
      meshes.forEach((mesh, meshIndex) => {
        const positions = posedPositions(mesh, mesh.matrixWorld, runtime.subsets[meshIndex]?.used ?? null);
        for (let index = 0; index < positions.length; index += 3) box.expandByPoint(corner.fromArray(positions, index));
      });
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const base = new THREE.Group();
      base.quaternion.copy(baseOrientation(weapon, size));
      const centered = new THREE.Group();
      centered.position.copy(center).negate();
      centered.add(model);
      base.add(centered);
      const flip = new THREE.Group();
      flip.name = 'flip';
      flip.add(base);
      const { orient, root } = runtime;
      orient.rotation.order = 'ZXY';
      orient.add(flip);
      root.add(orient);
      // Registered before it is committed so the fit rules can see its footprint.
      this.#runtimes.set(item.id, runtime);
      this.#applyTransform(runtime);
      this.#refreshFootprint(runtime);
      if (!deferPaint) void this.#applyPaint(runtime);
      return runtime;
    } catch (cause) {
      console.error('[showcase] failed to load weapon', weaponKey, cause);
      return null;
    }
  }

  /**
   * Draw only what belongs: a taken-out piece shows just its own triangles,
   * and a weapon leaves out its loose reload pieces and anything taken out.
   */
  #syncVisibility(runtime: ItemRuntime): void {
    const { item } = runtime;
    const part = partOf(item.weaponKey, item.part);
    const parts = WEAPON_PARTS[item.weaponKey] ?? [];
    const selected = part ? [part] : parts.filter((entry) => entry.loose || item.hiddenParts.includes(entry.id));
    const key = `${part ? 'keep' : 'drop'}:${selected.map((entry) => entry.id).sort().join(',')}`;
    if (key === runtime.visibility) return;
    runtime.visibility = key;
    runtime.local = null;
    runtime.subsets = runtime.meshes.map((mesh) => {
      const source = this.#sourceGeometry.get(mesh) ?? mesh.geometry;
      this.#sourceGeometry.set(mesh, source);
      if (!(mesh instanceof THREE.SkinnedMesh) || !selected.length) {
        mesh.geometry = source;
        return null;
      }
      // Subsets share the vertex buffers and only swap the index, and they are
      // kept per variant: disposing one would free buffers its siblings use.
      const cacheKey = `${source.uuid}|${key}`;
      let cached = this.#subsetGeometry.get(cacheKey);
      if (!cached) {
        mesh.geometry = source;
        const subset = partSubset(mesh, selected, !!part);
        const geometry = new THREE.BufferGeometry();
        for (const [name, attribute] of Object.entries(source.attributes)) geometry.setAttribute(name, attribute);
        geometry.setIndex(new THREE.BufferAttribute(subset.drawIndex, 1));
        cached = { geometry, subset };
        this.#subsetGeometry.set(cacheKey, cached);
      }
      mesh.geometry = cached.geometry;
      return cached.subset;
    });
    this.#dirty = true;
  }

  /** Show or leave out a piece of a weapon. */
  setPartShown(id: string, partId: string, shown: boolean): void {
    const runtime = this.#runtimes.get(id);
    if (!runtime || !partOf(runtime.item.weaponKey, partId)) return;
    const hiddenParts = runtime.item.hiddenParts.filter((entry) => entry !== partId);
    runtime.item.hiddenParts = shown ? hiddenParts : [...hiddenParts, partId];
    this.#replaceItem(runtime);
    this.#reshape(runtime);
    this.#restack();
    this.#checkpoint();
    this.#updateCellMarkers();
    this.#emit();
  }

  /** Take a piece out of a weapon and put it on the board next to it, as one step. */
  async pullOutPart(id: string, partId: string): Promise<void> {
    const source = this.#runtimes.get(id);
    const part = source ? partOf(source.item.weaponKey, partId) : null;
    if (!source || !part) return;
    const runtime = await this.#createRuntime(source.item.weaponKey, source.item.paint, undefined, part.id);
    if (!runtime || !this.#runtimes.has(id)) {
      if (runtime) this.#disposeRuntime(runtime);
      return;
    }
    runtime.item.scale = source.item.scale;
    this.#reshape(runtime);
    const below = source.footprint ? source.item.y + source.footprint.originY - (runtime.footprint?.height ?? 0) / 2 : source.item.y;
    const spot = this.#nearestFreeSpot(runtime.item.id, source.item.x, below) ?? this.#findFreeSpot(runtime);
    if (!spot) {
      this.#disposeRuntime(runtime);
      return;
    }
    runtime.item.x = spot.x;
    runtime.item.y = spot.y;
    if (!part.loose && !source.item.hiddenParts.includes(part.id)) {
      source.item.hiddenParts = [...source.item.hiddenParts, part.id];
      this.#replaceItem(source);
      this.#reshape(source);
    }
    this.#commitRuntime(runtime);
    this.select(runtime.item.id);
  }

  /** A material map, loaded once and shared by every weapon that uses it. */
  #materialMap(ref: string, wrap: THREE.Wrapping): Promise<THREE.Texture | null> {
    const key = `${wrap}|${ref}`;
    let pending = this.#materialMaps.get(key);
    if (!pending) {
      pending = Promise.resolve(this.#options.resolveTexture(ref))
        .then((url) => new THREE.TextureLoader().loadAsync(url))
        .then((texture) => {
          // Raw data in glTF UV space, like the composite.
          texture.flipY = false;
          texture.colorSpace = THREE.NoColorSpace;
          texture.wrapS = texture.wrapT = wrap;
          return texture;
        })
        .catch(() => null);
      this.#materialMaps.set(key, pending);
    }
    return pending;
  }

  #cubemap(ref: string): Promise<THREE.CubeTexture | null> {
    let pending = this.#cubemaps.get(ref);
    if (!pending) {
      pending = this.#options.resolveCubemap(ref)
        .then((urls) => (urls ? new THREE.CubeTextureLoader().loadAsync(urls) : null))
        .then((texture) => {
          if (texture) texture.colorSpace = THREE.SRGBColorSpace;
          return texture;
        })
        .catch(() => null);
      this.#cubemaps.set(ref, pending);
    }
    return pending;
  }

  /** Set up the TF2 shader for the weapon's material under its paint, as the viewer does. */
  #applyMaterial(runtime: ItemRuntime): void {
    const { weaponKey, paint } = runtime.item;
    const weapon = this.#options.weapons.find((entry) => entry.key === weaponKey);
    const source = this.#options.materialOverride(weaponKey, paint.kitId) ?? weapon?.material;
    if (!source) return;
    const key = JSON.stringify(source);
    if (runtime.materialKey === key) return;
    runtime.materialKey = key;
    const { material, uniforms } = runtime;
    configureTf2Material(source, material, uniforms);
    material.normalMap = null;
    uniforms.uTf2UseExponentMap.value = 0;
    uniforms.uTf2UseLightwarp.value = 0;
    uniforms.uTf2UseSelfIllumMask.value = 0;
    uniforms.uTf2ExponentMap.value = null;
    uniforms.uTf2LightwarpMap.value = null;
    uniforms.uTf2SelfIllumMaskMap.value = null;
    uniforms.uTf2DetailMap.value = null;
    material.envMap = this.#envMap;
    this.#dirty = true;
    runtime.materialReady = this.#loadMaterialMaps(runtime, source, key);
  }

  async #loadMaterialMaps(runtime: ItemRuntime, source: WeaponMaterial, key: string): Promise<void> {
    const { material, uniforms } = runtime;
    const [normal, exponent, lightwarp, selfIllum, detail, envMap] = await Promise.all([
      source.normalMap ? this.#materialMap(source.normalMap, THREE.RepeatWrapping) : null,
      source.phongExponentTexture ? this.#materialMap(source.phongExponentTexture, THREE.RepeatWrapping) : null,
      // The diffuse-warp ramp is read clamped and without sRGB decode, as in Source.
      source.lightwarpTexture ? this.#materialMap(source.lightwarpTexture, THREE.ClampToEdgeWrapping) : null,
      source.selfIllumMask ? this.#materialMap(source.selfIllumMask, THREE.RepeatWrapping) : null,
      source.detailTexture ? this.#materialMap(source.detailTexture, THREE.RepeatWrapping) : null,
      source.envmapTexture ? this.#cubemap(source.envmapTexture) : null,
    ]);
    if (this.#disposed || runtime.materialKey !== key) return;
    if (normal) {
      material.normalMap = normal;
      // Source normal maps use the DirectX (green-down) convention.
      material.normalScale.set(1, -1);
    }
    if (exponent) {
      uniforms.uTf2ExponentMap.value = exponent;
      uniforms.uTf2UseExponentMap.value = 1;
    }
    if (lightwarp) {
      uniforms.uTf2LightwarpMap.value = lightwarp;
      uniforms.uTf2UseLightwarp.value = 1;
    }
    if (selfIllum) {
      uniforms.uTf2SelfIllumMaskMap.value = selfIllum;
      uniforms.uTf2UseSelfIllumMask.value = 1;
    }
    uniforms.uTf2DetailMap.value = detail;
    material.envMap = envMap ?? this.#envMap;
    runtime.customEnvMap = !!envMap;
    material.needsUpdate = true;
    this.#dirty = true;
  }

  /** Board units to drawing-buffer pixels at the current framing. */
  #pixelsPerUnit(): number {
    return this.renderer.domElement.width / Math.max(1, this.#camera.right - this.#camera.left);
  }

  /** The paint resolution a weapon needs when drawn at `pixelsPerUnit`. */
  #paintSizeFor(runtime: ItemRuntime, pixelsPerUnit: number): number {
    const footprint = runtime.footprint;
    const drawn = (footprint ? Math.max(footprint.width, footprint.height) : BOARD_HEIGHT / 2) * pixelsPerUnit * PAINT_TEXELS_PER_PIXEL;
    return THREE.MathUtils.clamp(2 ** Math.ceil(Math.log2(Math.max(1, drawn))), PAINT_SIZE.min, PAINT_SIZE.max);
  }

  /** Give weapons drawn larger than their paint a sharper one. */
  #sharpenPaints(pixelsPerUnit = this.#pixelsPerUnit()): void {
    for (const runtime of this.#runtimes.values()) {
      if (runtime.paintKey && this.#paintSizeFor(runtime, pixelsPerUnit) > runtime.paintSize) void this.#applyPaint(runtime, pixelsPerUnit);
    }
  }

  async #applyPaint(runtime: ItemRuntime, pixelsPerUnit = this.#pixelsPerUnit()): Promise<void> {
    this.#applyMaterial(runtime);
    const { kitId, team, wearIndex, seed } = runtime.item.paint;
    // Never smaller than before: shrinking would compose again only to look worse.
    const size = Math.max(runtime.paintSize, this.#paintSizeFor(runtime, pixelsPerUnit));
    const key = `${kitId}|${runtime.item.weaponKey}|${team}|${wearIndex}|${seed}|${size}`;
    if (runtime.paintKey === key) return;
    runtime.paintKey = key;
    runtime.paintSize = size;
    let pending = this.#paints.get(key);
    if (!pending) {
      pending = (async () => {
        const recipe = await this.#options.resolveRecipe(kitId, runtime.item.weaponKey, team, wearIndex);
        if (!recipe) return null;
        // Like the viewer, a paint shows at rising detail while its textures stream in.
        const result = await this.#compositor.composeLatest(`showcase:${key}`, recipe, seed, { width: size, height: size, sourceLimit: Math.max(size, MIN_SOURCE_SIZE) },
          () => this.#disposed, (preview) => this.#showPreview(key, preview));
        this.#wearPaint(key, result?.texture ?? null);
        return result;
      })().catch((cause) => {
        console.error('[showcase] compose failed', key, cause);
        return null;
      });
      this.#paints.set(key, pending);
    }
    // Joining a paint that is still streaming in: show the detail it has reached.
    const preview = this.#previews.get(key);
    if (preview) this.#setMap(runtime, preview.texture);
    const texture = (await pending)?.texture ?? null;
    this.#sweepPaints();
    // A newer paint on the same item may have finished first.
    if (this.#disposed || runtime.paintKey !== key) return;
    this.#setMap(runtime, texture);
  }

  #setMap(runtime: ItemRuntime, texture: THREE.Texture | null): void {
    const { material } = runtime;
    // Going from no map to a map (or back) changes the shader; swapping one for another does not.
    if (!material.map !== !texture) material.needsUpdate = true;
    material.map = texture;
    material.color.set(texture ? 0xffffff : 0x9a9a9a);
    this.#dirty = true;
    this.#releaseRetiredPreviews();
  }

  /** Put a paint on every weapon wearing it, then free the preview it replaces. */
  #wearPaint(key: string, texture: THREE.Texture | null): void {
    if (this.#disposed) return;
    for (const runtime of this.#runtimes.values()) if (runtime.paintKey === key) this.#setMap(runtime, texture);
    this.#dropPreview(key);
  }

  #showPreview(key: string, preview: ComposeResult): void {
    const wearers = [...this.#runtimes.values()].filter((runtime) => runtime.paintKey === key);
    if (this.#disposed || !wearers.length) {
      this.#compositor.releaseResult(preview);
      return;
    }
    for (const runtime of wearers) this.#setMap(runtime, preview.texture);
    this.#dropPreview(key);
    this.#previews.set(key, preview);
  }

  #dropPreview(key: string): void {
    const preview = this.#previews.get(key);
    if (!preview) return;
    this.#previews.delete(key);
    this.#retiredPreviews.add(preview);
    this.#releaseRetiredPreviews();
  }

  /**
   * Recycle replaced previews once no weapon shows them; one that switched
   * paint mid-stream keeps its last preview until the new paint arrives.
   */
  #releaseRetiredPreviews(): void {
    for (const preview of this.#retiredPreviews) {
      if ([...this.#runtimes.values()].some((runtime) => runtime.material.map === preview.texture)) continue;
      this.#retiredPreviews.delete(preview);
      this.#compositor.releaseResult(preview);
    }
  }

  /**
   * Free composites no item wears any more, once the current change settles,
   * so trying seeds or removing weapons does not pile up render targets.
   */
  #sweepPaints(): void {
    window.clearTimeout(this.#paintSweep);
    this.#paintSweep = window.setTimeout(() => {
      if (this.#disposed) return;
      const worn = new Set([...this.#runtimes.values()].map((runtime) => runtime.paintKey));
      for (const [key, pending] of this.#paints) {
        if (worn.has(key)) continue;
        this.#dropPreview(key);
        this.#paints.delete(key);
        // A weapon keeps showing its old paint until the new one is ready.
        void pending.then((result) => {
          if (!result || this.#disposed) return;
          this.#retiredPreviews.add(result);
          this.#releaseRetiredPreviews();
        });
      }
    }, 0);
  }

  #applyTransform(runtime: ItemRuntime): void {
    const { item, orient, root } = runtime;
    orient.rotation.set(
      THREE.MathUtils.degToRad(item.tilt),
      THREE.MathUtils.degToRad(item.turn),
      THREE.MathUtils.degToRad(item.roll),
      'ZXY',
    );
    const flip = orient.getObjectByName('flip');
    if (flip) flip.rotation.y = item.flipped ? Math.PI : 0;
    orient.scale.setScalar(item.scale * BASE_SCALE);
    root.visible = !item.hidden;
    const rig = item.part ? undefined : POSE_RIGS[item.weaponKey];
    if (rig) rig.apply(runtime.bones, item.pose);
    root.position.set(item.x, item.y, runtime.stackZ + (runtime.footprint ? -runtime.footprint.minZ : 4) + RESTING_LIFT);
  }

  /** Re-pose and re-measure: the resting height depends on the new footprint's depth. */
  #reshape(runtime: ItemRuntime): void {
    this.#syncVisibility(runtime);
    this.#applyTransform(runtime);
    this.#refreshFootprint(runtime);
    this.#applyTransform(runtime);
  }

  #topOf(runtime: ItemRuntime): number {
    const footprint = runtime.footprint;
    return footprint ? runtime.stackZ + footprint.maxZ - footprint.minZ + RESTING_LIFT : 0;
  }

  #overlaps(a: ItemRuntime, b: ItemRuntime): boolean {
    if (!a.footprint || !b.footprint) return false;
    const cell = GRID_CELL[this.#grid];
    const di = Math.round(a.item.x / cell) - Math.round(b.item.x / cell);
    const dj = Math.round(a.item.y / cell) - Math.round(b.item.y / cell);
    for (const key of a.footprint.cells) {
      if (b.footprint.cells.has(cellKey(keyI(key) + di, keyJ(key) + dj))) return true;
    }
    return false;
  }

  /**
   * With overlaps allowed, later weapons rest on top of earlier ones they
   * cover, so stacked weapons never intersect. Board order is stacking order.
   */
  #restack(): void {
    const placed: ItemRuntime[] = [];
    for (const item of this.#items) {
      const runtime = this.#runtimes.get(item.id);
      if (!runtime || item.hidden) continue;
      runtime.stackZ = 0;
      if (!this.#keepApart) {
        for (const below of placed) {
          if (this.#overlaps(runtime, below)) runtime.stackZ = Math.max(runtime.stackZ, this.#topOf(below));
        }
      }
      this.#applyTransform(runtime);
      placed.push(runtime);
    }
  }

  /** Move a layer to a new place in the stacking order (0 is the back). */
  reorder(id: string, index: number): void {
    const item = this.#items.find((entry) => entry.id === id);
    if (!item) return;
    const rest = this.#items.filter((entry) => entry.id !== id);
    rest.splice(Math.max(0, Math.min(rest.length, index)), 0, item);
    this.#items = rest;
    this.#restack();
    this.#checkpoint();
    this.#emit();
  }

  setHidden(id: string, hidden: boolean): void {
    const runtime = this.#runtimes.get(id);
    if (!runtime) return;
    runtime.item.hidden = hidden;
    this.#replaceItem(runtime);
    this.#applyTransform(runtime);
    if (hidden && this.#selectedId === id) this.#selectedId = null;
    this.#restack();
    this.#checkpoint();
    this.#updateCellMarkers();
    this.#emit();
  }

  #disposeRuntime(runtime: ItemRuntime): void {
    runtime.root.removeFromParent();
    runtime.material.dispose();
    this.#runtimes.delete(runtime.item.id);
    this.#releaseRetiredPreviews();
    this.#sweepPaints();
  }

  // ---------- footprint ----------

  /**
   * Rasterise the posed, rotated weapon onto the board plane. The canvas is the
   * silhouette shown while placing, and its covered cells are the footprint
   * used for the fit rules.
   */
  #refreshFootprint(runtime: ItemRuntime): void {
    const cell = GRID_CELL[this.#grid];
    const savedPosition = runtime.root.position.clone();
    runtime.root.position.set(0, 0, 0);
    runtime.root.updateMatrixWorld(true);
    const key = `${JSON.stringify(runtime.item.pose)}|${runtime.item.flipped}|${runtime.visibility}`;
    let cache = runtime.local;
    if (!cache || cache.key !== key) {
      // Skinning is the expensive part, so it only happens when the pose or
      // side changes; rotations reuse these positions.
      const toOrient = runtime.orient.matrixWorld.clone().invert();
      const positions = runtime.meshes.map((mesh, meshIndex) => posedPositions(mesh, toOrient.clone().multiply(mesh.matrixWorld), runtime.subsets[meshIndex]?.used ?? null));
      const indices = runtime.meshes.map((mesh, meshIndex) => runtime.subsets[meshIndex]?.index ?? mesh.geometry.getIndex()?.array ?? null);
      const hangingBones = runtime.item.part ? undefined : HANGING_PARTS[runtime.item.weaponKey]?.bones;
      const hanging = runtime.meshes.map((mesh, meshIndex) => {
        if (!hangingBones || !(mesh instanceof THREE.SkinnedMesh)) return null;
        const owner = dominantBones(mesh);
        const used = runtime.subsets[meshIndex]?.used ?? null;
        return Uint8Array.from({ length: positions[meshIndex].length / 3 }, (_, slot) => Number(hangingBones.includes(owner[used ? used[slot] : slot])));
      });
      cache = { key, positions, projected: positions.map((local) => new Float32Array((local.length / 3) * 2)), indices, hanging };
      runtime.local = cache;
    }
    const e = runtime.orient.matrixWorld.elements;
    runtime.root.position.copy(savedPosition);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    const body = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    const projected = cache.positions.map((local, meshIndex) => {
      const out = cache.projected[meshIndex];
      const hanging = cache.hanging[meshIndex];
      for (let index = 0, o = 0; index < local.length; index += 3, o += 2) {
        const lx = local[index];
        const ly = local[index + 1];
        const lz = local[index + 2];
        const x = e[0] * lx + e[4] * ly + e[8] * lz + e[12];
        const y = e[1] * lx + e[5] * ly + e[9] * lz + e[13];
        const z = e[2] * lx + e[6] * ly + e[10] * lz + e[14];
        out[o] = x;
        out[o + 1] = y;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
        if (!hanging?.[o / 2]) {
          body.minX = Math.min(body.minX, x);
          body.maxX = Math.max(body.maxX, x);
          body.minY = Math.min(body.minY, y);
          body.maxY = Math.max(body.maxY, y);
        }
      }
      return out;
    });
    if (!Number.isFinite(minX)) return;
    const originX = Math.floor(minX / cell) * cell;
    const originY = Math.floor(minY / cell) * cell;
    const cellsW = Math.max(1, Math.ceil((maxX - originX) / cell));
    const cellsH = Math.max(1, Math.ceil((maxY - originY) / cell));
    const width = cellsW * SILHOUETTE_PX_PER_CELL;
    const height = cellsH * SILHOUETTE_PX_PER_CELL;
    const previousMask = runtime.footprint?.mask;
    const mask = previousMask && previousMask.length === width * height ? previousMask.fill(0) : new Uint8Array(width * height);
    const scale = SILHOUETTE_PX_PER_CELL / cell;
    const top = originY + cellsH * cell;
    // 1 marks the weapon itself, 2 a piece that may hang past the edge; the weapon wins where they meet.
    let value = 1;
    const mark = (px: number, py: number) => {
      const x = Math.floor(px);
      const y = Math.floor(py);
      if (x >= 0 && y >= 0 && x < width && y < height && mask[y * width + x] !== 1) mask[y * width + x] = value;
    };
    // Edges are walked pixel by pixel, so needle-thin parts like a hose or a
    // barrel still register even when no pixel centre falls inside them.
    const markEdge = (x0: number, y0: number, x1: number, y1: number) => {
      const steps = Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)));
      for (let step = 0; step <= steps; step += 1) {
        const t = steps ? step / steps : 0;
        mark(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t);
      }
    };
    projected.forEach((points, meshIndex) => {
      const indices = cache.indices[meshIndex] ?? null;
      const hanging = cache.hanging[meshIndex];
      const count = indices ? indices.length : points.length / 2;
      for (let corner = 0; corner + 2 < count; corner += 3) {
        const a = (indices ? indices[corner] : corner) * 2;
        const b = (indices ? indices[corner + 1] : corner + 1) * 2;
        const c = (indices ? indices[corner + 2] : corner + 2) * 2;
        value = hanging && hanging[a / 2] + hanging[b / 2] + hanging[c / 2] >= 2 ? 2 : 1;
        const ax = (points[a] - originX) * scale, ay = (top - points[a + 1]) * scale;
        const bx = (points[b] - originX) * scale, by = (top - points[b + 1]) * scale;
        const cx = (points[c] - originX) * scale, cy = (top - points[c + 1]) * scale;
        markEdge(ax, ay, bx, by);
        markEdge(bx, by, cx, cy);
        markEdge(cx, cy, ax, ay);
        const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
        if (Math.abs(area) < 1) continue;
        const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
        const x1 = Math.min(width - 1, Math.ceil(Math.max(ax, bx, cx)));
        const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy)));
        const y1 = Math.min(height - 1, Math.ceil(Math.max(ay, by, cy)));
        const sign = area > 0 ? 1 : -1;
        for (let py = y0; py <= y1; py += 1) {
          const sy = py + 0.5;
          for (let px = x0; px <= x1; px += 1) {
            const sx = px + 0.5;
            if (sign * ((bx - ax) * (sy - ay) - (by - ay) * (sx - ax)) < 0) continue;
            if (sign * ((cx - bx) * (sy - by) - (cy - by) * (sx - bx)) < 0) continue;
            if (sign * ((ax - cx) * (sy - cy) - (ay - cy) * (sx - cx)) < 0) continue;
            mark(px, py);
          }
        }
      }
    });
    const cells = new Set<number>();
    const solid = new Set<number>();
    const baseI = Math.round(originX / cell);
    const baseJ = Math.round(originY / cell);
    for (let by = 0; by < cellsH; by += 1) {
      for (let bx = 0; bx < cellsW; bx += 1) {
        let covered = 0;
        let weapon = 0;
        for (let py = 0; py < SILHOUETTE_PX_PER_CELL; py += 1) {
          const row = (by * SILHOUETTE_PX_PER_CELL + py) * width + bx * SILHOUETTE_PX_PER_CELL;
          for (let px = 0; px < SILHOUETTE_PX_PER_CELL; px += 1) {
            const pixel = mask[row + px];
            if (pixel) covered += 1;
            if (pixel === 1) weapon += 1;
          }
        }
        // A cell counts once the weapon covers a couple of its pixels, so a
        // corner that barely touches it does not claim the whole cell.
        const key = cellKey(baseI + bx, baseJ + (cellsH - 1 - by));
        if (covered >= 2) cells.add(key);
        if (weapon >= 2) solid.add(key);
      }
    }
    runtime.footprint = {
      cells, solid, mask, maskWidth: width, maskHeight: height, originX, originY, width: cellsW * cell, height: cellsH * cell, minZ, maxZ,
      body: Number.isFinite(body.minX) ? body : { minX, minY, maxX, maxY },
      version: (this.#footprintVersion += 1),
    };
  }

  #problemAt(id: string, x: number, y: number): FitProblem {
    const runtime = this.#runtimes.get(id);
    const footprint = runtime?.footprint;
    if (!footprint) return null;
    const cell = GRID_CELL[this.#grid];
    const offsetI = Math.round(x / cell);
    const offsetJ = Math.round(y / cell);
    const halfW = Math.floor(BOARD_WIDTH / cell / 2);
    const halfH = Math.floor(BOARD_HEIGHT / cell / 2);
    if (this.#keepInside) {
      for (const key of footprint.solid) {
        const i = keyI(key) + offsetI;
        const j = keyJ(key) + offsetJ;
        if (i < -halfW || i >= halfW || j < -halfH || j >= halfH) return { kind: 'outside' };
      }
    } else if (Math.abs(x) > BOARD_WIDTH / 2 || Math.abs(y) > BOARD_HEIGHT / 2) {
      // Parts may hang past the edge, but the weapon itself stays on the board.
      return { kind: 'outside' };
    }
    if (!this.#keepApart) return null;
    for (const other of this.#items) {
      if (other.id === id || other.hidden) continue;
      const otherRuntime = this.#runtimes.get(other.id);
      if (!otherRuntime?.footprint) continue;
      const otherI = Math.round(other.x / cell);
      const otherJ = Math.round(other.y / cell);
      const occupied = otherRuntime.footprint.cells;
      for (const key of footprint.cells) {
        const i = keyI(key) + offsetI - otherI;
        const j = keyJ(key) + offsetJ - otherJ;
        for (let di = -this.#spacing; di <= this.#spacing; di += 1) {
          for (let dj = -this.#spacing; dj <= this.#spacing; dj += 1) {
            if (occupied.has(cellKey(i + di, j + dj))) return { kind: 'overlap', otherName: other.weaponName };
          }
        }
      }
    }
    return null;
  }

  #nearestFreeSpot(id: string, x: number, y: number, maxRing = 16): { x: number; y: number } | null {
    const cell = GRID_CELL[this.#grid];
    for (let ring = 1; ring <= maxRing; ring += 1) {
      let best: { x: number; y: number } | null = null;
      let bestDistance = Infinity;
      for (let di = -ring; di <= ring; di += 1) {
        for (let dj = -ring; dj <= ring; dj += 1) {
          if (Math.max(Math.abs(di), Math.abs(dj)) !== ring) continue;
          const distance = di * di + dj * dj;
          if (distance >= bestDistance) continue;
          const spot = { x: x + di * cell, y: y + dj * cell };
          if (!this.#problemAt(id, spot.x, spot.y)) {
            best = spot;
            bestDistance = distance;
          }
        }
      }
      if (best) return best;
    }
    return null;
  }

  #findFreeSpot(runtime: ItemRuntime): { x: number; y: number } | null {
    const cell = GRID_CELL[this.#grid];
    const halfW = Math.floor(BOARD_WIDTH / cell / 2);
    const halfH = Math.floor(BOARD_HEIGHT / cell / 2);
    // Reading order: top-left first, the way a board is usually filled.
    for (let j = halfH; j >= -halfH; j -= 1) {
      for (let i = -halfW; i <= halfW; i += 1) {
        if (!this.#problemAt(runtime.item.id, i * cell, j * cell)) return { x: i * cell, y: j * cell };
      }
    }
    return null;
  }

  #updateCellMarkers(): void {
    const cell = GRID_CELL[this.#grid];
    const matrix = new THREE.Matrix4();
    const color = new THREE.Color();
    let count = 0;
    const add = (i: number, j: number, hex: number) => {
      if (count >= MAX_CELL_MARKERS) return;
      matrix.makeScale(cell * 0.82, cell * 0.82, 1).setPosition((i + 0.5) * cell, (j + 0.5) * cell, 0.05);
      this.#cells.setMatrixAt(count, matrix);
      this.#cells.setColorAt(count, color.setHex(hex));
      count += 1;
    };
    const drawItem = (id: string, x: number, y: number, hex: number) => {
      const footprint = this.#runtimes.get(id)?.footprint;
      if (!footprint) return;
      const offsetI = Math.round(x / cell);
      const offsetJ = Math.round(y / cell);
      for (const key of footprint.cells) add(keyI(key) + offsetI, keyJ(key) + offsetJ, hex);
    };
    if (this.#showGrid) {
      for (const item of this.#items) {
        if (item.id !== this.#drag?.id) drawItem(item.id, item.x, item.y, 0x8a96a8);
      }
    }
    const drag = this.#drag;
    if (drag?.candidate) {
      const ok = !this.#problemAt(drag.id, drag.candidate.x, drag.candidate.y);
      drawItem(drag.id, drag.candidate.x, drag.candidate.y, ok ? 0x46c07a : 0xe06060);
    } else if (this.#selectedId) {
      const item = this.#items.find((entry) => entry.id === this.#selectedId);
      // A selected weapon that fits keeps a clean view; only a conflict is marked.
      if (item && this.#problemAt(item.id, item.x, item.y)) drawItem(item.id, item.x, item.y, 0xe06060);
    }
    this.#dirty = true;
    this.#cells.count = count;
    // Upload just the markers in use; the buffer holds thousands, most frames draw none.
    if (count) {
      this.#cells.instanceMatrix.clearUpdateRanges();
      this.#cells.instanceMatrix.addUpdateRange(0, count * 16);
      this.#cells.instanceMatrix.needsUpdate = true;
      if (this.#cells.instanceColor) {
        this.#cells.instanceColor.clearUpdateRanges();
        this.#cells.instanceColor.addUpdateRange(0, count * 3);
        this.#cells.instanceColor.needsUpdate = true;
      }
    }
  }

  #showGhost(id: string, x: number, y: number, ok: boolean): void {
    const footprint = this.#runtimes.get(id)?.footprint;
    if (!footprint) return;
    const material = this.#ghost.material;
    const canvas = this.#ghostCanvas;
    if (this.#ghostVersion !== footprint.version) {
      canvas.width = footprint.maskWidth;
      canvas.height = footprint.maskHeight;
      const ctx = canvas.getContext('2d')!;
      const image = ctx.createImageData(canvas.width, canvas.height);
      for (let index = 0; index < footprint.mask.length; index += 1) {
        if (!footprint.mask[index]) continue;
        image.data[index * 4] = 255;
        image.data[index * 4 + 1] = 255;
        image.data[index * 4 + 2] = 255;
        image.data[index * 4 + 3] = 255;
      }
      ctx.putImageData(image, 0, 0);
    }
    const map = material.map;
    // GPU texture storage is fixed at its first size, and a rotation resizes the
    // silhouette canvas, so a resized canvas needs a fresh texture.
    if (!map || map.image !== canvas || this.#ghostSize !== `${canvas.width}x${canvas.height}`) {
      map?.dispose();
      material.map = new THREE.CanvasTexture(canvas);
      this.#ghostSize = `${canvas.width}x${canvas.height}`;
      material.needsUpdate = true;
    } else if (this.#ghostVersion !== footprint.version) {
      map.needsUpdate = true;
    }
    this.#ghostVersion = footprint.version;
    material.color.setHex(ok ? 0xdfe8f5 : 0xe04848);
    material.opacity = ok ? 0.42 : 0.55;
    this.#ghost.scale.set(footprint.width, footprint.height, 1);
    this.#ghost.position.set(x + footprint.originX + footprint.width / 2, y + footprint.originY + footprint.height / 2, 0.08);
    this.#ghost.visible = true;
  }

  // ---------- pointer ----------

  #boardPoint(clientX: number, clientY: number): THREE.Vector2 | null {
    const rect = this.#options.canvas.getBoundingClientRect();
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return null;
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    const point = new THREE.Vector3(ndc.x, ndc.y, 0).unproject(this.#camera);
    return new THREE.Vector2(point.x, point.y);
  }

  #pick(clientX: number, clientY: number): ItemRuntime | null {
    const rect = this.#options.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.#raycaster.setFromCamera(ndc, this.#camera);
    const roots = this.#items.filter((item) => !item.hidden).map((item) => this.#runtimes.get(item.id)?.root).filter((root): root is THREE.Group => !!root);
    const hit = this.#raycaster.intersectObjects(roots, true)[0];
    if (!hit) return null;
    for (const runtime of this.#runtimes.values()) {
      let node: THREE.Object3D | null = hit.object;
      while (node) {
        if (node === runtime.root) return runtime;
        node = node.parent;
      }
    }
    return null;
  }

  #onCanvasHover = (event: PointerEvent): void => {
    if (this.#drag) return;
    const hovering = this.#pick(event.clientX, event.clientY);
    this.#options.canvas.style.cursor = hovering ? 'grab' : '';
  };

  #onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    const runtime = this.#pick(event.clientX, event.clientY);
    if (!runtime) {
      this.select(null);
      return;
    }
    const point = this.#boardPoint(event.clientX, event.clientY);
    if (!point) return;
    this.select(runtime.item.id);
    this.#drag = {
      id: runtime.item.id,
      grabX: point.x - runtime.item.x,
      grabY: point.y - runtime.item.y,
      fromX: runtime.item.x,
      fromY: runtime.item.y,
      external: false,
      candidate: { x: runtime.item.x, y: runtime.item.y },
    };
    this.#options.canvas.style.cursor = 'grabbing';
    window.addEventListener('pointermove', this.#onWindowMove);
    window.addEventListener('pointerup', this.#onWindowUp);
  };

  #onWindowMove = (event: PointerEvent): void => {
    this.#lastPointer = { x: event.clientX, y: event.clientY };
    if (!this.#drag) return;
    this.#queuedPointer = this.#lastPointer;
    this.#dirty = true;
  };

  #dragTo(clientX: number, clientY: number): void {
    const drag = this.#drag;
    if (!drag) return;
    const runtime = this.#runtimes.get(drag.id);
    if (!runtime) return;
    const point = this.#boardPoint(clientX, clientY);
    if (!point) {
      if (drag.external) {
        runtime.root.visible = false;
        this.#ghost.visible = false;
        drag.candidate = null;
        this.#pending = null;
        this.#updateCellMarkers();
        this.#emit();
      }
      return;
    }
    runtime.root.visible = true;
    const cell = GRID_CELL[this.#grid];
    const rawX = point.x - drag.grabX;
    const rawY = point.y - drag.grabY;
    drag.candidate = this.#snap
      ? { x: Math.round(rawX / cell) * cell, y: Math.round(rawY / cell) * cell }
      : { x: rawX, y: rawY };
    const problem = this.#problemAt(drag.id, drag.candidate.x, drag.candidate.y);
    // The weapon is carried above the board under the pointer; its flat
    // silhouette marks where it will land.
    let floor = 0;
    if (!this.#keepApart) {
      for (const item of this.#items) {
        const other = this.#runtimes.get(item.id);
        if (other && other !== runtime) floor = Math.max(floor, this.#topOf(other));
      }
    }
    runtime.root.position.set(rawX, rawY, floor + (runtime.footprint ? -runtime.footprint.minZ : 4) + CARRY_LIFT);
    this.#showGhost(drag.id, drag.candidate.x, drag.candidate.y, !problem);
    this.#pending = { id: drag.id, problem };
    this.#updateCellMarkers();
    this.#emit();
  }

  #onWindowUp = (): void => {
    if (this.#pendingExternal && !this.#drag) {
      // Let go before the weapon finished loading: it drops here once it arrives.
      this.#releasedWhileLoading = true;
      window.removeEventListener('pointermove', this.#onWindowMove);
      window.removeEventListener('pointerup', this.#onWindowUp);
      return;
    }
    // Land where the pointer actually let go, even if that move never got a frame.
    if (this.#drag && this.#queuedPointer) this.#dragTo(this.#queuedPointer.x, this.#queuedPointer.y);
    this.#queuedPointer = null;
    this.#cancelExternalDrag();
    const drag = this.#drag;
    this.#drag = null;
    this.#ghost.visible = false;
    this.#pending = null;
    this.#options.canvas.style.cursor = '';
    if (!drag) return;
    const runtime = this.#runtimes.get(drag.id);
    if (!runtime) return;
    // Released over the board: land on the spot under the pointer, or the
    // nearest one that fits. Released anywhere else: nothing is placed.
    const candidate = drag.candidate
      ? (this.#problemAt(drag.id, drag.candidate.x, drag.candidate.y) ? this.#nearestFreeSpot(drag.id, drag.candidate.x, drag.candidate.y) : drag.candidate)
      : null;
    if (drag.external) {
      if (candidate) {
        runtime.item.x = candidate.x;
        runtime.item.y = candidate.y;
        this.#commitRuntime(runtime);
        this.select(runtime.item.id);
      } else {
        this.#disposeRuntime(runtime);
        this.#selectedId = null;
      }
    } else {
      if (candidate) {
        runtime.item.x = candidate.x;
        runtime.item.y = candidate.y;
        this.#replaceItem(runtime);
      }
      this.#restack();
      this.select(drag.id);
      this.#checkpoint();
    }
    this.#updateCellMarkers();
    this.#emit();
  };

  /** Keep an edit that fits; put back the last fitting pose if it does not. */
  settle(id: string): void {
    this.#flushReshapes();
    this.#liveEditId = null;
    const runtime = this.#runtimes.get(id);
    if (!runtime) return;
    if (!this.#problemAt(id, runtime.item.x, runtime.item.y)) {
      this.#rememberValid(runtime);
    } else {
      const valid = this.#lastValid.get(id);
      if (valid) {
        Object.assign(runtime.item, valid, { pose: { ...valid.pose } });
        this.#reshape(runtime);
        this.#replaceItem(runtime);
        this.#restack();
      }
    }
    this.#pending = null;
    this.#checkpoint();
    this.#updateCellMarkers();
    this.#sharpenPaints();
    this.#emit();
  }

  #rememberValid(runtime: ItemRuntime): void {
    const { roll, tilt, turn, flipped, scale, pose } = runtime.item;
    this.#lastValid.set(runtime.item.id, { roll, tilt, turn, flipped, scale, pose: { ...pose } });
  }

  /** Where the selected item sits on screen, for the HTML rotation gizmo. */
  screenInfo(id: string): { x: number; y: number; radius: number } | null {
    const runtime = this.#runtimes.get(id);
    const footprint = runtime?.footprint;
    if (!runtime || !footprint) return null;
    const canvas = this.#options.canvas;
    const unitsPerPx = (this.#camera.right - this.#camera.left) / canvas.clientWidth;
    const corners = [
      [footprint.originX, footprint.originY],
      [footprint.originX + footprint.width, footprint.originY + footprint.height],
    ];
    const reach = Math.max(...corners.flat().map(Math.abs));
    const point = new THREE.Vector3(runtime.item.x, runtime.item.y, 0).project(this.#camera);
    return {
      x: (point.x + 1) / 2 * canvas.clientWidth,
      y: (1 - point.y) / 2 * canvas.clientHeight,
      radius: Math.min(reach * 0.75, 60) / unitsPerPx,
    };
  }

  /** Drag handles for the selected weapon's pose controls, at the parts they move. */
  poseHandles(id: string): PoseHandle[] {
    const runtime = this.#runtimes.get(id);
    const rig = runtime && !runtime.item.part ? POSE_RIGS[runtime.item.weaponKey] : undefined;
    if (!runtime || !rig || runtime.item.hidden) return [];
    runtime.root.updateMatrixWorld(true);
    const handles: PoseHandle[] = [];
    for (const control of rig.controls) {
      const point = this.#handlePoint(runtime, control);
      if (point) handles.push({ controlId: control.id, ...point });
    }
    return handles;
  }

  /**
   * Where a handle travels as its control runs from min to max, sampled in
   * canvas pixels. Dragging a handle picks the value whose point is nearest.
   */
  poseHandlePath(id: string, controlId: string): { values: number[]; points: { x: number; y: number }[] } | null {
    const runtime = this.#runtimes.get(id);
    const rig = runtime && !runtime.item.part ? POSE_RIGS[runtime.item.weaponKey] : undefined;
    const control = rig?.controls.find((entry) => entry.id === controlId);
    if (!runtime || !rig || !control) return null;
    const values: number[] = [];
    const points: { x: number; y: number }[] = [];
    const steps = Math.min(180, Math.max(24, Math.round((control.max - control.min) / control.step)));
    for (let step = 0; step <= steps; step += 1) {
      const value = control.min + ((control.max - control.min) * step) / steps;
      rig.apply(runtime.bones, { ...runtime.item.pose, [control.id]: value });
      runtime.root.updateMatrixWorld(true);
      const point = this.#handlePoint(runtime, control);
      if (!point) continue;
      values.push(value);
      points.push(point);
    }
    rig.apply(runtime.bones, runtime.item.pose);
    runtime.root.updateMatrixWorld(true);
    return points.length ? { values, points } : null;
  }

  #handlePoint(runtime: ItemRuntime, control: PoseControl): { x: number; y: number } | null {
    const anchor = control.handle ? this.#handleAnchor(runtime, control.handle) : null;
    if (!anchor) return null;
    // A skinned mesh's vertex position already includes the bone transform.
    const point = anchor.mesh.getVertexPosition(anchor.vertex, new THREE.Vector3());
    point.applyMatrix4(anchor.mesh.matrixWorld).project(this.#camera);
    const canvas = this.#options.canvas;
    return { x: (point.x + 1) / 2 * canvas.clientWidth, y: (1 - point.y) / 2 * canvas.clientHeight };
  }

  /** The vertex of a moving part farthest from its pivot, which travels the most. */
  #handleAnchor(runtime: ItemRuntime, boneName: string): { mesh: THREE.SkinnedMesh; vertex: number } | null {
    const cacheKey = `${runtime.item.weaponKey}|${boneName}`;
    const cached = this.#anchors.get(cacheKey);
    if (cached !== undefined) {
      const mesh = cached && runtime.meshes[cached.meshIndex];
      return mesh instanceof THREE.SkinnedMesh && cached ? { mesh, vertex: cached.vertex } : null;
    }
    const pivot = runtime.bones.get(boneName)?.bone;
    const search: { best: { meshIndex: number; vertex: number } | null; farthest: number } = { best: null, farthest: -1 };
    if (pivot) {
      const restWorld = new THREE.Vector3();
      const target = new THREE.Vector3();
      runtime.meshes.forEach((mesh, meshIndex) => {
        if (!(mesh instanceof THREE.SkinnedMesh)) return;
        const owner = dominantBones(mesh);
        const boneIndex = mesh.skeleton.bones.findIndex((bone) => bone.name === boneName);
        if (boneIndex < 0) return;
        // Pivot and vertices compared in bind space, where the mesh rests.
        restWorld.setFromMatrixPosition(mesh.skeleton.boneInverses[boneIndex].clone().invert());
        owner.forEach((name, vertex) => {
          if (name !== boneName) return;
          target.fromBufferAttribute(mesh.geometry.getAttribute('position'), vertex).applyMatrix4(mesh.bindMatrix);
          const distance = target.distanceToSquared(restWorld);
          if (distance > search.farthest) {
            search.farthest = distance;
            search.best = { meshIndex, vertex };
          }
        });
      });
    }
    this.#anchors.set(cacheKey, search.best);
    const found = search.best;
    const mesh = found ? runtime.meshes[found.meshIndex] : null;
    return found && mesh instanceof THREE.SkinnedMesh ? { mesh, vertex: found.vertex } : null;
  }

  readonly #anchors = new Map<string, { meshIndex: number; vertex: number } | null>();

  // ---------- rendering ----------

  #frameBounds(): { width: number; height: number } {
    if (this.#background === 'framed') {
      return { width: BOARD_WIDTH + FRAME_SIDE * 2, height: BOARD_HEIGHT + FRAME_SIDE * 2 };
    }
    return { width: BOARD_WIDTH, height: BOARD_HEIGHT };
  }

  #fitCamera(aspect: number, padding: number): void {
    const bounds = this.#frameBounds();
    const width = bounds.width * padding;
    const height = bounds.height * padding;
    const halfH = Math.max(height, width / aspect) / 2;
    const halfW = halfH * aspect;
    this.#camera.left = -halfW;
    this.#camera.right = halfW;
    this.#camera.top = halfH;
    this.#camera.bottom = -halfH;
    this.#camera.updateProjectionMatrix();
  }

  #resize(): void {
    const canvas = this.#options.canvas;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (!width || !height) return;
    this.renderer.setSize(width, height, false);
    this.#fitCamera(width / height, 1.06);
    this.#sharpenPaints();
    this.#emit();
  }

  #frameLoop = (): void => {
    if (this.#disposed) return;
    this.#raf = requestAnimationFrame(this.#frameLoop);
    if (this.#drag && this.#queuedPointer) {
      const { x, y } = this.#queuedPointer;
      this.#queuedPointer = null;
      this.#dragTo(x, y);
    }
    this.#flushReshapes();
    if (this.#notifyQueued) {
      this.#notifyQueued = false;
      for (const listener of this.#listeners) listener();
    }
    if (!this.#dirty) return;
    this.#dirty = false;
    this.renderer.render(this.#scene, this.#camera);
  };

  /** Pixel size of an export at the given width, following the visible frame's aspect. */
  outputSize(width: number): { width: number; height: number } {
    const bounds = this.#frameBounds();
    return { width, height: Math.round(width * bounds.height / bounds.width) };
  }

  /** Resolves once every weapon on the board wears its finished paint and material. */
  async whenPainted(): Promise<void> {
    let waitedFor = '';
    for (;;) {
      const runtimes = [...this.#runtimes.values()];
      const keys = [...new Set(runtimes.map((runtime) => runtime.paintKey))].filter(Boolean).sort();
      const state = [...keys, ...runtimes.map((runtime) => runtime.materialKey)].join('\n');
      // Paints and materials can change while waiting, so wait again until a pass finds nothing new.
      if (state === waitedFor) return;
      waitedFor = state;
      await Promise.all([...keys.map((key) => this.#paints.get(key)), ...runtimes.map((runtime) => runtime.materialReady)]);
    }
  }

  /** Render the board alone (no gizmo, markers, or silhouette) at a fixed output width. */
  async exportPng(outputWidth = 1920): Promise<Blob> {
    // Paints sized for the screen are sharpened for the export first, and an
    // export taken while they are still streaming in would show them half done.
    this.#sharpenPaints(this.#pixelsPerUnit() * outputWidth / Math.max(1, this.renderer.domElement.width));
    await this.whenPainted();
    this.#flushReshapes();
    const outputHeight = this.outputSize(outputWidth).height;
    const hidden = [this.#cells, this.#ghost].filter((object) => object.visible);
    for (const object of hidden) object.visible = false;
    const previousRatio = this.renderer.getPixelRatio();
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(outputWidth, outputHeight, false);
    this.#fitCamera(outputWidth / outputHeight, 1);
    this.renderer.render(this.#scene, this.#camera);
    const blob = await new Promise<Blob | null>((resolve) => this.renderer.domElement.toBlob(resolve, 'image/png'));
    for (const object of hidden) object.visible = true;
    this.renderer.setPixelRatio(previousRatio);
    this.#resize();
    if (!blob) throw new Error('export failed');
    return blob;
  }

  dispose(): void {
    this.#disposed = true;
    cancelAnimationFrame(this.#raf);
    window.clearTimeout(this.#paintSweep);
    this.#cancelExternalDrag();
    window.removeEventListener('pointermove', this.#onWindowMove);
    window.removeEventListener('pointerup', this.#onWindowUp);
    this.#options.canvas.removeEventListener('pointerdown', this.#onPointerDown);
    this.#options.canvas.removeEventListener('pointermove', this.#onCanvasHover);
    this.#resizeObserver.disconnect();
    for (const runtime of this.#runtimes.values()) this.#disposeRuntime(runtime);
    this.#compositor.dispose();
    this.renderer.dispose();
  }
}

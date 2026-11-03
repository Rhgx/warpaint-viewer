import * as THREE from 'three';

import type { RecipeNode, TextureResolver } from '../compositor/types';
import type { TextureMetadata, WeaponEntry, WeaponMaterial } from '../data/types';
import type { Tf2Uniforms } from '../viewer/materialConfig';
import type { RestBone } from './poseRigs';

// Data shapes shared by the showcase board, its runtime state and its UI.
export type GridSize = 'fine' | 'normal' | 'coarse';
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
  /** Set when this item is an imported picture rather than a weapon; it then has no weapon key and a placeholder paint. */
  image?: { assetId: string; aspect: number };
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
  /** Null when none or several are selected. */
  selectedId: string | null;
  selectedIds: readonly string[];
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
  resolveMaterial: (weaponKey: string, kitId: number) => Promise<WeaponMaterial | undefined>;
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

export interface ItemRuntime {
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
  emissive: { material: THREE.ShaderMaterial; overlays: THREE.Mesh[] } | null;
  /** The emissive pass leaves these out, as in the viewer. */
  lenses: ReadonlySet<THREE.Mesh>;
  /** The material names its own $envmap rather than reflecting the board's default. */
  customEnvMap?: boolean;
  /** Height of whatever this weapon rests on when overlaps are allowed. */
  stackZ: number;
  /** Posed vertex positions before the rotation, so turning needs one matrix per vertex; rebuilt when the pose or side changes. */
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
  /** Counts material lookups, so a slow one cannot replace the answer to a newer one. */
  materialRequest: number;
  /** Resolution of the paint it wears or is waiting on; it only ever grows. */
  paintSize: number;
  /** Which bones' triangles are drawn; changes when a piece is taken out or put back. */
  visibility: string;
  /** Per mesh, the vertices still drawn and the triangles renumbered onto them; null draws everything. */
  subsets: (MeshSubset | null)[];
}

export interface MeshSubset {
  used: Uint32Array;
  /** Triangles numbered by position in `used`, for the footprint. */
  index: Uint32Array;
  /** The same triangles on the original vertices, for drawing. */
  drawIndex: Uint32Array;
}

export interface DragState {
  id: string;
  grabX: number;
  grabY: number;
  fromX: number;
  fromY: number;
  external: boolean;
  candidate: { x: number; y: number } | null;
  group?: readonly { id: string; dx: number; dy: number }[];
}

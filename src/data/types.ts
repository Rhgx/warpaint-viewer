// Typed shapes for public/data/manifest.json and recipe files.

import type { OperationNodeMsg } from '../protodefs/messages';

export interface WeaponMaterial {
  phongExponent: number | null;
  phongBoost: number;
  envmapTint: [number, number, number];
  /** Source cubemap named by $envmap. Imported package materials may supply it. */
  envmapTexture?: string | null;
  normalMap: string | null;
  phong: boolean;
  phongExponentFactor: number | null;
  phongExponentTexture?: string | null;
  lightwarpTexture?: string | null;
  halfLambert?: boolean;
  baseMapAlphaPhongMask?: boolean;
  baseMapAlphaEnvmapMask?: boolean;
  normalMapAlphaEnvmapMask?: boolean;
  phongAlbedoTint?: boolean;
  phongTint?: [number, number, number] | null;
  phongFresnelRanges?: [number, number, number];
  rimLight?: boolean;
  rimLightExponent?: number;
  rimLightBoost?: number;
  rimMask?: boolean;
  selfIllum?: boolean;
  selfIllumMask?: string | null;
  selfIllumTint?: [number, number, number] | null;
  selfIllumFresnel?: boolean;
  selfIllumFresnelMinMaxExp?: [number, number, number];
  modelGlowColor?: boolean;
  // The fields below are only ever set by a material imported from a Source
  // package (src/source/vmt.ts). No stock weapon VMT uses them, so the
  // pipeline never writes them into manifest.json.
  alphaTest?: boolean;
  alphaTestReference?: number;
  /**
   * $allowalphatocoverage. Turns the tested alpha into multisample coverage,
   * so a material whose alpha sits just above the reference renders partly
   * see-through instead of simply passing the test.
   */
  alphaToCoverage?: boolean;
  /** Viewmodel shader flags retained from the Source material. */
  unlit?: boolean;
  unlitTwoTexture?: boolean;
  additive?: boolean;
  translucent?: boolean;
  alpha?: number;
  /** $detail and friends, combined per common_ps_fxc.h TextureCombine. */
  detailTexture?: string | null;
  detailScale?: number;
  detailBlendFactor?: number;
  detailBlendMode?: number;
  detailTint?: [number, number, number] | null;
  detailScrollRate?: number | null;
  detailScrollAngle?: number | null;
  /** $EmissiveBlendEnabled: a second additive pass over the weapon. */
  emissiveBlend?: boolean;
  emissiveBlendStrength?: number;
  emissiveBlendTint?: [number, number, number] | null;
  emissiveBlendBaseTexture?: string | null;
  emissiveBlendTexture?: string | null;
  emissiveBlendFlowTexture?: string | null;
  emissiveBlendScrollVector?: [number, number];
}

export interface WeaponEntry {
  key: string; // model file stem, e.g. "c_shotgun"
  name: string;
  model: string; // relative to public/data, e.g. "models/c_shotgun.glb"
  compositeWidth?: number;
  compositeHeight?: number;
  icon?: string; // backpack icon WebP relative to public/data, e.g. "icons/weapons/c_shotgun.webp"
  /** Valve-authored inventory presentation attachment from the weapon MDL. */
  iconCamera?: {
    position: [number, number, number];
    forward: [number, number, number];
    up: [number, number, number];
  };
  material: WeaponMaterial;
  /** items_game attached_models drawn with the weapon but never painted, e.g. the Rescue Ranger's screen. */
  attachments?: WeaponAttachment[];
}

export interface WeaponAttachment {
  model: string; // relative to public/data
  material: WeaponMaterial & { baseTexture: string };
}

export type Grade = 'civilian' | 'freelance' | 'mercenary' | 'commando' | 'assassin' | 'elite';

export interface PaintkitEntry {
  id: number;
  name: string;
  collection: string | null;
  icon?: string; // pattern swatch WebP relative to public/data, e.g. "icons/paints/431.webp"
  hasTeamTextures: boolean; // has_team_textures is set, or the BLU recipes differ from RED
  weapons: string[]; // weapon keys this kit can render on
  perWear?: boolean; // if true, recipe files are split per wear level
  materialOverrides?: Record<string, string>; // weapon key -> manifest material id
  grade?: Grade; // rarity grade, populated at load time from public/data/grades.json
}

/** One paint's entry in Pyxell's texture directory, verbatim from the page. */
export interface TextureDirectoryEntry {
  base?: string[];
  textures: string[];
  features?: string[];
  notes?: string[];
}

/** public/data/texture-directory.json, written by tools/extract/texture-directory.mjs. */
export interface TextureDirectory {
  source: string;
  retrievedAt: string; // YYYY-MM-DD
  legend: { term: string; description: string }[];
  entries: Record<string, TextureDirectoryEntry>; // keyed by built-in paint kit id
}

/** One variable on an operation header. `inherit` is present only when set explicitly (the schema default is true). */
export interface OperationTemplateVariable {
  name: string;
  value: string;
  inherit?: boolean;
}

/** One weapon slot of a stock paint: the item definition it paints, and the weapon's model maps. */
export interface OperationTemplateSlot {
  defindex: number;
  data: { variable: { variable: string; string: string }[] };
}

/** A top-level operation template used by at least one stock paint kit. */
export interface OperationTemplateInfo {
  defindex: number;
  name: string;
  variables: OperationTemplateVariable[];
  /** Weapon slot field (e.g. "scattergun") -> slot, from one stock paint that uses this template. */
  items: Record<string, OperationTemplateSlot>;
  /** The template's operation_node with nested operation_template references inlined. */
  operationNode: OperationNodeMsg[];
  textureLayers: number; // distinct texture_layer_N variables
  stickers: number; // apply_sticker stages reached
  stickerVariants: number; // most stickers in one apply_sticker stage
  innerWear: boolean; // any inner_layer_N variable
  teamTextures: boolean; // a texture_red/texture_blue lookup, or "team_color" in the name
}

/** A template as written in the file: each items entry is an index into OperationTemplateFile.slots. */
interface OperationTemplateFileInfo extends Omit<OperationTemplateInfo, 'items'> {
  items: Record<string, number>;
}

/** public/data/operation-templates.json, written by tools/extract/operation-templates.mjs. */
export interface OperationTemplateFile {
  usage: Record<string, number[]>; // operation defindex -> sorted paint kit ids that reach it
  names: Record<string, string>; // operation defindex -> header name, for every operation in usage
  slots: OperationTemplateSlot[]; // every distinct weapon slot, shared by the templates
  templates: OperationTemplateFileInfo[];
}

/** The operation template data the app reads, with each items index expanded to its slot. */
export interface OperationTemplateData {
  usage: Record<string, number[]>; // operation defindex -> sorted paint kit ids that reach it
  names: Record<string, string>; // operation defindex -> header name, for every operation in usage
  templates: OperationTemplateInfo[];
}

export interface Manifest {
  generatedAt: string;
  /**
   * TF2 PatchVersion the shipped game-data snapshots came from (steam.inf), or
   * null when the pipeline could not read it. The export builder shows this so
   * anyone on a newer build knows to point it at their own files instead.
   */
  gameBuild?: string | null;
  paintkits: PaintkitEntry[];
  weapons: WeaponEntry[];
  materials?: Record<string, WeaponMaterial>;
  textures?: Record<string, TextureMetadata>;
  collectionIcons?: Record<string, string>; // collection display name -> icon WebP relative to public/data
  wearLevels: number[];
  wearNames: string[];
}

export interface TextureMetadata {
  width: number;
  height: number;
  mipCount: number;
  clampS: boolean;
  clampT: boolean;
  pointSample: boolean;
  trilinear: boolean;
  anisotropic: boolean;
  noMip: boolean;
  noLod: boolean;
}

export type Team = 'red' | 'blu';

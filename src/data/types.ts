// Typed shapes for public/data/manifest.json and recipe files.

export interface WeaponMaterial {
  phongExponent: number | null;
  phongBoost: number;
  envmapTint: [number, number, number];
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
  emissiveBlend?: boolean;
  emissiveBlendStrength?: number;
  emissiveBlendTint?: [number, number, number] | null;
  /** The glowing color texture ($EmissiveBlendBaseTexture). */
  emissiveBlendBaseTexture?: string | null;
  /** The mask that decides where the glow shows ($EmissiveBlendTexture). */
  emissiveBlendTexture?: string | null;
  /** UV units per second the glow scrolls by. */
  emissiveBlendScrollVector?: [number, number];
}

export interface WeaponEntry {
  key: string; // model file stem, e.g. "c_shotgun"
  name: string;
  model: string; // relative to public/data, e.g. "models/c_shotgun.glb"
  compositeWidth?: number;
  compositeHeight?: number;
  icon?: string; // backpack icon PNG relative to public/data, e.g. "icons/weapons/c_shotgun.png"
  material: WeaponMaterial;
}

export type Grade = 'civilian' | 'freelance' | 'mercenary' | 'commando' | 'assassin' | 'elite';

export interface PaintkitEntry {
  id: number;
  name: string;
  collection: string | null;
  icon?: string; // pattern swatch PNG relative to public/data, e.g. "icons/paints/431.png"
  hasTeamTextures: boolean;
  weapons: string[]; // weapon keys this kit can render on
  perWear?: boolean; // if true, recipe files are split per wear level
  materialOverrides?: Record<string, string>; // weapon key -> manifest material id
  grade?: Grade; // rarity grade, populated at load time from public/data/grades.json
}

export interface Manifest {
  generatedAt: string;
  paintkits: PaintkitEntry[];
  weapons: WeaponEntry[];
  materials?: Record<string, WeaponMaterial>;
  textures?: Record<string, TextureMetadata>;
  collectionIcons?: Record<string, string>; // collection display name -> icon PNG relative to public/data
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

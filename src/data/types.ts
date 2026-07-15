// Typed shapes for public/data/manifest.json and recipe files. See DESIGN.md.

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
}

export interface WeaponEntry {
  key: string; // model file stem, e.g. "c_shotgun"
  name: string;
  model: string; // relative to public/data, e.g. "models/c_shotgun.glb"
  icon?: string; // backpack icon PNG relative to public/data, e.g. "icons/weapons/c_shotgun.png"
  material: WeaponMaterial;
}

export interface PaintkitEntry {
  id: number;
  name: string;
  collection: string | null;
  icon?: string; // pattern swatch PNG relative to public/data, e.g. "icons/paints/431.png"
  hasTeamTextures: boolean;
  weapons: string[]; // weapon keys this kit can render on
  perWear?: boolean; // if true, recipe files are split per wear level
  materialOverrides?: Record<string, string>; // weapon key -> manifest material id
}

export interface Manifest {
  generatedAt: string;
  paintkits: PaintkitEntry[];
  weapons: WeaponEntry[];
  materials?: Record<string, WeaponMaterial>;
  collectionIcons?: Record<string, string>; // collection display name -> icon PNG relative to public/data
  wearLevels: number[];
  wearNames: string[];
}

export type Team = 'red' | 'blu';

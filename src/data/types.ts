// Typed shapes for public/data/manifest.json and recipe files. See DESIGN.md.

export interface WeaponMaterial {
  phongExponent: number | null;
  phongBoost: number;
  envmapTint: [number, number, number];
  normalMap: string | null; // null for all current TF2 paintkit weapons
  phong: boolean;
  // Set when the VMT uses $phongexponentfactor with an exponent texture instead
  // of a scalar $phongexponent; used as an approximate exponent scale.
  phongExponentFactor: number | null;
}

export interface WeaponEntry {
  key: string; // model file stem, e.g. "c_shotgun"
  name: string;
  model: string; // relative to public/data, e.g. "models/c_shotgun.glb"
  material: WeaponMaterial;
}

export interface PaintkitEntry {
  id: number;
  name: string;
  collection: string | null;
  hasTeamTextures: boolean;
  weapons: string[]; // weapon keys this kit can render on
  perWear?: boolean; // if true, recipe files are split per wear level
}

export interface Manifest {
  generatedAt: string;
  paintkits: PaintkitEntry[];
  weapons: WeaponEntry[];
  wearLevels: number[];
  wearNames: string[];
}

export type Team = 'red' | 'blu';

import type { TextureMetadata } from '../data/types';
import type { ProtoDefKitBundle } from '../protodefs/types';
import type { ExportCompression, ExportTextureKind } from '../export/plan';

export interface ExportItem {
  ref: string;
  kind: ExportTextureKind;
  output: string;
  size?: { width: number; height: number };
}

export interface ExportDefinitionsContext {
  isImported: boolean;
  builtInKits: { defindex: number; name: string }[];
  loadKitBundle: () => Promise<ProtoDefKitBundle | null>;
  packageFiles: () => Promise<{ path: string; data: Uint8Array }[]>;
  packageFileCount: number;
  packageMounted: boolean;
  unresolvedTextureRefs: string[];
  materialFiles: (overrides: readonly string[]) => Promise<{
    files: { path: string; data: Uint8Array }[];
    missing: string[];
    repaired: string[];
  }>;
}

export interface WarpaintExportInputs {
  items: ExportItem[];
  textureMetadata?: Record<string, TextureMetadata>;
  definitions?: ExportDefinitionsContext;
  writesDefinitions: boolean;
  definitionsMode: 'overwrite' | 'append';
  targetDefindex: string;
  inGameName: string;
  packName: string;
  container: 'zip' | 'vpk';
  compression: ExportCompression;
  paintName?: string;
  weaponName?: string;
  gameBuild?: string | null;
  snapshotDate?: string | null;
}

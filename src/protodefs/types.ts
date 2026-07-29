// Contracts shared by the proto_defs decoder, the hook that owns imported
// definitions, and the UI that lists them.

import type { RecipeNode } from '../compositor/types';
import type { SourceDiagnostic } from '../source/contracts';

/**
 * Catalog ids for imported kits are offset out of the built-in range so a
 * custom kit can never shadow or collide with one of the shipped 250, and so
 * any id in this range is recognisable as memory-only.
 */
export const CUSTOM_KIT_ID_BASE = 10_000_000;

export function customKitId(defindex: number): number {
  return CUSTOM_KIT_ID_BASE + defindex;
}

export function isCustomKitId(id: number): boolean {
  return id >= CUSTOM_KIT_ID_BASE;
}

export function customKitDefindex(id: number): number {
  return id - CUSTOM_KIT_ID_BASE;
}

/** Collection name imported kits are grouped under in the catalog. */
export const CUSTOM_KIT_COLLECTION = 'Imported definitions';

/** One paintkit definition found in an imported proto_defs container. */
export interface ProtoDefKit {
  /** CMsgProtoDefHeader.defindex, as authored in the file. */
  defindex: number;
  /**
   * Editor name from the header. The localized display name lives in
   * resource/tf_proto_obj_defs_english.txt, which the container does not carry.
   */
  name: string;
  /** Weapon keys this kit paints, restricted to weapons the viewer can render. */
  weapons: string[];
  hasTeamTextures: boolean;
  /**
   * True when any item definition template carries more than one per-wear
   * definition. This is a cheap proxy for the build pipeline's rule (which
   * compares resolved trees), so it can report per-wear for a kit whose wear
   * levels happen to resolve identically. That only costs a few extra rows in
   * the file editor.
   */
  perWear: boolean;
  /** True when this defindex is outside the built-in catalog. */
  isNew: boolean;
  /** items_game indexes skipped because no catalogued weapon wears that model. */
  unsupportedItemDefs: number[];
  /** Representative pattern texture, for the catalog thumbnail. */
  iconRef?: string;
}

export interface ProtoDefIndex {
  kits: ProtoDefKit[];
  /** Definition counts in the container, keyed by ProtoDefTypes value. */
  countsByType: Record<number, number>;
}

export interface ProtoDefRecipe {
  tree: RecipeNode;
  textureRefs: string[];
}

export interface ProtoDefOpenOptions {
  /** items_game definition index -> weapon key, from public/data/item-defs.json. */
  weaponsByItemDef: Record<string, string>;
  /** Built-in paintkit ids, used to flag which definitions are new. */
  builtInIds: number[];
}

/**
 * One community proto_defs JSON fragment, as read from disk or a ZIP entry:
 * not valid JSON on its own (see src/protodefs/jsonFragments.ts for why), just
 * a name for diagnostics and the raw text.
 */
export interface ProtoDefJsonFragment {
  name: string;
  text: string;
}

/**
 * Decodes one proto_defs container and resolves recipes out of it on demand.
 * The parsed definitions are large (a stock container decodes to tens of
 * megabytes), so an implementation is expected to hold them off the main
 * thread and release them on dispose().
 */
/**
 * A kit's two defining messages, as decoded plain objects, for the export
 * builder to re-encode into a spliced container.
 */
export interface ProtoDefKitMessages {
  definition: Record<string, unknown>;
  operation: Record<string, unknown>;
}

export interface ProtoDefSource {
  open(bytes: Uint8Array, options: ProtoDefOpenOptions): Promise<ProtoDefIndex>;
  /**
   * Same result shape as open(), but assembled from community JSON fragments
   * (an operation file plus a definition file, typically) layered over the
   * stock operations/item definitions/variables carried in baseBytes
   * (public/data/protodefs-base.bin), rather than decoded whole from a .vpd.
   */
  openJsonFragments(
    baseBytes: Uint8Array,
    fragments: ProtoDefJsonFragment[],
    options: ProtoDefOpenOptions,
  ): Promise<ProtoDefIndex>;
  resolveRecipe(
    defindex: number,
    weaponKey: string,
    team: 'red' | 'blu',
    wearIndex: number,
  ): Promise<ProtoDefRecipe | null>;
  /**
   * The definition and operation for one kit, so it can be written into a
   * proto_defs container the game will load. Null when nothing is open or the
   * kit names an operation the container does not hold.
   */
  exportKit(defindex: number): Promise<ProtoDefKitMessages | null>;
  dispose(): void;
}

// ---------------------------------------------------------------------------
// UI contract
// ---------------------------------------------------------------------------

export interface CustomDefinitionKitRow {
  /** Catalog id, i.e. customKitId(defindex). */
  id: number;
  defindex: number;
  name: string;
  weapons: string[];
  isNew: boolean;
  /** Currently present in the catalog. */
  loaded: boolean;
  /** No renderable weapon, so it cannot be loaded. */
  unsupported: boolean;
}

/** A proto_defs file the mounted Source package carries. */
export interface CustomDefinitionsCandidate {
  path: string;
  onLoad: () => void;
}

export interface CustomDefinitionsState {
  status: 'empty' | 'importing' | 'loaded';
  fileName?: string;
  /** Every definition in the file, whether or not it is loaded. */
  kits: CustomDefinitionKitRow[];
  diagnostics: SourceDiagnostic[];
  packageCandidate?: CustomDefinitionsCandidate;
  onImport: (files: File[]) => void;
  /** Add or remove one definition from the catalog. */
  onToggleKit: (defindex: number) => void;
  /** Select a loaded definition in the viewer. */
  onSelectKit: (id: number) => void;
  onRemove: () => void;
}

export const PROTO_DEFS_ACCEPT = '.vpd,.json';

/** Canonical Source path a mod's definitions live at inside a package. */
export const PACKAGE_PROTO_DEFS_PATH = 'scripts/protodefs/proto_defs.vpd';

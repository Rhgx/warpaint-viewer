// Contracts shared by the proto_defs decoder, the hook that owns imported
// definitions, and the UI that lists them.

import type { RecipeNode } from '../compositor/types';
import type { SourceDiagnostic } from '../source/contracts';

/**
 * Catalog ids for imported kits are offset out of the built-in range so a
 * custom kit can never shadow or collide with one of the shipped 250, and so
 * any id in this range is recognisable as memory-only.
 */
const CUSTOM_KIT_ID_BASE = 10_000_000;

export function customKitId(defindex: number): number {
  return CUSTOM_KIT_ID_BASE + defindex;
}

export function isCustomKitId(id: number): boolean {
  return id >= CUSTOM_KIT_ID_BASE;
}

export function customKitDefindex(id: number): number {
  return id - CUSTOM_KIT_ID_BASE;
}

/** The in-game paintkit_proto_def_index for any catalog id, built-in or imported. */
export function paintkitDefindex(id: number): number {
  return isCustomKitId(id) ? customKitDefindex(id) : id;
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
  /** Per-weapon Source material paths authored by item_data.material_override. */
  materialOverrides?: Record<string, string>;
  /** RED and BLU textures are used: has_team_textures is set, or the team trees differ. */
  hasTeamTextures: boolean;
  /**
   * The paint changes per team but has_team_textures is off, so the in-game inspect
   * panel will not show its team buttons (the legacy "has team color paintkit" item
   * attribute is not checked here). Matches still use the RED and BLU textures.
   */
  teamButtonsHidden: boolean;
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

/**
 * Where the resolver obtained one effective operation-field value.  Paths are
 * expressed relative to the two editable kit messages. Weapon-slot paths
 * point into the definition message, while wear and external item-definition
 * paths name the non-editable base branch that supplied the override. They
 * deliberately remain data (rather than object references) so
 * they can safely cross the worker boundary.
 */
type ProtoDefValueScope = 'global' | 'weapon' | 'wear' | 'literal';

export interface ProtoDefValueProvenance {
  variableName?: string;
  effectiveValue: string | undefined;
  sourcePath: string[];
  /**
   * The exact source inside the two-message editor snapshot that can be
   * changed without broadening the edit to another weapon.
   */
  editableSourcePath?: string[];
  scope: ProtoDefValueScope;
  canOverride: boolean;
}

/** One operation field and the source that won during variable resolution. */
export interface ProtoDefValueTrace {
  /** Path to the field consumed by the operation graph. */
  fieldPath: string[];
  provenance: ProtoDefValueProvenance;
}

/** Normal recipe result plus optional, lossless value-source diagnostics. */
export interface ProtoDefRecipeWithProvenance extends ProtoDefRecipe {
  provenance: ProtoDefValueTrace[];
}

export interface ProtoDefOpenOptions {
  /** items_game definition index -> weapon key, from public/data/item-defs.json. */
  weaponsByItemDef: Record<string, string>;
  /** Built-in paintkit ids, used to flag which definitions are new. */
  builtInIds: number[];
  /**
   * Whether new paints get their team flags (has_team_textures, teamButtonsHidden).
   * Defaults to true. Previews only need the kit to exist, so they pass false.
   */
  computeTeamFlags?: boolean;
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

/** Which operation one weapon slot reads at one wear level (0 = Factory New .. 4 = Battle Scarred). */
export interface ProtoDefOperationScope {
  weaponKey: string;
  wear: number;
  /** Index into ProtoDefKitBundle.operations. */
  operationIndex: number;
}

/**
 * Everything one kit needs to be re-created from JSON fragments. A top-level
 * paint has one operation; a per-wear paint (no top-level operation_template)
 * has the operations its weapon slots read at each wear, plus the item
 * definitions those slots use.
 */
export interface ProtoDefKitBundle {
  definition: Record<string, unknown>;
  operations: Record<string, unknown>[];
  itemDefinitions: Record<string, unknown>[];
  scopes: ProtoDefOperationScope[];
}

/**
 * One weapon slot on a paintkit definition, resolved to the weapon it paints
 * and the authored location of its item message inside the definition
 * message: ['definition', <slotName>] for a named WEAPON_SLOTS field, or
 * ['definition', 'item', <index>] for a repeated `item` entry.
 */
export interface ProtoDefKitWeaponSlot {
  weaponKey: string;
  path: readonly string[];
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
  /** Resolve a recipe and retain the authored source of each effective value. */
  resolveRecipeWithProvenance(
    defindex: number,
    weaponKey: string,
    team: 'red' | 'blu',
    wearIndex: number,
  ): Promise<ProtoDefRecipeWithProvenance | null>;
  /**
   * The definition and operation for one kit, so it can be written into a
   * proto_defs container the game will load. Null when nothing is open or the
   * kit names an operation the container does not hold.
   */
  exportKit(defindex: number): Promise<ProtoDefKitMessages | null>;
  /**
   * Like exportKit(), but also returns the item definitions and per-wear
   * operations a per-wear paint needs, so it can be written as JSON fragments.
   */
  exportKitBundle(defindex: number): Promise<ProtoDefKitBundle | null>;
  /**
   * Every weapon slot on one kit's definition, resolved to the weapon it
   * paints and its authored location, so an editor can read or write that
   * weapon's own material_override without guessing which definition field
   * holds it. Null when nothing is open or the kit is not found.
   */
  exportKitWeaponSlots(defindex: number): Promise<ProtoDefKitWeaponSlot[] | null>;
  dispose(): void;
}

// UI contract

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
  /** Its first renderable weapon could not produce an initial recipe. */
  quarantined: boolean;
  /** Made by New war paint, so it can be renamed or deleted. */
  generated: boolean;
}

/** A proto_defs file the mounted Source package carries. */
interface CustomDefinitionsCandidate {
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
  /** False while a whole proto_defs.vpd is loaded, since JSON paints cannot join a container. */
  canAddWarPaint: boolean;
  /** Add a paint built on a stock operation template. Resolves true once it is loaded. */
  onCreateWarPaint: (templateDefindex: number, name: string) => Promise<boolean>;
  /** Add a copy of an exported stock paint (see exportSelectedStockKit). Resolves true once it is loaded. */
  onCreateWarPaintCopy: (messages: ProtoDefKitMessages, name: string) => Promise<boolean>;
  /** The selected paint, when it is a stock paint that a new war paint can copy. */
  selectedStockKit?: { id: number; name: string };
  /** The selected stock paint's definition and operation. Null for a per-wear paint. */
  exportSelectedStockKit?: () => Promise<ProtoDefKitMessages | null>;
  /** Remove a generated war paint's files. Removing the last one clears the set. */
  onDeleteWarPaint: (defindex: number) => void;
  /** Rename a generated war paint. Blank names are ignored. */
  onRenameWarPaint: (defindex: number, name: string) => void;
  /** Add or remove one definition from the catalog. */
  onToggleKit: (defindex: number) => void;
  /** Select a loaded definition in the viewer. */
  onSelectKit: (id: number) => void;
  /** Stock paint names by catalog id, for linking a template's example paints. */
  stockKitNames: Record<number, string>;
  onRemove: () => void;
}

export const PROTO_DEFS_ACCEPT = '.vpd,.json';

/** Canonical Source path a mod's definitions live at inside a package. */
export const PACKAGE_PROTO_DEFS_PATH = 'scripts/protodefs/proto_defs.vpd';

import type { ComponentProps } from 'react';

import type { TextureMetadata } from '../../data/types';
import type { EditorDownloadFormat } from '../../editor/export/definitionExport';
import type { EditorDraftState } from '../../editor/useEditorDraft';
import type { CustomDefinitionsState } from '../../protodefs/types';
import type { SourcePackageState } from '../../source/contracts';
import type { WarpaintAssetOverrides, WearRecipe, WorkbenchTab } from '../../workbench/types';
import type { ExportDefinitionsContext } from '../../workbench/exportTypes';
import type { OperationGraphEditorProps } from '../editor/OperationGraphEditor';
import type { VisualWarpaintEditorPanel } from '../editor/VisualWarpaintEditorPanel';
import type { StickerPlacementEditor } from '../editor/StickerPlacementEditor';
import type { TextureTransformPanel } from '../editor/TextureTransformPanel';
import type { MaterialOverridesPanel } from '../editor/MaterialOverridesPanel';

type VisualWarpaintEditorPanelProps = ComponentProps<typeof VisualWarpaintEditorPanel>;
type StickerPlacementEditorProps = ComponentProps<typeof StickerPlacementEditor>;
type TextureTransformPanelProps = ComponentProps<typeof TextureTransformPanel>;
type MaterialOverridesPanelProps = ComponentProps<typeof MaterialOverridesPanel>;

export type CustomWarpaintWorkbenchProps = {
  recipes: WearRecipe[];
  resolveTexture: (ref: string) => string;
  textureMetadata?: Record<string, TextureMetadata>;
  /** Names the export writes into the pack's README and default file name. */
  paintName?: string;
  weaponName?: string;
  /** TF2 build the shipped data snapshot came from. */
  gameBuild?: string | null;
  /** When that snapshot was taken. */
  snapshotDate?: string | null;
  /** Definition and package sources for the Export tab, supplied by the app. */
  exportDefinitions?: ExportDefinitionsContext;
  editor?: WorkbenchEditor;
  /** Expands the Edit tab over the full application viewport. */
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  sourcePackage: SourcePackageState;
  /** Async Source package resolver used only for the non-destructive preview. */
  resolvePackageTexture?: (ref: string) => Promise<string>;
  /** Synchronous package membership check used for optional companion files. */
  hasPackageTexture?: (ref: string) => boolean;
  packageGeneration?: number;
  definitions: CustomDefinitionsState;
  loading: boolean;
  open: boolean;
  initialOverrides: WarpaintAssetOverrides;
  onChange: (overrides: WarpaintAssetOverrides) => void;
  /** Reset all returns the entire workbench to built-ins, including its package. */
  onResetAll?: () => void;
  /** Opens the clear-workspace confirmation when imported data exists. */
  onClearWorkspace?: () => void;
  /** Kept across the drawer's remounts on paint or weapon change, so an import does not switch tabs. */
  tab: WorkbenchTab;
  onTabChange: (tab: WorkbenchTab) => void;
  onResize: (height: number) => void;
  onClose: () => void;
};

export type WorkbenchEditor = VisualWarpaintEditorPanelProps & {
  mode: 'paint' | 'sticker';
  onModeChange: (mode: 'paint' | 'sticker') => void;
  sticker?: WorkbenchSticker;
  /** Per-team artwork for the active paint layer; absent when the layer cannot have any. */
  teamColors?: {
    enabled: boolean;
    /** The team the viewer shows; Replace acts on this side. */
    team: 'red' | 'blu';
    /** Authored texture reference each team draws, as the definition names it. */
    red?: string;
    blu?: string;
    onToggle: (enabled: boolean) => void;
    onSetTexture: (team: 'red' | 'blu', reference: string) => void;
  };
  /** Gates the Materials mode button; absent means nothing to override yet. */
  materials?: MaterialOverridesPanelProps;
  /** Gates the Parts/Transform sub-view switch for paint mode. */
  transform?: TextureTransformPanelProps;
  /** Optional graph view for the same paint operation. */
  graph?: OperationGraphEditorProps;
  paintSubView?: 'parts' | 'transform' | 'graph';
  onPaintSubViewChange?: (view: 'parts' | 'transform' | 'graph') => void;
  /** Weapon and wear whose operation is being edited, for a per-wear paint; absent otherwise. */
  perWearScope?: { weapon: string; wear: string };
  /** Per-layer marker, aligned with `selectors`, for a non-default transform range. */
  layerHasTransformEdits?: readonly boolean[];
  /** Per-layer marker, aligned with `selectors`, for transforms that are intentionally unavailable. */
  layerTransformLocked?: readonly boolean[];
  dirty: boolean;
  draft: EditorDraftState;
  /** Serialises the current definition edits as downloadable fragments. */
  onDownloadRecovery: () => void;
  canDownload: boolean;
  exporting: boolean;
  canUndo: boolean;
  canRedo: boolean;
  error?: string | null;
  selectors: readonly { id: string; label: string }[];
  activeSelectorId: string;
  onActiveSelectorChange: (id: string) => void;
  onUndo: () => void;
  onRedo: () => void;
  onReset: () => void;
  onDownloadPackage: (format: EditorDownloadFormat) => void;
};

export type WorkbenchSticker = StickerPlacementEditorProps & {
  targets: readonly {
    id: string;
    label: string;
    thumbnail?: string | null;
    canMoveEarlier: boolean;
    canMoveLater: boolean;
    /** Authored artwork reference, as the definition names it. */
    baseReference?: string;
    /** How many other stickers draw this same artwork file. */
    sharedWith?: number;
    /** Weighted artwork choices the seed picks between. */
    variantCount?: number;
  }[];
  /** Points the active sticker at different artwork. */
  onSetTargetTexture?: (baseReference: string) => void;
  /** Weighted artwork choices of the active sticker, in list order. */
  variants?: readonly WorkbenchStickerVariant[];
  /** Pins a variant for preview, or unpins it when it is already pinned. */
  onPreviewVariant?: (index: number) => void;
  onSetVariantWeight?: (index: number, weight: number) => void;
  onSetVariantBase?: (index: number, baseReference: string) => void;
  onEqualizeVariantWeights?: () => void;
  onAddVariant?: (baseReference: string) => void;
  onRemoveVariant?: (index: number) => void;
  activeTargetId: string;
  onActiveTargetChange: (id: string) => void;
  textureChoices: readonly { ref: string; label: string; thumbnail?: string | null }[];
  allTextureChoices: readonly { ref: string; label: string; thumbnail?: string | null }[];
  onAddTarget: (baseReference: string) => void;
  onRemoveTarget: () => void;
  onMoveTarget: (direction: -1 | 1) => void;
};

export type WorkbenchStickerVariant = {
  index: number;
  /** Authored artwork reference of this variant, when it has one. */
  baseReference?: string;
  thumbnail?: string | null;
  weight: number;
  /** True when the current seed drew this variant's artwork. */
  picked: boolean;
  /** True when this variant is pinned for preview in the sticker editor. */
  previewing: boolean;
};

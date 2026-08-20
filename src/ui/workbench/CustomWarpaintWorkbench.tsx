import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import type {
  DragEvent as ReactDragEvent,
  PointerEvent as ReactPointerEvent,
  ComponentProps,
} from 'react';
import { Tabs } from '@base-ui/react/tabs';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ChevronDown,
  Download,
  Files,
  Lock,
  Maximize2,
  Minimize2,
  PackageOpen,
  PencilRuler,
  Plus,
  RefreshCw,
  RotateCcw,
  Redo2,
  ScrollText,
  Trash2,
  Undo2,
  X,
} from 'lucide-react';
import type { TextureMetadata } from '../../data/types';
import type { CustomDefinitionsState } from '../../protodefs/types';
import type { SourcePackageState } from '../../source/contracts';
import type { WarpaintAssetOverrides, WarpaintAssetState, WearRecipe, WorkbenchTab } from '../../workbench/types';
import { collectSlots } from '../../workbench/assetSlots';
import type { AssetSlot } from '../../workbench/assetSlots';
import { revokeReleasedAssetUrls, revokeTextureUrl } from '../../workbench/assetUrls';
import { loadImage, mergeAlpha, readTexture } from '../../workbench/textureImport';
import type { ExportDefinitionsContext, ExportItem } from './ExportPanel';
import type { EditorDownloadFormat } from '../../editor/definitionExport';
import './CustomWarpaintWorkbench.css';

// Tabs.Panel mounts its children only after they become active. Keeping the
// panel imports lazy therefore makes the first Files visit independent from
// the editor/export/source-detail code, while preserving each tab's state once
// it has been visited.
const AssetFilesPanel = lazy(() =>
  import('./AssetFilesPanel').then(({ AssetFilesPanel: panel }) => ({ default: panel })),
);
const ExportPanel = lazy(() =>
  import('./ExportPanel').then(({ ExportPanel: panel }) => ({ default: panel })),
);
const SourcePackagePanel = lazy(() =>
  import('./SourcePackagePanel').then(({ SourcePackagePanel: panel }) => ({ default: panel })),
);
const DefinitionsPanel = lazy(() =>
  import('./DefinitionsPanel').then(({ DefinitionsPanel: panel }) => ({ default: panel })),
);
const VisualWarpaintEditorPanel = lazy(() =>
  import('./VisualWarpaintEditorPanel').then(({ VisualWarpaintEditorPanel: panel }) => ({ default: panel })),
);
const StickerPlacementEditor = lazy(() =>
  import('./StickerPlacementEditor').then(({ StickerPlacementEditor: panel }) => ({ default: panel })),
);
const TextureTransformPanel = lazy(() =>
  import('./TextureTransformPanel').then(({ TextureTransformPanel: panel }) => ({ default: panel })),
);
const MaterialOverridesPanel = lazy(() =>
  import('./MaterialOverridesPanel').then(({ MaterialOverridesPanel: panel }) => ({ default: panel })),
);

type VisualWarpaintEditorPanelProps = ComponentProps<typeof VisualWarpaintEditorPanel>;
type StickerPlacementEditorProps = ComponentProps<typeof StickerPlacementEditor>;
type TextureTransformPanelProps = ComponentProps<typeof TextureTransformPanel>;
type MaterialOverridesPanelProps = ComponentProps<typeof MaterialOverridesPanel>;

function WorkbenchPanelFallback() {
  return (
    <div className="custom-workbench-empty" aria-busy="true">
      Loading workbench panel...
    </div>
  );
}
const MIN_PANEL_HEIGHT = 190;
const RESET_CONFIRM_MS = 3000;

export function CustomWarpaintWorkbench({
  recipes,
  resolveTexture,
  textureMetadata,
  sourcePackage,
  resolvePackageTexture,
  hasPackageTexture,
  packageGeneration,
  definitions,
  loading,
  open,
  initialOverrides,
  onChange,
  onResetAll,
  onResize,
  onClose,
  tab,
  onTabChange,
  paintName,
  weaponName,
  gameBuild,
  snapshotDate,
  exportDefinitions,
  editor,
  expanded,
  onExpandedChange,
}: {
  recipes: WearRecipe[];
  resolveTexture: (ref: string) => string;
  textureMetadata?: Record<string, TextureMetadata>;
  /** Names the export writes into the pack's README and default file name. */
  paintName?: string;
  weaponName?: string;
  /** TF2 build the shipped data snapshot came from. */
  gameBuild?: string | null;
  /** When that snapshot was taken, which is the part people can act on. */
  snapshotDate?: string | null;
  /** Definition and package sources for the Export tab, supplied by the app. */
  exportDefinitions?: ExportDefinitionsContext;
  editor?: VisualWarpaintEditorPanelProps & {
    mode: 'paint' | 'sticker';
    onModeChange: (mode: 'paint' | 'sticker') => void;
    sticker?: StickerPlacementEditorProps & {
      targets: readonly {
        id: string;
        label: string;
        thumbnail?: string | null;
        canMoveEarlier: boolean;
        canMoveLater: boolean;
      }[];
      activeTargetId: string;
      onActiveTargetChange: (id: string) => void;
      textureChoices: readonly { ref: string; label: string; thumbnail?: string | null }[];
      allTextureChoices: readonly { ref: string; label: string; thumbnail?: string | null }[];
      onAddTarget: (baseReference: string) => void;
      onRemoveTarget: () => void;
      onMoveTarget: (direction: -1 | 1) => void;
    };
    /** Gates the Materials mode button; absent means nothing to override yet. */
    materials?: MaterialOverridesPanelProps;
    /** Gates the Parts/Transform sub-view switch for paint mode. */
    transform?: TextureTransformPanelProps;
    /** Ignored while `transform` is absent, so today's paint view never changes shape. */
    paintSubView?: 'parts' | 'transform';
    onPaintSubViewChange?: (view: 'parts' | 'transform') => void;
    /** Per-layer marker, aligned with `selectors`, for a non-default transform range. */
    layerHasTransformEdits?: readonly boolean[];
    /** Per-layer marker, aligned with `selectors`, for transforms that are intentionally unavailable. */
    layerTransformLocked?: readonly boolean[];
    dirty: boolean;
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
  /**
   * The drawer remounts whenever the selected paint or weapon changes, which is
   * how per-slot edits reset. The tab has to outlive that: importing a
   * definition selects the paint it just added, and bouncing the user off the
   * tab they are working in would look like the import did nothing.
   */
  tab: WorkbenchTab;
  onTabChange: (tab: WorkbenchTab) => void;
  onResize: (height: number) => void;
  onClose: () => void;
}) {
  const slots = useMemo(() => collectSlots(recipes), [recipes]);
  const [assets, setAssets] = useState<Record<string, WarpaintAssetState>>(
    initialOverrides.assets,
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [confirmReset, setConfirmReset] = useState(false);
  const [confirmRevert, setConfirmRevert] = useState(false);
  // Materials is a third top-level view alongside Paint/Stickers, but it does
  // not extend `mode` (paint vs. sticker stays the app's concern) so the
  // gating prop can be added without touching that existing contract.
  const [materialsActive, setMaterialsActive] = useState(false);
  const [editorDownloadFormat, setEditorDownloadFormat] = useState<EditorDownloadFormat>('zip');
  const [resizing, setResizing] = useState(false);
  const [dropping, setDropping] = useState(false);
  const [dropHint, setDropHint] = useState(false);
  const [stickerPickerOpen, setStickerPickerOpen] = useState(false);
  const [stickerSearch, setStickerSearch] = useState('');
  const [showAllStickerTextures, setShowAllStickerTextures] = useState(false);
  // dragenter/dragleave fire for every child the pointer crosses, so the cue
  // is driven by a depth count instead of the last event seen.
  const dragDepthRef = useRef(0);
  const revisionRef = useRef(initialOverrides.revision);
  // Async imports read the edit set after their awaits, so the latest map has
  // to be readable outside of React's render closure.
  const assetsRef = useRef(assets);
  const sectionRef = useRef<HTMLElement | null>(null);

  const replacedCount = Object.keys(assets).length;

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  useEffect(() => {
    if (!confirmReset) return;
    const timer = window.setTimeout(
      () => setConfirmReset(false),
      RESET_CONFIRM_MS,
    );
    return () => window.clearTimeout(timer);
  }, [confirmReset]);

  useEffect(() => {
    if (!confirmRevert) return;
    const timer = window.setTimeout(() => setConfirmRevert(false), RESET_CONFIRM_MS);
    const cancel = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setConfirmRevert(false);
    };
    window.addEventListener('keydown', cancel, true);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('keydown', cancel, true);
    };
  }, [confirmRevert]);

  useEffect(() => setConfirmRevert(false), [editor?.dirty, editor?.activeSelectorId]);

  // A paint or weapon change remounts this component (see the `key` prop at
  // the call site), but the materials source can still disappear on its own,
  // so guard against being left on a view with nothing left to show.
  useEffect(() => {
    if (!editor?.materials) setMaterialsActive(false);
  }, [editor?.materials]);

  useEffect(() => {
    if (!dropHint) return;
    const timer = window.setTimeout(() => setDropHint(false), 2400);
    return () => window.clearTimeout(timer);
  }, [dropHint]);

  const commit = (next: Record<string, WarpaintAssetState>) => {
    const previous = assetsRef.current;
    assetsRef.current = next;
    setAssets(next);
    revisionRef.current += 1;
    onChange({ revision: revisionRef.current, assets: next });
    revokeReleasedAssetUrls(previous, next);
  };

  const setSlotError = (ref: string, message: string) => {
    setErrors((current) => {
      const next = { ...current };
      if (message) next[ref] = message;
      else delete next[ref];
      return next;
    });
  };

  const rebuild = async (
    asset: WarpaintAssetState,
  ): Promise<WarpaintAssetState> => {
    if (!asset.color) return { ...asset, output: undefined, size: undefined };
    const output = asset.alpha
      ? await mergeAlpha(asset.color.dataUrl, asset.alpha.dataUrl)
      : asset.color.dataUrl;
    try {
      const image = await loadImage(output);
      return {
        ...asset,
        output,
        size: { width: image.naturalWidth, height: image.naturalHeight },
      };
    } catch (cause) {
      if (output !== asset.color.dataUrl) revokeTextureUrl(output);
      throw cause;
    }
  };

  const updateFile = async (
    slot: AssetSlot,
    file: File | undefined,
    alphaOnly: boolean,
  ) => {
    if (!file) return;
    setSlotError(slot.ref, '');
    setBusy((current) => ({ ...current, [slot.ref]: true }));
    let importedSource: string | undefined;
    let committed = false;
    try {
      const read = await readTexture(file, alphaOnly);
      importedSource = read.dataUrl;
      const current = assetsRef.current[slot.ref] ?? {};
      const nextAsset: WarpaintAssetState = alphaOnly
        ? {
            ...current,
            alpha: { dataUrl: read.dataUrl, fileName: read.fileName },
          }
        : {
            ...current,
            color: read,
            alpha: read.hasEmbeddedAlpha ? undefined : current.alpha,
          };
      commit({ ...assetsRef.current, [slot.ref]: await rebuild(nextAsset) });
      committed = true;
    } catch (cause) {
      if (!committed) revokeTextureUrl(importedSource);
      setSlotError(
        slot.ref,
        cause instanceof Error
          ? cause.message
          : 'The file could not be imported.',
      );
    } finally {
      setBusy((current) => {
        const next = { ...current };
        delete next[slot.ref];
        return next;
      });
    }
  };

  const removeAlpha = async (ref: string) => {
    const current = assetsRef.current[ref];
    if (!current?.alpha) return;
    const { alpha: _alpha, ...rest } = current;
    commit({ ...assetsRef.current, [ref]: await rebuild(rest) });
  };

  const resetSlot = (ref: string) => {
    const next = { ...assetsRef.current };
    delete next[ref];
    setSlotError(ref, '');
    commit(next);
  };

  const resetAll = () => {
    setErrors({});
    commit({});
    onResetAll?.();
  };

  // Drag the drawer's top edge to trade stage height for a taller asset grid.
  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const startY = event.clientY;
    const startHeight = sectionRef.current?.offsetHeight ?? 0;
    const maxHeight = Math.round(window.innerHeight * 0.75);
    event.currentTarget.setPointerCapture(event.pointerId);
    setResizing(true);
    const move = (moveEvent: PointerEvent) => {
      const height = startHeight + (startY - moveEvent.clientY);
      onResize(Math.min(maxHeight, Math.max(MIN_PANEL_HEIGHT, height)));
    };
    const stop = () => {
      setResizing(false);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
  };

  // Package files can be dropped anywhere on the workbench, not just onto the
  // bar: the drawer is short, and hunting for a small well is worse than
  // treating the whole surface as the target.
  // Extensions decide where a file goes, so dropping and picking behave the
  // same and nobody has to classify a file before handing it over.
  const routeImportedFiles = (files: File[]) => {
    const extensionOf = (file: File) => file.name.split('.').pop()?.toLowerCase() ?? '';
    const packageFiles = files.filter(
      (file) => extensionOf(file) === 'zip' || extensionOf(file) === 'vpk',
    );
    const definitionFiles = files.filter(
      (file) => extensionOf(file) === 'vpd' || extensionOf(file) === 'json',
    );
    if (packageFiles.length) sourcePackage.onImport(packageFiles);
    if (definitionFiles.length) definitions.onImport(definitionFiles);
    if (packageFiles.length) onTabChange('package');
    else if (definitionFiles.length) onTabChange('definitions');
    else setDropHint(true);
  };

  const dragging = (event: ReactDragEvent<HTMLElement>) =>
    [...event.dataTransfer.types].includes('Files');
  const dropHandlers = {
    onDragEnter: (event: ReactDragEvent<HTMLElement>) => {
      if (!dragging(event)) return;
      dragDepthRef.current += 1;
      setDropping(true);
    },
    onDragOver: (event: ReactDragEvent<HTMLElement>) => {
      if (!dragging(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    },
    onDragLeave: () => {
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (dragDepthRef.current === 0) setDropping(false);
    },
    onDrop: (event: ReactDragEvent<HTMLElement>) => {
      if (!dragging(event)) return;
      event.preventDefault();
      dragDepthRef.current = 0;
      setDropping(false);
      const files = [...event.dataTransfer.files];
      if (files.length) routeImportedFiles(files);
    },
  };

  // Tab badges surface the other tabs' state without switching to them: the
  // same replaced/total shape the Files toolbar already uses, a presence dot
  // plus format for the package, and a loaded/total count for definitions.
  const filesBadge =
    replacedCount > 0 ? `${replacedCount}/${slots.length}` : `${slots.length}`;
  const packageSummary =
    sourcePackage.status === 'mounted' ? sourcePackage.summary : undefined;
  const loadedDefinitionCount = definitions.kits.filter(
    (kit) => kit.loaded,
  ).length;

  useEffect(() => {
    if (!expanded) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      event.preventDefault();
      onExpandedChange(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [expanded, onExpandedChange]);

  // The export needs each replaced slot's kind, which only the slot list knows,
  // so the pairing happens here rather than in the panel.
  const exportItems = useMemo<ExportItem[]>(
    () =>
      slots.flatMap((slot) => {
        const asset = assets[slot.ref];
        const specular = slot.specularRef ? assets[slot.specularRef] : undefined;
        const items: ExportItem[] = [];
        if (asset?.output) items.push({ ref: slot.ref, kind: slot.kind, output: asset.output, size: asset.size });
        if (slot.specularRef && specular?.output) {
          items.push({ ref: slot.specularRef, kind: 'sticker-mask', output: specular.output, size: specular.size });
        }
        return items;
      }),
    [slots, assets],
  );

  return (
    <section
      className="custom-workbench"
      aria-label="War paint workbench"
      data-tab={tab}
      data-expanded={expanded ? '' : undefined}
      ref={sectionRef}
      data-dropping={dropping ? '' : undefined}
      {...dropHandlers}
    >
      <div
        className="custom-workbench-resizer"
        role="separator"
        aria-label="Resize war paint workbench"
        aria-orientation="horizontal"
        tabIndex={0}
        data-resizing={resizing ? '' : undefined}
        onPointerDown={startResize}
        onDoubleClick={() => onResize(0)}
        onKeyDown={(event) => {
          const current = sectionRef.current?.getBoundingClientRect().height ?? MIN_PANEL_HEIGHT;
          const step = event.shiftKey ? 48 : 16;
          if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
            event.preventDefault();
            onResize(Math.max(MIN_PANEL_HEIGHT, current + (event.key === 'ArrowUp' ? step : -step)));
          } else if (event.key === 'Home') {
            event.preventDefault();
            onResize(MIN_PANEL_HEIGHT);
          } else if (event.key === 'End') {
            event.preventDefault();
            onResize(Math.max(MIN_PANEL_HEIGHT, window.innerHeight * 0.7));
          }
        }}
      />
      <Tabs.Root
        className="custom-workbench-tabs-root"
        value={tab}
        onValueChange={(value) => onTabChange(value as WorkbenchTab)}
      >
        <header className="custom-workbench-header">
          <Tabs.List className="custom-workbench-tablist">
            <Tabs.Tab value="files" className="custom-workbench-tab">
              <Files size={13} />
              <span>Files</span>
              <span className="custom-workbench-tab-badge">{filesBadge}</span>
            </Tabs.Tab>
            <Tabs.Tab
              value="editor"
              className="custom-workbench-tab"
              data-dirty={editor?.dirty ? '' : undefined}
            >
              <PencilRuler size={13} />
              <span>Edit</span>
              {editor?.dirty && <span className="visual-warpaint-editor-dirty-dot" aria-label="Unsaved changes" />}
            </Tabs.Tab>
            <Tabs.Tab value="export" className="custom-workbench-tab">
              <Download size={13} />
              <span>Export</span>
              {replacedCount > 0 && (
                <span className="custom-workbench-tab-badge">{replacedCount}</span>
              )}
            </Tabs.Tab>
          </Tabs.List>

          {/* What has been brought in, rather than places to go. Files and
              Export are the two surfaces you work in; an archive and a set of
              definitions are state you need to see while working in them, which
              is exactly what a tab hides. These stay readable from every tab and
              open their own detail when there is something to say. */}
          <div className="workbench-sources">
            {/* Plain buttons rather than Tabs.Tab: base-ui's tab triggers must
                live inside a Tabs.List, and these belong beside it, not in it.
                The Root's value is controlled here anyway, so selecting one
                still shows its panel. */}
            <button
              type="button"
              className="workbench-source"
              data-loaded={sourcePackage.status === 'mounted' ? '' : undefined}
              data-selected={tab === 'package' ? '' : undefined}
              aria-pressed={tab === 'package'}
              onClick={() => onTabChange('package')}
              title={packageSummary ? `${packageSummary.name} (${packageSummary.format.toUpperCase()})` : 'No archive mounted'}
            >
              <PackageOpen size={12} />
              <span>
                {packageSummary
                  ? `${packageSummary.name} · ${packageSummary.usedCount || packageSummary.entryCount} files`
                  : 'No archive'}
              </span>
            </button>
            <button
              type="button"
              className="workbench-source"
              data-loaded={definitions.status === 'loaded' ? '' : undefined}
              data-selected={tab === 'definitions' ? '' : undefined}
              aria-pressed={tab === 'definitions'}
              onClick={() => onTabChange('definitions')}
              title={definitions.fileName ?? 'No definitions imported'}
            >
              <ScrollText size={12} />
              <span>
                {definitions.status === 'loaded'
                  ? `${loadedDefinitionCount || definitions.kits.length} paint${(loadedDefinitionCount || definitions.kits.length) === 1 ? '' : 's'}`
                  : 'No definitions'}
              </span>
            </button>
            <label className="workbench-source workbench-source-import" title="Import an archive or a war paint's definitions">
              <Plus size={12} />
              <span>Import</span>
              <input
                type="file"
                accept=".zip,.vpk,.vpd,.json"
                multiple
                aria-label="Import an archive or war paint definitions"
                onChange={(event) => {
                  const files = [...(event.target.files ?? [])];
                  event.target.value = '';
                  if (files.length) routeImportedFiles(files);
                }}
              />
            </label>
          </div>

          {tab === 'editor' && (
            <button
              type="button"
              className="custom-workbench-expand"
              title={expanded ? 'Exit full-screen editor (Esc)' : 'Open full-screen editor'}
              aria-label={expanded ? 'Exit full-screen editor' : 'Open full-screen editor'}
              aria-pressed={expanded}
              onClick={() => onExpandedChange(!expanded)}
            >
              {expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
            </button>
          )}

          <button
            type="button"
            className="custom-workbench-close"
            title="Close war paint workbench"
            aria-label="Close war paint workbench"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </header>

        {dropping && (
          <div className="source-package-dropzone">
            <PackageOpen size={18} />
            Drop a .zip/.vpk to mount a package, or a .vpd/.json to add definitions
          </div>
        )}
        {dropHint && (
          <div className="source-package-dropzone" data-variant="hint">
            <AlertTriangle size={18} />
            That isn&apos;t a package or definitions file (.zip, .vpk, .vpd, .json)
          </div>
        )}

        <Tabs.Panel value="files" className="custom-workbench-panel">
          <Suspense fallback={<WorkbenchPanelFallback />}>
            <AssetFilesPanel
              slots={slots}
              assets={assets}
              errors={errors}
              busy={busy}
              loading={loading}
              textureMetadata={textureMetadata}
              resolveTexture={resolveTexture}
              resolvePackageTexture={resolvePackageTexture}
              hasPackageTexture={hasPackageTexture}
              packageGeneration={packageGeneration ?? 0}
              sourceMounted={sourcePackage.status === 'mounted'}
              confirmReset={confirmReset}
              onConfirmReset={() => setConfirmReset(true)}
              onResetAll={resetAll}
              onExport={() => onTabChange('export')}
              onUpdateFile={(slot, file, alphaOnly) =>
                void updateFile(slot, file, alphaOnly)
              }
              onRemoveAlpha={(ref) => void removeAlpha(ref)}
              onResetSlot={resetSlot}
            />
          </Suspense>
        </Tabs.Panel>
        <Tabs.Panel value="editor" className="custom-workbench-panel custom-workbench-editor-panel">
          <Suspense fallback={<WorkbenchPanelFallback />}>
          {editor ? (
            <div className="custom-workbench-edit-body">
              <div className="custom-workbench-edit-context">
                {(editor.sticker || editor.materials) && (
                  <div className="custom-workbench-edit-mode" role="group" aria-label="Edit tool">
                    <button
                      type="button"
                      aria-pressed={!materialsActive && editor.mode === 'paint'}
                      onClick={() => { setMaterialsActive(false); editor.onModeChange('paint'); }}
                    >
                      Paint
                    </button>
                    {editor.sticker && (
                      <button
                        type="button"
                        aria-pressed={!materialsActive && editor.mode === 'sticker'}
                        onClick={() => { setMaterialsActive(false); editor.onModeChange('sticker'); }}
                      >
                        Stickers
                      </button>
                    )}
                    {editor.materials && (
                      <button
                        type="button"
                        aria-pressed={materialsActive}
                        onClick={() => setMaterialsActive(true)}
                      >
                        Materials
                      </button>
                    )}
                  </div>
                )}
                <div
                  className="custom-workbench-edit-list"
                  role="listbox"
                  aria-label={materialsActive ? 'Material overrides' : (editor.mode === 'paint' ? 'Paint layers' : 'Stickers')}
                >
                  {materialsActive ? (
                    <p className="custom-workbench-edit-materials-note">
                      Material overrides apply to the whole paint, so this list is not used in Materials.
                    </p>
                  ) : editor.mode === 'paint' ? editor.selectors.map((selector, index) => {
                    const active = editor.activeSelectorId === selector.id;
                    const swatchColor = editor.layerSwatchColors?.[index] ?? editor.layerColors?.[index];
                    const thumbnail = editor.layerThumbnails?.[index];
                    const count = editor.groupLayerIndex
                      ? Object.values(editor.groupLayerIndex).filter((layerIndex) => layerIndex === index).length
                      : 0;
                    const hasTransformEdits = editor.layerHasTransformEdits?.[index] ?? false;
                    const transformLocked = editor.layerTransformLocked?.[index] ?? false;
                    return (
                      <button
                        type="button"
                        key={selector.id}
                        className="custom-workbench-edit-layer-row"
                        role="option"
                        aria-selected={active}
                        onClick={() => editor.onActiveSelectorChange(selector.id)}
                      >
                        <span className="custom-workbench-edit-layer-thumb" aria-hidden="true">
                          {thumbnail ? <img src={thumbnail} alt="" draggable={false} /> : null}
                          <span
                            className="custom-workbench-edit-layer-swatch"
                            style={swatchColor ? { background: swatchColor } : undefined}
                          />
                        </span>
                        <span className="custom-workbench-edit-layer-label">{selector.label}</span>
                        {hasTransformEdits && (
                          <span className="custom-workbench-edit-layer-vary" title="This layer has non-default transform ranges">
                            <RefreshCw size={11} aria-hidden="true" />
                          </span>
                        )}
                        {transformLocked && (
                          <span className="custom-workbench-edit-layer-lock" title="This layer's transforms are locked">
                            <Lock size={11} aria-hidden="true" />
                          </span>
                        )}
                        <span className="custom-workbench-edit-layer-count">{count}</span>
                      </button>
                    );
                  }).concat(editor.baseLayer ? [(
                    <button
                      type="button"
                      key="weapon-base-texture"
                      className="custom-workbench-edit-layer-row"
                      role="option"
                      aria-selected={editor.baseLayer.active}
                      onClick={editor.baseLayer.onSelect}
                    >
                      <span className="custom-workbench-edit-layer-thumb" aria-hidden="true">
                        {editor.baseLayer.thumbnail ? <img src={editor.baseLayer.thumbnail} alt="" draggable={false} /> : null}
                        <span
                          className="custom-workbench-edit-layer-swatch"
                          style={(editor.layerSwatchColors?.[editor.selectors.length]
                            ?? editor.layerColors?.[editor.selectors.length])
                            ? { background: editor.layerSwatchColors?.[editor.selectors.length]
                              ?? editor.layerColors?.[editor.selectors.length] }
                            : undefined}
                        />
                      </span>
                      <span className="custom-workbench-edit-layer-label">{editor.baseLayer.label}</span>
                      {(editor.layerHasTransformEdits?.[editor.selectors.length] ?? false) && (
                        <span className="custom-workbench-edit-layer-vary" title="This layer has non-default transform ranges">
                          <RefreshCw size={11} aria-hidden="true" />
                        </span>
                      )}
                      {(editor.layerTransformLocked?.[editor.selectors.length] ?? false) && (
                        <span className="custom-workbench-edit-layer-lock" title="This layer's transforms are locked">
                          <Lock size={11} aria-hidden="true" />
                        </span>
                      )}
                    </button>
                  )] : []) : editor.sticker?.targets.map((target, index) => {
                    const active = editor.sticker?.activeTargetId === target.id;
                    return (
                      <button
                        type="button"
                        key={target.id}
                        className="custom-workbench-edit-sticker-row"
                        role="option"
                        aria-selected={active}
                        onClick={() => editor.sticker?.onActiveTargetChange(target.id)}
                      >
                        <span className="custom-workbench-edit-sticker-thumb" aria-hidden="true">
                          {target.thumbnail ? <img src={target.thumbnail} alt="" draggable={false} /> : null}
                        </span>
                        <span className="custom-workbench-edit-sticker-label">
                          {target.label || `Sticker ${index + 1}`}
                        </span>
                      </button>
                    );
                  })}
                </div>
                {!materialsActive && editor.mode === 'sticker' && editor.sticker && (() => {
                  const active = editor.sticker.targets.find((target) => target.id === editor.sticker?.activeTargetId);
                  return (
                    <div className="custom-workbench-edit-sticker-actions" role="toolbar" aria-label="Sticker actions">
                      <button
                        type="button"
                        title="Add sticker"
                        aria-label="Add sticker"
                        aria-expanded={stickerPickerOpen}
                        onClick={() => setStickerPickerOpen((open) => {
                          if (!open) setShowAllStickerTextures(false);
                          return !open;
                        })}
                      >
                        <Plus size={13} />
                      </button>
                      <button type="button" title="Remove sticker" aria-label="Remove sticker" onClick={editor.sticker.onRemoveTarget}>
                        <Trash2 size={13} />
                      </button>
                      <span />
                      <button type="button" title="Move sticker earlier" aria-label="Move sticker earlier" disabled={!active?.canMoveEarlier} onClick={() => editor.sticker?.onMoveTarget(-1)}>
                        <ArrowUp size={13} />
                      </button>
                      <button type="button" title="Move sticker later" aria-label="Move sticker later" disabled={!active?.canMoveLater} onClick={() => editor.sticker?.onMoveTarget(1)}>
                        <ArrowDown size={13} />
                      </button>
                    </div>
                  );
                })()}
                {!materialsActive && editor.mode === 'sticker' && editor.sticker && stickerPickerOpen && (
                  <div className="custom-workbench-sticker-picker" role="dialog" aria-label="Add sticker">
                    <div className="custom-workbench-sticker-picker-head">
                      <strong>Add sticker</strong>
                      <button type="button" aria-label="Close sticker picker" onClick={() => setStickerPickerOpen(false)}>
                        <X size={13} />
                      </button>
                    </div>
                    <input
                      type="search"
                      value={stickerSearch}
                      placeholder="Find sticker texture..."
                      aria-label="Find sticker texture"
                      autoFocus
                      onChange={(event) => setStickerSearch(event.target.value)}
                    />
                    <div className="custom-workbench-sticker-picker-scope" role="group" aria-label="Sticker texture source">
                      <button
                        type="button"
                        aria-pressed={!showAllStickerTextures}
                        onClick={() => setShowAllStickerTextures(false)}
                      >
                        Current paint
                      </button>
                      <button
                        type="button"
                        aria-pressed={showAllStickerTextures}
                        onClick={() => setShowAllStickerTextures(true)}
                      >
                        All available
                      </button>
                    </div>
                    <div className="custom-workbench-sticker-picker-list" role="listbox" aria-label="Sticker textures">
                      {(showAllStickerTextures ? editor.sticker.allTextureChoices : editor.sticker.textureChoices)
                        .filter((choice) => `${choice.label} ${choice.ref}`.toLowerCase().includes(stickerSearch.trim().toLowerCase()))
                        .map((choice) => (
                          <button
                            type="button"
                            key={choice.ref}
                            role="option"
                            aria-selected="false"
                            title={choice.ref}
                            onClick={() => {
                              editor.sticker?.onAddTarget(choice.ref);
                              setStickerPickerOpen(false);
                              setStickerSearch('');
                            }}
                          >
                            <span aria-hidden="true">
                              {choice.thumbnail ? <img src={choice.thumbnail} alt="" loading="lazy" draggable={false} /> : null}
                            </span>
                            <strong>{choice.label}</strong>
                            <small>{choice.ref}</small>
                          </button>
                        ))}
                    </div>
                  </div>
                )}
                <div className="custom-workbench-edit-footer">
                  <button
                    type="button"
                    className="custom-workbench-edit-icon-btn"
                    title="Undo"
                    aria-label="Undo"
                    disabled={!editor.canUndo}
                    onClick={editor.onUndo}
                  >
                    <Undo2 size={14} />
                  </button>
                  <button
                    type="button"
                    className="custom-workbench-edit-icon-btn"
                    title="Redo"
                    aria-label="Redo"
                    disabled={!editor.canRedo}
                    onClick={editor.onRedo}
                  >
                    <Redo2 size={14} />
                  </button>
                  <button
                    type="button"
                    className="custom-workbench-edit-revert"
                    disabled={!editor.dirty}
                    data-confirm={confirmRevert ? '' : undefined}
                    aria-label={confirmRevert ? 'Confirm reverting all edits' : 'Revert all edits'}
                    onClick={() => {
                      if (!confirmRevert) {
                        setConfirmRevert(true);
                        return;
                      }
                      setConfirmRevert(false);
                      editor.onReset();
                    }}
                  >
                    <RotateCcw size={13} /> {confirmRevert ? 'Revert all?' : 'Revert'}
                  </button>
                  <div className="custom-workbench-edit-download-group">
                    <button
                      type="button"
                      className="custom-workbench-edit-download"
                      disabled={!editor.canDownload}
                      aria-busy={editor.exporting}
                      onClick={() => editor.onDownloadPackage(editorDownloadFormat)}
                      title={`Download the edited ${editorDownloadFormat.toUpperCase()} output`}
                    >
                      <Download size={13} /> {editor.exporting
                        ? 'Preparing...'
                        : `Download ${editorDownloadFormat.toUpperCase()}`}
                    </button>
                    <details className="custom-workbench-edit-download-options">
                      <summary
                        className="custom-workbench-edit-download-toggle"
                        aria-label="Choose download format"
                        aria-disabled={!editor.canDownload || editor.exporting}
                        onClick={(event) => {
                          if (!editor.canDownload || editor.exporting) event.preventDefault();
                        }}
                      >
                        <ChevronDown size={13} aria-hidden="true" />
                      </summary>
                      <div className="custom-workbench-edit-download-menu" role="menu">
                        {([
                          ['zip', 'ZIP', 'Edited source package'],
                          ['json', 'JSON', 'Portable operation and definition'],
                          ['vpd', 'VPD', 'Complete proto_defs file'],
                        ] as const).map(([format, label, description]) => (
                          <button
                            key={format}
                            type="button"
                            role="menuitemradio"
                            aria-checked={editorDownloadFormat === format}
                            onClick={(event) => {
                              setEditorDownloadFormat(format);
                              event.currentTarget.closest('details')?.removeAttribute('open');
                            }}
                          >
                            <span>{label}</span>
                            <small>{description}</small>
                          </button>
                        ))}
                      </div>
                    </details>
                  </div>
                </div>
              </div>
              <div className="custom-workbench-edit-content">
                {editor.error && <div className="visual-warpaint-editor-error" role="alert">{editor.error}</div>}
                {materialsActive && editor.materials ? (
                  <MaterialOverridesPanel {...editor.materials} />
                ) : editor.mode === 'sticker' && editor.sticker
                  ? (() => {
                    const sticker = editor.sticker;
                    const active = sticker.targets.find((target) => target.id === sticker.activeTargetId);
                    return (
                      <StickerPlacementEditor
                        {...sticker}
                        label={active?.label ?? sticker.label}
                        focusKey={sticker.activeTargetId}
                      />
                    );
                  })()
                  : (() => {
                    // One switch instance, handed to whichever sub-view is
                    // showing, so both keep a single header row and the
                    // control never moves between them.
                    const subView = editor.paintSubView ?? 'parts';
                    const subViewSwitch = editor.transform ? (
                      <div className="custom-workbench-paint-subview" role="group" aria-label="Layer view">
                        <button
                          type="button"
                          aria-pressed={subView === 'parts'}
                          onClick={() => editor.onPaintSubViewChange?.('parts')}
                        >
                          Parts
                        </button>
                        <button
                          type="button"
                          aria-pressed={subView === 'transform'}
                          onClick={() => editor.onPaintSubViewChange?.('transform')}
                        >
                          Transform
                        </button>
                      </div>
                    ) : undefined;
                    return editor.transform && subView === 'transform'
                      ? <TextureTransformPanel {...editor.transform} headerSlot={subViewSwitch} />
                      : <VisualWarpaintEditorPanel {...editor} headerSlot={subViewSwitch} />;
                  })()}
              </div>
            </div>
          ) : (
            <VisualWarpaintEditorPanel
              enabled={false}
              unavailableReason="Choose a war paint to edit."
              sample={null}
              selectedGroupIds={[]}
              inspectOnClick={false}
              onInspectOnClickChange={() => undefined}
              onToggleGroup={() => undefined}
              onClearSelection={() => undefined}
            />
          )}
          </Suspense>
        </Tabs.Panel>
        {/* Not Tabs.Panel: base-ui only activates a panel that has a matching
            trigger inside Tabs.List, and these are reached from the source chips
            in the header instead. Rendered conditionally on the same tab value,
            so the drawer still shows exactly one surface at a time. */}
        {tab === 'package' && (
          <div className="custom-workbench-panel" role="region" aria-label="Mounted archive">
            <Suspense fallback={<WorkbenchPanelFallback />}>
              <SourcePackagePanel state={sourcePackage} />
            </Suspense>
          </div>
        )}

        {tab === 'definitions' && (
          <div className="custom-workbench-panel" role="region" aria-label="Imported definitions">
            <Suspense fallback={<WorkbenchPanelFallback />}>
              <DefinitionsPanel state={definitions} />
            </Suspense>
          </div>
        )}

        <Tabs.Panel value="export" className="custom-workbench-panel">
          <Suspense fallback={<WorkbenchPanelFallback />}>
            <ExportPanel
              items={exportItems}
              loading={loading}
              textureMetadata={textureMetadata}
              paintName={paintName}
              weaponName={weaponName}
              gameBuild={gameBuild}
              snapshotDate={snapshotDate}
              definitions={exportDefinitions}
              onGoToTab={onTabChange}
            />
          </Suspense>
        </Tabs.Panel>
      </Tabs.Root>
    </section>
  );
}

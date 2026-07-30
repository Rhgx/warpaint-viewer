import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  DragEvent as ReactDragEvent,
  PointerEvent as ReactPointerEvent,
} from 'react';
import { Tabs } from '@base-ui/react/tabs';
import {
  AlertTriangle,
  Download,
  Files,
  PackageOpen,
  Plus,
  ScrollText,
  X,
} from 'lucide-react';
import type { TextureMetadata } from '../../data/types';
import type { CustomDefinitionsState } from '../../protodefs/types';
import { SourcePackagePanel } from './SourcePackagePanel';
import type { SourcePackageState } from '../../source/contracts';
import type { WarpaintAssetOverrides, WarpaintAssetState, WearRecipe, WorkbenchTab } from '../../workbench/types';
import { collectSlots } from '../../workbench/assetSlots';
import type { AssetSlot } from '../../workbench/assetSlots';
import { loadImage, mergeAlpha, readTexture } from '../../workbench/textureImport';
import { DefinitionsPanel } from './DefinitionsPanel';
import { ExportPanel } from './ExportPanel';
import type { ExportDefinitionsContext, ExportItem } from './ExportPanel';
import { AssetFilesPanel } from './AssetFilesPanel';
import './CustomWarpaintWorkbench.css';
import './SourcePackagePanel.css';
import './DefinitionsPanel.css';
const MIN_PANEL_HEIGHT = 190;
const RESET_CONFIRM_MS = 3000;

export function CustomWarpaintWorkbench({
  recipes,
  resolveTexture,
  textureMetadata,
  sourcePackage,
  resolvePackageTexture,
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
  sourcePackage: SourcePackageState;
  /** Async Source package resolver used only for the non-destructive preview. */
  resolvePackageTexture?: (ref: string) => Promise<string>;
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
  const [resizing, setResizing] = useState(false);
  const [dropping, setDropping] = useState(false);
  const [dropHint, setDropHint] = useState(false);
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
    if (!dropHint) return;
    const timer = window.setTimeout(() => setDropHint(false), 2400);
    return () => window.clearTimeout(timer);
  }, [dropHint]);

  const commit = (next: Record<string, WarpaintAssetState>) => {
    assetsRef.current = next;
    setAssets(next);
    revisionRef.current += 1;
    onChange({ revision: revisionRef.current, assets: next });
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
    const image = await loadImage(output);
    return {
      ...asset,
      output,
      size: { width: image.naturalWidth, height: image.naturalHeight },
    };
  };

  const updateFile = async (
    slot: AssetSlot,
    file: File | undefined,
    alphaOnly: boolean,
  ) => {
    if (!file) return;
    setSlotError(slot.ref, '');
    setBusy((current) => ({ ...current, [slot.ref]: true }));
    try {
      const read = await readTexture(file, alphaOnly);
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
    } catch (cause) {
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

  // The export needs each replaced slot's kind, which only the slot list knows,
  // so the pairing happens here rather than in the panel.
  const exportItems = useMemo<ExportItem[]>(
    () =>
      slots.flatMap((slot) => {
        const asset = assets[slot.ref];
        return asset?.output
          ? [{ ref: slot.ref, kind: slot.kind, output: asset.output, size: asset.size }]
          : [];
      }),
    [slots, assets],
  );

  return (
    <section
      className="custom-workbench"
      aria-label="Custom warpaint files"
      ref={sectionRef}
      data-dropping={dropping ? '' : undefined}
      {...dropHandlers}
    >
      <div
        className="custom-workbench-resizer"
        role="separator"
        aria-label="Resize custom files panel"
        aria-orientation="horizontal"
        data-resizing={resizing ? '' : undefined}
        onPointerDown={startResize}
        onDoubleClick={() => onResize(0)}
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

          <button
            type="button"
            className="custom-workbench-close"
            title="Close custom warpaint files"
            aria-label="Close custom warpaint files"
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

        <Tabs.Panel value="files">
          <AssetFilesPanel
            slots={slots}
            assets={assets}
            errors={errors}
            busy={busy}
            loading={loading}
            textureMetadata={textureMetadata}
            resolveTexture={resolveTexture}
            resolvePackageTexture={resolvePackageTexture}
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
        </Tabs.Panel>
        {/* Not Tabs.Panel: base-ui only activates a panel that has a matching
            trigger inside Tabs.List, and these are reached from the source chips
            in the header instead. Rendered conditionally on the same tab value,
            so the drawer still shows exactly one surface at a time. */}
        {tab === 'package' && (
          <div className="custom-workbench-panel" role="region" aria-label="Mounted archive">
            <SourcePackagePanel state={sourcePackage} />
          </div>
        )}

        {tab === 'definitions' && (
          <div className="custom-workbench-panel" role="region" aria-label="Imported definitions">
            <DefinitionsPanel state={definitions} />
          </div>
        )}

        <Tabs.Panel value="export" className="custom-workbench-panel">
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
        </Tabs.Panel>
      </Tabs.Root>
    </section>
  );
}

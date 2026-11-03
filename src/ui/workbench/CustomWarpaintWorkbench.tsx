import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent as ReactDragEvent, PointerEvent as ReactPointerEvent } from 'react';
import { Tabs } from '@base-ui/react/tabs';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Download,
  ImageUp,
  LoaderCircle,
  PackageOpen,
  Redo2,
  RotateCcw,
  Undo2,
  Users,
} from 'lucide-react';

import { collectSlots } from '../../workbench/assetSlots';
import { fileExtension } from '../../workbench/textureImport';
import type { WarpaintAssetState, WorkbenchTab } from '../../workbench/types';
import type { ExportItem } from '../../workbench/exportTypes';
import type { EditorDownloadFormat } from '../../editor/export/definitionExport';
import { useArmedConfirm } from '../../hooks/useArmedConfirm';
import { AssetFilesPanel } from './AssetFilesPanel';
import { EditorDraftBanner } from '../editor/EditorDraftBanner';
import { EditorLayerList } from './EditorLayerList';
import { StickerEditToolbar } from './StickerEditToolbar';
import { StickerTexturePicker } from './StickerTexturePicker';
import { StickerVariantList } from './StickerVariantList';
import { WorkbenchHeader } from './WorkbenchHeader';
import { useWorkbenchAssetEdits } from './useWorkbenchAssetEdits';
import { startWorkbenchResize } from './workbenchResize';
import {
  draftStatusLabel,
  MIN_PANEL_HEIGHT,
  referenceLabel,
  RESET_CONFIRM_MS,
  TEXTURE_FILE_ACCEPT,
} from './workbenchLabels';
import type { CustomWarpaintWorkbenchProps } from './workbenchTypes';
import './CustomWarpaintWorkbench.css';

// Secondary panels load lazily so the Files controls show first. Tabs.Panel
// mounts children only when active, so each keeps its state once visited.
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
  import('../editor/VisualWarpaintEditorPanel').then(({ VisualWarpaintEditorPanel: panel }) => ({ default: panel })),
);
const StickerPlacementEditor = lazy(() =>
  import('../editor/StickerPlacementEditor').then(({ StickerPlacementEditor: panel }) => ({ default: panel })),
);
const TextureTransformPanel = lazy(() =>
  import('../editor/TextureTransformPanel').then(({ TextureTransformPanel: panel }) => ({ default: panel })),
);
const MaterialOverridesPanel = lazy(() =>
  import('../editor/MaterialOverridesPanel').then(({ MaterialOverridesPanel: panel }) => ({ default: panel })),
);
const OperationGraphEditor = lazy(() =>
  import('../editor/OperationGraphEditor').then(({ OperationGraphEditor: panel }) => ({ default: panel })),
);

function WorkbenchPanelFallback() {
  return (
    <div className="custom-workbench-empty" aria-busy="true">
      Loading workbench panel...
    </div>
  );
}

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
  onClearWorkspace,
  onResize,
  resizing,
  onResizingChange,
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
}: CustomWarpaintWorkbenchProps) {
  const slots = useMemo(() => collectSlots(recipes), [recipes]);
  const [assets, setAssets] = useState<Record<string, WarpaintAssetState>>(
    initialOverrides.assets,
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [confirmReset, armReset] = useArmedConfirm(RESET_CONFIRM_MS);
  const [confirmRevert, armRevert, disarmRevert] = useArmedConfirm(RESET_CONFIRM_MS);
  // Materials is not a `mode` value: the app owns `mode`, which only holds paint or sticker.
  const [materialsActive, setMaterialsActive] = useState(false);
  const [editorDownloadFormat, setEditorDownloadFormat] = useState<EditorDownloadFormat>('zip');
  const [dropping, setDropping] = useState(false);
  const [dropHint, setDropHint] = useState(false);
  const [stickerPickerOpen, setStickerPickerOpen] = useState(false);
  // One picker serves Add sticker and Add variant; this records the chosen action.
  const [stickerPickerPurpose, setStickerPickerPurpose] = useState<'sticker' | 'variant'>('sticker');
  const [stickerSearch, setStickerSearch] = useState('');
  const [showAllStickerTextures, setShowAllStickerTextures] = useState(false);
  // dragenter/dragleave fire for every child crossed, so the cue is a depth count.
  const dragDepthRef = useRef(0);
  const revisionRef = useRef(initialOverrides.revision);
  // Async imports read the edit set after awaits, so it must be readable outside render.
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
    if (!confirmRevert) return;
    const cancel = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      disarmRevert();
    };
    window.addEventListener('keydown', cancel, true);
    return () => window.removeEventListener('keydown', cancel, true);
  }, [confirmRevert, disarmRevert]);

  useEffect(() => disarmRevert(), [editor?.dirty, editor?.activeSelectorId, disarmRevert]);

  // The materials source can vanish without a remount, so leave the Materials view then.
  if (materialsActive && !editor?.materials) setMaterialsActive(false);

  useEffect(() => {
    if (!dropHint) return;
    const timer = window.setTimeout(() => setDropHint(false), 2400);
    return () => window.clearTimeout(timer);
  }, [dropHint]);

  const {
    editImportError,
    updateFile,
    removeAlpha,
    resetSlot,
    resetAll,
    replaceStickerImage,
    replaceVariantImage,
    replaceTeamTexture,
  } = useWorkbenchAssetEdits({
    slots,
    textureMetadata,
    editor,
    onChange,
    onResetAll,
    setAssets,
    setErrors,
    setBusy,
    assetsRef,
    revisionRef,
  });
  const toggleStickerPicker = (purpose: 'sticker' | 'variant') => {
    if (stickerPickerOpen && stickerPickerPurpose === purpose) {
      setStickerPickerOpen(false);
      return;
    }
    setStickerPickerPurpose(purpose);
    setShowAllStickerTextures(false);
    setStickerPickerOpen(true);
  };

  const stickerFileRef = useRef<HTMLInputElement | null>(null);
  // One file input serves every variant row; the row that asked for it is remembered here.
  const variantFileRef = useRef<HTMLInputElement | null>(null);
  const variantReplaceIndexRef = useRef<number | null>(null);

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) =>
    startWorkbenchResize(event, { sectionRef, onResize, setResizing: onResizingChange });

  // Package files can be dropped anywhere on the workbench, not just the short bar.
  // Extensions decide the destination, so dropping and picking behave the same.
  const routeImportedFiles = (files: File[]) => {
    const packageFiles = files.filter(
      (file) => fileExtension(file) === 'zip' || fileExtension(file) === 'vpk',
    );
    const definitionFiles = files.filter(
      (file) => fileExtension(file) === 'vpd' || fileExtension(file) === 'json',
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

  // Only the slot list knows each slot's kind, so export items are paired here.
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
        <WorkbenchHeader
          tab={tab}
          onTabChange={onTabChange}
          slotCount={slots.length}
          replacedCount={replacedCount}
          editor={editor}
          sourcePackage={sourcePackage}
          definitions={definitions}
          onRouteFiles={routeImportedFiles}
          onClearWorkspace={onClearWorkspace}
          expanded={expanded}
          onExpandedChange={onExpandedChange}
          onClose={onClose}
        />

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
            onConfirmReset={armReset}
            onResetAll={resetAll}
            onExport={() => onTabChange('export')}
            onUpdateFile={(ref, file, alphaOnly) =>
              void updateFile(ref, file, alphaOnly)
            }
            onRemoveAlpha={(ref) => void removeAlpha(ref)}
            onResetSlot={resetSlot}
          />
        </Tabs.Panel>
        <Tabs.Panel value="editor" className="custom-workbench-panel custom-workbench-editor-panel">
          <Suspense fallback={<WorkbenchPanelFallback />}>
          {editor ? (
            <>
            <EditorDraftBanner draft={editor.draft} onDownloadRecovery={editor.onDownloadRecovery} />
            <div className="custom-workbench-edit-body" inert={editor.draft.recovery ? true : undefined}>
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
                <EditorLayerList editor={editor} materialsActive={materialsActive} />
                {!materialsActive && editor.mode === 'sticker' && editor.sticker && (
                  <StickerEditToolbar
                    sticker={editor.sticker}
                    stickerFileRef={stickerFileRef}
                    pickerOpen={stickerPickerOpen}
                    pickerPurpose={stickerPickerPurpose}
                    onTogglePicker={toggleStickerPicker}
                    onReplaceImage={replaceStickerImage}
                  />
                )}
                {!materialsActive && editor.mode === 'sticker' && editor.sticker && stickerPickerOpen && (
                  <StickerTexturePicker
                    sticker={editor.sticker}
                    purpose={stickerPickerPurpose}
                    search={stickerSearch}
                    showAll={showAllStickerTextures}
                    onOpenChange={setStickerPickerOpen}
                    onSearchChange={setStickerSearch}
                    onShowAllChange={setShowAllStickerTextures}
                  />
                )}
                <div className="custom-workbench-edit-footer">
                  <div className="custom-workbench-history-actions">
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
                  </div>
                  <span
                    className="custom-workbench-draft-status"
                    data-state={editor.draft.status}
                    title={editor.draft.status === 'saved' ? 'Saved locally' : undefined}
                    role="status"
                    aria-live="polite"
                  >
                    {draftStatusLabel(editor.draft.status) && (<>
                      {editor.draft.status === 'pending' || editor.draft.status === 'saving'
                        ? <LoaderCircle size={12} aria-hidden="true" />
                        : editor.draft.status === 'saved'
                          ? <Check size={12} aria-hidden="true" />
                          : <AlertTriangle size={12} aria-hidden="true" />}
                      {draftStatusLabel(editor.draft.status)}
                    </>)}
                  </span>
                  <button
                    type="button"
                    className="custom-workbench-edit-revert"
                    disabled={!editor.dirty}
                    data-confirm={confirmRevert ? '' : undefined}
                    aria-label={confirmRevert ? 'Confirm reverting all edits' : 'Revert all edits'}
                    onClick={() => {
                      if (!confirmRevert) {
                        armRevert();
                        return;
                      }
                      disarmRevert();
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
                {editImportError && <div className="visual-warpaint-editor-error" role="alert">{editImportError}</div>}
                {materialsActive && editor.materials ? (
                  <MaterialOverridesPanel {...editor.materials} />
                ) : editor.mode === 'sticker' && editor.sticker
                  ? (() => {
                    const sticker = editor.sticker;
                    const active = sticker.targets.find((target) => target.id === sticker.activeTargetId);
                    const variants = sticker.variants ?? [];
                    const variantsPanel = variants.length > 0 ? (
                      <StickerVariantList
                        sticker={sticker}
                        variants={variants}
                        variantFileRef={variantFileRef}
                        variantReplaceIndexRef={variantReplaceIndexRef}
                        pickerOpen={stickerPickerOpen}
                        pickerPurpose={stickerPickerPurpose}
                        onTogglePicker={toggleStickerPicker}
                        onReplaceVariantImage={replaceVariantImage}
                      />
                    ) : undefined;
                    return (
                      <StickerPlacementEditor
                        {...sticker}
                        label={active?.label ?? sticker.label}
                        focusKey={sticker.activeTargetId}
                        variantsPanel={variantsPanel}
                        variantCount={variants.length}
                      />
                    );
                  })()
                  : (() => {
                    // One switch instance serves both sub-views, so the control never moves.
                    const subView = editor.paintSubView ?? 'parts';
                    const subViewSwitch = (editor.transform || editor.graph) ? (
                      <div className="custom-workbench-paint-subview" role="group" aria-label="Layer view">
                        <button
                          type="button"
                          aria-pressed={subView === 'parts'}
                          onClick={() => editor.onPaintSubViewChange?.('parts')}
                        >
                          Parts
                        </button>
                        {editor.transform && (
                          <button
                            type="button"
                            aria-pressed={subView === 'transform'}
                            onClick={() => editor.onPaintSubViewChange?.('transform')}
                          >
                            Transform
                          </button>
                        )}
                        {editor.graph && (
                          <button
                            type="button"
                            aria-pressed={subView === 'graph'}
                            onClick={() => editor.onPaintSubViewChange?.('graph')}
                          >
                            Graph
                          </button>
                        )}
                      </div>
                    ) : undefined;
                    const team = editor.teamColors;
                    const teamName = team?.team === 'blu' ? 'BLU' : 'RED';
                    const teamActions = team && (<>
                      <button
                        type="button"
                        className="custom-workbench-team-btn"
                        aria-pressed={team.enabled}
                        title={team.enabled
                          ? 'Use one texture for both teams again (keeps the RED one)'
                          : 'Give RED and BLU their own texture on this layer. Both start as the current one.'}
                        onClick={() => team.onToggle(!team.enabled)}
                      >
                        <Users size={13} aria-hidden="true" />
                        Team colors
                      </button>
                      {team.enabled && team[team.team] && (
                        <label
                          className="custom-workbench-team-btn"
                          data-team={team.team}
                          title={`Replace the ${teamName} texture (${referenceLabel(team[team.team] ?? '')}). Switch the Team toggle to edit the other side.`}
                        >
                          <ImageUp size={13} aria-hidden="true" />
                          Replace <strong>{teamName}</strong>
                          <input
                            type="file"
                            accept={TEXTURE_FILE_ACCEPT}
                            hidden
                            aria-label={`Replace the ${teamName} texture`}
                            onChange={(event) => {
                              const file = event.currentTarget.files?.[0];
                              event.currentTarget.value = '';
                              if (file) replaceTeamTexture(team.team, file);
                            }}
                          />
                        </label>
                      )}
                    </>);
                    // A per-wear scope with no parts still shows the switch; a top-level paint hides it.
                    const partsHeaderSlot = editor.enabled || editor.perWearScope ? subViewSwitch : undefined;
                    return editor.graph && subView === 'graph'
                      ? (
                        <div className="custom-workbench-graph-view">
                          <div className="custom-workbench-graph-switch">{subViewSwitch}</div>
                          <Suspense fallback={<WorkbenchPanelFallback />}><OperationGraphEditor {...editor.graph} /></Suspense>
                        </div>
                      )
                      : editor.transform && subView === 'transform'
                      ? <TextureTransformPanel {...editor.transform} headerSlot={subViewSwitch} headerActions={teamActions} />
                      : <VisualWarpaintEditorPanel {...editor} headerSlot={partsHeaderSlot} headerActions={teamActions} />;
                  })()}
              </div>
            </div>
            </>
          ) : (
            <VisualWarpaintEditorPanel
              enabled={false}
              unavailableReason="Choose a war paint to edit."
              selectedGroupIds={[]}
              onToggleGroup={() => undefined}
              onClearSelection={() => undefined}
            />
          )}
          </Suspense>
        </Tabs.Panel>
        {/* Not Tabs.Panel: base-ui needs a trigger in Tabs.List, and these open from header chips. */}
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

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

import { isLayoutFileName } from '../../showcase/boardFileName';
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
import { EDITOR_BUTTON, EDITOR_HEAD } from '../editor/editorStyles';
import { Button, FileButton } from '../primitives/Button';
import { cn } from '../primitives/cn';
import { BlockNotice } from '../primitives/Notice';
import { ToggleGroup } from '../primitives/ToggleGroup';
import type { CustomWarpaintWorkbenchProps } from './workbenchTypes';

const DROP_OVERLAY = 'pointer-events-none absolute inset-0 z-2 flex items-center justify-center gap-2 text-center text-12 font-[650] outline-2 -outline-offset-2 outline-dashed';
// Each tab panel fills the height the header leaves.
const PANEL = 'flex min-h-0 flex-1 flex-col outline-none';

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
    <div className="flex h-full items-center justify-center gap-2 text-11 text-dim" aria-busy="true">
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
  const [resizing, setResizing] = useState(false);
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
  const addStickerRef = useRef<HTMLButtonElement | null>(null);
  const variantActionsRef = useRef<HTMLDivElement | null>(null);
  // One file input serves every variant row; the row that asked for it is remembered here.
  const variantFileRef = useRef<HTMLInputElement | null>(null);
  const variantReplaceIndexRef = useRef<number | null>(null);

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) =>
    startWorkbenchResize(event, { sectionRef, onResize, setResizing });

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
      dragDepthRef.current = 0;
      setDropping(false);
      const files = [...event.dataTransfer.files];
      // A shared board goes to the board, which listens on the window, wherever on the page it was dropped.
      if (files.length === 1 && isLayoutFileName(files[0].name)) return;
      event.preventDefault();
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
      // Hides below its slot until open, and is not moved at all when expanded. The narrow-width rules inside query this drawer, not the viewport.
      className="relative @container flex h-full min-h-0 flex-col border-t border-strong bg-panel text-text opacity-0 [transition:opacity_150ms_ease,translate_210ms_ease] not-data-expanded:translate-y-3 motion-reduce:transition-none data-expanded:border-t-0 data-open:opacity-100 not-data-expanded:data-open:translate-y-0 [&_[data-slot=select-trigger]]:min-h-control [&_[data-slot=select-trigger]]:text-11"
      aria-label="War paint workbench"
      data-slot="workbench"
      data-tab={tab}
      data-open={open ? '' : undefined}
      data-expanded={expanded ? '' : undefined}
      ref={sectionRef}
      {...dropHandlers}
    >
      <div
        // The bar lies over the drawer's top edge. The slot clips everything above that edge, so it starts there.
        className={cn('absolute inset-x-0 -top-0.75 z-1 h-1.75 cursor-ns-resize touch-none outline-none after:absolute after:inset-x-0 after:top-0.75 after:h-0.5 after:bg-accent after:opacity-0 after:transition-opacity after:duration-140 after:ease-[ease] hover:after:opacity-100 focus-visible:after:opacity-100 motion-reduce:after:transition-none data-resizing:after:opacity-100', expanded && 'hidden')}
        data-slot="workbench-resizer"
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
        className="flex min-h-0 flex-1 flex-col"
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

        {/* The whole workbench accepts package files, so there is no small well to hunt for. */}
        {dropping && (
          <div className={cn(DROP_OVERLAY, 'bg-[color-mix(in_srgb,var(--panel)_86%,var(--accent))] text-text outline-accent')} data-slot="workbench-dropzone">
            <PackageOpen size={18} />
            Drop a .zip/.vpk to mount a package, or a .vpd/.json to add definitions
          </div>
        )}
        {dropHint && (
          <div className={cn(DROP_OVERLAY, 'bg-[color-mix(in_srgb,var(--panel)_84%,var(--fail))] text-fail-text outline-fail-text')} data-slot="workbench-dropzone" data-variant="hint">
            <AlertTriangle size={18} />
            That isn&apos;t a package or definitions file (.zip, .vpk, .vpd, .json)
          </div>
        )}

        <Tabs.Panel value="files" className={PANEL}>
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
        <Tabs.Panel value="editor" className={cn(PANEL, '@container overflow-hidden')} data-slot="workbench-editor-panel">
          <Suspense fallback={<WorkbenchPanelFallback />}>
          {editor ? (
            <>
            <EditorDraftBanner draft={editor.draft} onDownloadRecovery={editor.onDownloadRecovery} />
            <div className="relative grid min-h-0 flex-1 grid-cols-[260px_minmax(0,1fr)] @max-[900px]:grid-cols-none @max-[900px]:grid-rows-[auto_minmax(0,1fr)]" inert={editor.draft.recovery ? true : undefined}>
              {/* A fixed column beside the content. Narrow, it becomes tools on top and the list below at full width, and when too narrow for one line the footer takes its own. */}
              <div className="flex min-h-0 flex-col overflow-hidden border-r border-border bg-panel pt-1.5 pb-2 @max-[900px]:grid @max-[900px]:grid-cols-[auto_minmax(0,1fr)_auto] @max-[900px]:items-center @max-[900px]:border-r-0 @max-[900px]:border-b @max-[900px]:p-0 @max-[900px]:[grid-template-areas:'mode_tools_footer'_'list_list_list'] @max-[620px]:grid-cols-[auto_minmax(0,1fr)] @max-[620px]:[grid-template-areas:'mode_tools'_'footer_footer'_'list_list']" data-slot="editor-context">
                {(editor.sticker || editor.materials) && (
                  <div className="mx-2.5 mb-2 flex flex-none [grid-area:mode] @max-[900px]:my-1.5 @max-[900px]:mr-0 @max-[900px]:ml-2">
                    <ToggleGroup<'paint' | 'sticker' | 'materials'>
                      size="tool"
                      label="Edit tool"
                      value={materialsActive ? 'materials' : editor.mode}
                      options={[
                        { value: 'paint', label: 'Paint' },
                        ...(editor.sticker ? [{ value: 'sticker' as const, label: 'Stickers' }] : []),
                        ...(editor.materials ? [{ value: 'materials' as const, label: 'Materials' }] : []),
                      ]}
                      onChange={(value) => {
                        setMaterialsActive(value === 'materials');
                        if (value !== 'materials') editor.onModeChange(value);
                      }}
                    />
                  </div>
                )}
                <EditorLayerList editor={editor} materialsActive={materialsActive} />
                {!materialsActive && editor.mode === 'sticker' && editor.sticker && (
                  <StickerEditToolbar
                    sticker={editor.sticker}
                    stickerFileRef={stickerFileRef}
                    addButtonRef={addStickerRef}
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
                    anchorRef={stickerPickerPurpose === 'variant' ? variantActionsRef : addStickerRef}
                    search={stickerSearch}
                    showAll={showAllStickerTextures}
                    onOpenChange={setStickerPickerOpen}
                    onSearchChange={setStickerSearch}
                    onShowAllChange={setShowAllStickerTextures}
                  />
                )}
                <div className="mt-2 flex flex-none flex-wrap items-center gap-1 border-t border-border px-2.5 pt-2 [grid-area:footer] @max-[900px]:m-0 @max-[900px]:flex-nowrap @max-[900px]:border-t-0 @max-[900px]:px-2 @max-[900px]:py-1.5 @max-[620px]:pt-0">
                  <div className="inline-flex flex-none gap-1">
                    <Button
                      size="icon"
                      title="Undo"
                      aria-label="Undo"
                      disabled={!editor.canUndo}
                      onClick={editor.onUndo}
                    >
                      <Undo2 size={14} />
                    </Button>
                    <Button
                      size="icon"
                      title="Redo"
                      aria-label="Redo"
                      disabled={!editor.canRedo}
                      onClick={editor.onRedo}
                    >
                      <Redo2 size={14} />
                    </Button>
                  </div>
                  <span
                    // Armed, Revert needs this room to stay on the row. A narrow row never wraps, and hiding this there would pull the armed button out from under the pointer.
                    className="inline-flex w-21.5 min-w-21.5 items-center gap-1 overflow-hidden text-10 text-ellipsis whitespace-nowrap text-dim data-[state=error]:text-fail data-[state=saved]:text-pass @min-[900px]:data-armed:hidden"
                    data-slot="draft-status"
                    data-state={editor.draft.status}
                    data-armed={confirmRevert ? '' : undefined}
                    title={editor.draft.status === 'saved' ? 'Saved locally' : undefined}
                    role="status"
                    aria-live="polite"
                  >
                    {draftStatusLabel(editor.draft.status) && (<>
                      {editor.draft.status === 'pending' || editor.draft.status === 'saving'
                        ? <LoaderCircle className="flex-none animate-spin motion-reduce:animate-none" size={12} aria-hidden="true" />
                        : editor.draft.status === 'saved'
                          ? <Check className="flex-none" size={12} aria-hidden="true" />
                          : <AlertTriangle className="flex-none" size={12} aria-hidden="true" />}
                      {draftStatusLabel(editor.draft.status)}
                    </>)}
                  </span>
                  <Button
                    variant={confirmRevert ? 'armed' : 'danger'}
                    size="compact"
                    className={cn(EDITOR_BUTTON, 'ml-auto @max-[900px]:ml-0')}
                    disabled={!editor.dirty}
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
                  </Button>
                  <div className="relative inline-flex min-w-0 flex-[1_0_100%] @max-[900px]:flex-none @max-[620px]:ml-auto">
                    <Button
                      variant="primary"
                      size="compact"
                      className={cn(EDITOR_BUTTON, 'flex-1 rounded-r-none')}
                      data-slot="editor-download"
                      disabled={!editor.canDownload}
                      aria-busy={editor.exporting}
                      onClick={() => editor.onDownloadPackage(editorDownloadFormat)}
                      title={`Download the edited ${editorDownloadFormat.toUpperCase()} output`}
                    >
                      <Download size={13} /> {editor.exporting
                        ? 'Preparing...'
                        : `Download ${editorDownloadFormat.toUpperCase()}`}
                    </Button>
                    <details className="group contents">
                      <Button
                        variant="primary"
                        size="icon"
                        className="w-6.75 min-w-6.75 list-none rounded-l-none border-l-accent-text/28 aria-disabled:pointer-events-none aria-disabled:opacity-45 [&::-webkit-details-marker]:hidden"
                        render={<summary />}
                        aria-label="Choose download format"
                        aria-disabled={!editor.canDownload || editor.exporting}
                        onClick={(event) => {
                          if (!editor.canDownload || editor.exporting) event.preventDefault();
                        }}
                      >
                        <ChevronDown className="group-open:rotate-180" size={13} aria-hidden="true" />
                      </Button>
                      <div className="absolute right-0 bottom-[calc(100%+6px)] z-8 w-full min-w-56 overflow-hidden rounded-sm border border-border bg-panel p-1 shadow-[0_10px_30px_rgb(0_0_0/32%)]" role="menu">
                        {([
                          ['zip', 'ZIP', 'Edited source package'],
                          ['json', 'JSON', 'Portable operation and definition'],
                          ['vpd', 'VPD', 'Complete proto_defs file'],
                        ] as const).map(([format, label, description]) => (
                          <button
                            key={format}
                            type="button"
                            className="grid w-full cursor-pointer gap-0.5 rounded-[3px] border-0 bg-transparent px-2 py-1.75 text-left text-text hover:bg-accent-soft aria-checked:bg-accent-soft"
                            role="menuitemradio"
                            aria-checked={editorDownloadFormat === format}
                            onClick={(event) => {
                              setEditorDownloadFormat(format);
                              event.currentTarget.closest('details')?.removeAttribute('open');
                            }}
                          >
                            <span className="text-11 font-bold">{label}</span>
                            <small className="text-9.5 text-dim">{description}</small>
                          </button>
                        ))}
                      </div>
                    </details>
                  </div>
                </div>
              </div>
              <div className="relative flex min-h-0 min-w-0 flex-col overflow-hidden">
                {/* Floats over the view, so that a message appearing does not push the tabs and tools down. */}
                {(editor.error || editImportError) && (
                  <div className="pointer-events-none absolute bottom-8 left-1/2 z-20 flex w-max max-w-[min(560px,calc(100%-24px))] -translate-x-1/2 flex-col gap-1">
                    {editor.error && <BlockNotice tone="error" className="text-fail shadow-pop" role="alert">{editor.error}</BlockNotice>}
                    {editImportError && <BlockNotice tone="error" className="text-fail shadow-pop" role="alert">{editImportError}</BlockNotice>}
                  </div>
                )}
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
                        actionsRef={variantActionsRef}
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
                      <ToggleGroup<'parts' | 'transform' | 'graph'>
                        size="tab"
                        label="Layer view"
                        value={subView}
                        options={[
                          { value: 'parts', label: 'Parts' },
                          ...(editor.transform ? [{ value: 'transform' as const, label: 'Transform' }] : []),
                          ...(editor.graph ? [{ value: 'graph' as const, label: 'Graph' }] : []),
                        ]}
                        onChange={(value) => editor.onPaintSubViewChange?.(value)}
                      />
                    ) : undefined;
                    const team = editor.teamColors;
                    const teamName = team?.team === 'blu' ? 'BLU' : 'RED';
                    // Replace leads, so that the toggle stays under the pointer when it appears.
                    const teamActions = team && (<>
                      {team.enabled && team[team.team] && (
                        <FileButton
                          className={EDITOR_BUTTON}
                          label={`Replace the ${teamName} texture`}
                          accept={TEXTURE_FILE_ACCEPT}
                          title={`Replace the ${teamName} texture (${referenceLabel(team[team.team] ?? '')}). Switch the Team toggle to edit the other side.`}
                          onFiles={([file]) => replaceTeamTexture(team.team, file)}
                        >
                          <ImageUp size={13} aria-hidden="true" />
                          Replace <strong className={team.team === 'blu' ? 'text-blu' : 'text-red'}>{teamName}</strong>
                        </FileButton>
                      )}
                      <Button
                        variant="toggle"
                        size="compact"
                        className={cn(EDITOR_BUTTON, 'not-aria-pressed:text-dim')}
                        data-slot="editor-team-colors"
                        aria-pressed={team.enabled}
                        title={team.enabled
                          ? 'Use one texture for both teams again (keeps the RED one)'
                          : 'Give RED and BLU their own texture on this layer. Both start as the current one.'}
                        onClick={() => team.onToggle(!team.enabled)}
                      >
                        <Users size={13} aria-hidden="true" />
                        Team colors
                      </Button>
                    </>);
                    // A per-wear scope with no parts still shows the switch; a top-level paint hides it.
                    const partsHeaderSlot = editor.enabled || editor.perWearScope ? subViewSwitch : undefined;
                    return editor.graph && subView === 'graph'
                      ? (
                        <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-slot="editor-graph-view">
                          {/* The same head as Parts and Transform, with a control's height, so that the switch does not move between them. */}
                          <div className={cn(EDITOR_HEAD, 'bg-panel')}><div className="flex min-h-control items-center">{subViewSwitch}</div></div>
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
          <div className={PANEL} role="region" aria-label="Mounted archive">
            <Suspense fallback={<WorkbenchPanelFallback />}>
              <SourcePackagePanel state={sourcePackage} />
            </Suspense>
          </div>
        )}

        {tab === 'definitions' && (
          <div className={PANEL} role="region" aria-label="Imported definitions">
            <Suspense fallback={<WorkbenchPanelFallback />}>
              <DefinitionsPanel state={definitions} />
            </Suspense>
          </div>
        )}

        <Tabs.Panel value="export" className={PANEL}>
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

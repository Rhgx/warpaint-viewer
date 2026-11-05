import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';

import type { RecipeNode, TextureResolver } from '../../compositor/types';
import type { Manifest, PaintkitEntry, TextureMetadata, WeaponMaterial } from '../../data/types';
import { joinData } from '../../data/loader';
import { ShowcaseBoard } from '../../showcase/ShowcaseBoard';
import type { AppliedLayout, BoardEditSideEffect, ShowcaseItem, ShowcasePaint, ShowcaseSnapshot } from '../../showcase/showcaseTypes';
import { readSavedBoard, writeSavedBoard } from '../../showcase/boardStorage';
import { boardLayouts } from '../../showcase/layouts';
import { downloadBlob } from '../common/download';
import { ShowcaseGizmo, ShowcasePoseHandles } from './ShowcaseGizmo';
import { readLayoutSlots, readSlotBackups, slotImages } from './layoutSlots';
import { describeProblem, exportsBackdrop, loadSettings, SETTINGS_STORAGE_KEY, type ShowcaseSettings } from './showcaseSettings';
import { LayersSection } from './ShowcaseLayers';
import { LayoutsSection, type FeaturePick } from './ShowcaseLayouts';
import { SavedLayoutsSection } from './ShowcaseSavedLayouts';
import { ExportSection, LookSection, PlacementSection } from './ShowcaseSettingsSections';
import { ShowcaseToolbar } from './ShowcaseToolbar';
import { ShowcaseTray } from './ShowcaseTray';
import { ImageSection, MultiSection, WeaponSection } from './ShowcaseWeaponSection';
import { useSavedLayouts } from './useSavedLayouts';
import './Showcase.css';

const EMPTY_SNAPSHOT: ShowcaseSnapshot = {
  items: [], selectedId: null, selectedIds: [], problems: {}, pending: null, dragging: false, canUndo: false, canRedo: false,
};
const VIEWMODEL_MODELS = `${import.meta.env.BASE_URL}data/viewmodels/models/`;

interface ShowcaseModeProps {
  manifest: Manifest;
  paintkits: readonly PaintkitEntry[];
  selectedKit: PaintkitEntry | null;
  team: 'red' | 'blu';
  wearIndex: number;
  seed: string;
  resolveRecipe: (kit: PaintkitEntry, weaponKey: string, team: 'red' | 'blu', wearIndex: number) => Promise<RecipeNode | null>;
  resolveTexture: TextureResolver;
  resolveCubemap: (ref: string) => Promise<string[] | null>;
  resolvePackageMaterial: (weaponKey: string, materialOverrideId?: string) => Promise<{ material: WeaponMaterial } | null>;
  textureMetadataResolver: (ref: string) => Partial<TextureMetadata> | undefined;
  hasReplacedTextures: (kitId: number) => boolean;
  inspectorEl: HTMLElement | null;
  /** Dropped on the viewer before the board was open, to open once it is. */
  droppedBoardFile: File | null;
  onDroppedBoardFileTaken: () => void;
  onClose: () => void;
}

export default function ShowcaseMode(props: ShowcaseModeProps) {
  const { manifest, selectedKit, inspectorEl, droppedBoardFile, onDroppedBoardFileTaken, onClose } = props;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [board, setBoard] = useState<ShowcaseBoard | null>(null);
  const [settings, setSettings] = useState(loadSettings);
  useEffect(() => {
    try {
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // Private browsing without storage: settings last for the session.
    }
  }, [settings]);
  const rotationStep = settings.rotationSnap || 30;
  const rotationStepRef = useRef(rotationStep);
  useEffect(() => {
    rotationStepRef.current = rotationStep;
  }, [rotationStep]);
  // The board reads the latest paint inputs lazily, so it never needs rebuilding for them.
  const latest = useRef(props);
  useEffect(() => {
    latest.current = props;
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const instance = new ShowcaseBoard({
      canvas,
      weapons: manifest.weapons,
      modelUrl: (weapon, rigged) => (rigged ? `${VIEWMODEL_MODELS}${weapon.key}.glb` : joinData(weapon.model)),
      resolveTexture: (ref) => latest.current.resolveTexture(ref),
      textureMetadata: manifest.textures,
      textureMetadataResolver: (ref) => latest.current.textureMetadataResolver(ref),
      resolveCubemap: (ref) => latest.current.resolveCubemap(ref),
      // In the viewer's order: a mounted package's VMT, then the paint's own material (the Macaw finishes).
      resolveMaterial: async (weaponKey, kitId) => {
        const { paintkits, resolvePackageMaterial } = latest.current;
        const overrideId = paintkits.find((kit) => kit.id === kitId)?.materialOverrides?.[weaponKey];
        const packaged = await resolvePackageMaterial(weaponKey, overrideId);
        return packaged?.material ?? (overrideId ? manifest.materials?.[overrideId] : undefined);
      },
      resolveRecipe: (kitId, weaponKey, team, wearIndex) => {
        const { paintkits, resolveRecipe } = latest.current;
        const kit = paintkits.find((entry) => entry.id === kitId);
        return kit ? resolveRecipe(kit, weaponKey, team, wearIndex) : Promise.resolve(null);
      },
    });
    // The UI gets the board once the autosaved weapons are back, so nothing is dropped on it mid-restore
    // and the empty board it starts as is never saved over them.
    let disposed = false;
    instance.load(readSavedBoard(), slotImages([...readLayoutSlots(), ...readSlotBackups()]))
      .catch((cause: unknown) => console.error('[showcase] could not restore the saved board', cause))
      .finally(() => {
        if (!disposed) setBoard(instance);
      });
    if (import.meta.env.DEV) (window as unknown as { __showcase?: ShowcaseBoard }).__showcase = instance;
    return () => {
      disposed = true;
      instance.dispose();
      setBoard(null);
    };
  }, [manifest]);

  const unsavedItems = useRef<readonly ShowcaseItem[] | null>(null);
  const saveNow = useCallback(() => {
    if (unsavedItems.current) writeSavedBoard(unsavedItems.current);
    unsavedItems.current = null;
  }, []);

  // One effect per setting, so changing one never re-measures for the others.
  useEffect(() => { board?.setSnap(settings.snapToGrid); }, [board, settings.snapToGrid]);
  useEffect(() => { board?.setGrid(settings.grid); }, [board, settings.grid]);
  useEffect(() => { board?.setKeepApart(settings.keepApart); }, [board, settings.keepApart]);
  useEffect(() => { board?.setSpacing(settings.spacing); }, [board, settings.spacing]);
  useEffect(() => { board?.setLayoutSize(settings.weaponSize / 100); }, [board, settings.weaponSize]);
  useEffect(() => { board?.setKeepInside(settings.keepInside); }, [board, settings.keepInside]);
  useEffect(() => { board?.setShowGrid(settings.showFootprints); }, [board, settings.showFootprints]);
  useEffect(() => { board?.setLight(settings.lightAzimuth, settings.lightElevation); }, [board, settings.lightAzimuth, settings.lightElevation]);
  useEffect(() => { board?.setShadows(settings.shadows); }, [board, settings.shadows]);
  useEffect(() => { board?.setShadowStrength(settings.shadow / 100); }, [board, settings.shadow]);
  useEffect(() => { board?.setBackground(settings.background); }, [board, settings.background]);

  const snapshot = useSyncExternalStore(board?.subscribe ?? noopSubscribe, board?.getSnapshot ?? emptySnapshot);
  useEffect(() => {
    if (!board) return;
    unsavedItems.current = snapshot.items;
    const timer = window.setTimeout(saveNow, 400);
    return () => window.clearTimeout(timer);
  }, [board, snapshot.items, saveNow]);
  useEffect(() => {
    window.addEventListener('pagehide', saveNow);
    return () => {
      window.removeEventListener('pagehide', saveNow);
      saveNow();
    };
  }, [saveNow]);

  const previousKitId = useRef(selectedKit?.id);
  useEffect(() => {
    if (!board || !selectedKit || previousKitId.current === selectedKit.id) return;
    previousKitId.current = selectedKit.id;
    const { selectedIds, items } = board.getSnapshot();
    const ids = items
      .filter((item) => selectedIds.includes(item.id) && item.paint.kitId !== selectedKit.id && selectedKit.weapons.includes(item.weaponKey))
      .map((item) => item.id);
    if (ids.length) board.setPaintMany(ids, { kitId: selectedKit.id, kitName: selectedKit.name });
  }, [board, selectedKit]);
  const selected = snapshot.items.find((item) => item.id === snapshot.selectedId) ?? null;

  useEffect(() => {
    if (!board) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.ctrlKey || event.metaKey || target?.closest('input, textarea, [role="slider"], [contenteditable="true"]')) return;
      // A dialog such as the controls reference owns the keyboard while open.
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      const held = board.heldId;
      const id = held ?? board.getSnapshot().selectedId;
      if (event.key === 'Escape' && !held) board.select(null);
      const { selectedIds } = board.getSnapshot();
      if (!held && selectedIds.length > 1) {
        const step = rotationStepRef.current;
        const handled = (() => {
          switch (event.key.toLowerCase()) {
            case 'e': board.rotateMany(selectedIds, -step); return true;
            case 'q': board.rotateMany(selectedIds, step); return true;
            case 'r': board.rotateMany(selectedIds, event.shiftKey ? step : -step); return true;
            case 'f': board.flipMany(selectedIds); return true;
            default: break;
          }
          switch (event.key) {
            case 'Delete': case 'Backspace': board.removeMany(selectedIds); return true;
            case 'ArrowLeft': board.nudgeMany(selectedIds, -1, 0); return true;
            case 'ArrowRight': board.nudgeMany(selectedIds, 1, 0); return true;
            case 'ArrowUp': board.nudgeMany(selectedIds, 0, 1); return true;
            case 'ArrowDown': board.nudgeMany(selectedIds, 0, -1); return true;
            default: return false;
          }
        })();
        if (handled) event.preventDefault();
        return;
      }
      if (!id) return;
      const step = rotationStepRef.current;
      const key = event.key.toLowerCase();
      // E or R turns clockwise, Q or Shift+R counterclockwise, also while carrying.
      if (key === 'e' || key === 'q' || key === 'r') {
        board.rotateBy(id, key === 'q' || (key === 'r' && event.shiftKey) ? step : -step);
        event.preventDefault();
        return;
      }
      if (held) return;
      const handled = (() => {
        switch (event.key) {
          case 'f': case 'F': {
            const item = board.getSnapshot().items.find((entry) => entry.id === id);
            if (item) board.update(id, { flipped: !item.flipped });
            board.settle(id);
            return true;
          }
          case 'Delete': case 'Backspace': board.remove(id); return true;
          case 'ArrowLeft': board.nudge(id, -1, 0); return true;
          case 'ArrowRight': board.nudge(id, 1, 0); return true;
          case 'ArrowUp': board.nudge(id, 0, 1); return true;
          case 'ArrowDown': board.nudge(id, 0, -1); return true;
          default: return false;
        }
      })();
      if (handled) event.preventDefault();
    };
    // Capture phase: while the board is open, its history owns these keys, not the editor underneath.
    const onHistoryKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, [contenteditable="true"]')) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      const key = event.key.toLowerCase();
      if (key === 'z' && !event.shiftKey) board.undo();
      else if (key === 'y' || (key === 'z' && event.shiftKey)) board.redo();
      else return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keydown', onHistoryKey, { capture: true });
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keydown', onHistoryKey, { capture: true });
    };
  }, [board]);

  // Stable props keep the tray and settings sections from re-rendering on every drag frame.
  const trayWeapons = useMemo(() => (selectedKit
    ? selectedKit.weapons.map((key) => manifest.weapons.find((weapon) => weapon.key === key)).filter((weapon) => !!weapon)
    : []), [manifest, selectedKit]);
  const placedCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const item of snapshot.items) {
      if (item.paint.kitId === selectedKit?.id && !item.part) counts[item.weaponKey] = (counts[item.weaponKey] ?? 0) + 1;
    }
    return counts;
  }, [selectedKit, snapshot.items]);
  // New weapons start with the viewer's wear, team and seed, then keep their own.
  const trayPaint = useMemo<ShowcasePaint | null>(() => (selectedKit
    ? { kitId: selectedKit.id, kitName: selectedKit.name, team: props.team, wearIndex: props.wearIndex, seed: props.seed }
    : null), [selectedKit, props.team, props.wearIndex, props.seed]);
  const [imageError, setImageError] = useState<string | null>(null);
  useEffect(() => {
    if (!imageError) return;
    const timer = window.setTimeout(() => setImageError(null), 4000);
    return () => window.clearTimeout(timer);
  }, [imageError]);
  const warning = snapshot.pending?.problem ? describeProblem(snapshot.pending.problem) : imageError;
  const addImage = useCallback(async (file: File) => {
    if (!board) return;
    setImageError(null);
    try {
      await board.addImage(file, file.name.replace(/\.[^.]+$/, ''));
    } catch (cause) {
      console.error('[showcase] could not add the image', cause);
      setImageError(`Could not open ${file.name}`);
    }
  }, [board]);
  const { outputWidth } = settings;
  const exportBackdrop = exportsBackdrop(settings);
  const exportPng = useCallback(async () => {
    if (board) downloadBlob(await board.exportPng(outputWidth, exportBackdrop), 'showcase.png');
  }, [board, outputWidth, exportBackdrop]);
  const copyPng = useCallback(async () => {
    if (!board) return;
    const blob = await board.exportPng(outputWidth, exportBackdrop);
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
  }, [board, outputWidth, exportBackdrop]);
  const changeSettings = useCallback((patch: Partial<ShowcaseSettings>) => setSettings((current) => ({ ...current, ...patch })), []);
  // A slot can take seconds to load its models, and nothing may land on the board until it has.
  const [restoring, setRestoring] = useState(false);
  const restoreBoard = useCallback(async (items: readonly ShowcaseItem[], layout: AppliedLayout | null, sideEffect: BoardEditSideEffect) => {
    if (!board) return false;
    setRestoring(true);
    try {
      await board.replaceWith(items, layout, sideEffect);
      return true;
    } catch (cause) {
      console.error('[showcase] could not load the saved layout', cause);
      return false;
    } finally {
      setRestoring(false);
    }
  }, [board]);
  const replaceSettings = useCallback((next: ShowcaseSettings) => setSettings(next), []);
  // Set by the panel, which owns importing, for files dropped on the board.
  const importDropped = useRef<((file: File) => Promise<string | null>) | null>(null);
  const registerImport = useCallback((importFile: (file: File) => Promise<string | null>) => {
    importDropped.current = importFile;
  }, []);
  const [dropping, setDropping] = useState<'image' | 'board' | null>(null);
  // On the whole window: a file dropped beside the board would otherwise make the browser navigate to it, losing the session.
  useEffect(() => {
    const onDragOver = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes('Files')) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      setDropping(event.dataTransfer.items[0]?.type.startsWith('image/') ? 'image' : 'board');
    };
    const onDragLeave = (event: DragEvent) => {
      if (!event.relatedTarget) setDropping(null);
    };
    const onDrop = (event: DragEvent) => {
      const files = event.dataTransfer?.files;
      const file = files?.[0];
      setDropping(null);
      if (!file) return;
      event.preventDefault();
      if (files.length > 1) {
        setImageError('Drop one file at a time.');
        return;
      }
      if (file.type.startsWith('image/')) {
        void addImage(file);
        return;
      }
      // Clearing the selection brings the panel's saved boards back, where the result is reported.
      board?.select(null);
      void importDropped.current?.(file).then((problem) => setImageError(problem));
    };
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [addImage, board]);
  // The panel registers its import in its own effect, which runs ahead of this one.
  useEffect(() => {
    if (!droppedBoardFile || !board || !importDropped.current) return;
    onDroppedBoardFileTaken();
    void importDropped.current(droppedBoardFile).then((problem) => setImageError(problem));
  }, [board, droppedBoardFile, inspectorEl, onDroppedBoardFileTaken]);

  return (
    <div className="showcase" inert={restoring}>
      <div className="showcase-stage">
        <canvas ref={canvasRef} className="showcase-canvas" />
        {board && selected && !snapshot.dragging && (
          <>
            <ShowcaseGizmo board={board} item={selected} snap={settings.rotationSnap} />
            {settings.poseHandles && <ShowcasePoseHandles board={board} item={selected} />}
          </>
        )}
        {warning && <div className="showcase-warning" role="status">{warning}</div>}
        {dropping && (
          <div className="showcase-drop-hint" aria-hidden="true">
            {dropping === 'image' ? 'Drop to add this picture to the board.' : 'Drop a .pegboard file to open it. Replaces the board.'}
          </div>
        )}
        <ShowcaseToolbar board={board} onClose={onClose} hasItems={snapshot.items.length > 0}
          canUndo={snapshot.canUndo} canRedo={snapshot.canRedo} onSave={exportPng} onCopy={copyPng} onAddImage={addImage} />
      </div>
      <ShowcaseTray board={board} paint={trayPaint} weapons={trayWeapons} placedCounts={placedCounts} />
      {inspectorEl && createPortal(
        <ShowcasePanel board={board} manifest={manifest} paintkits={props.paintkits} snapshot={snapshot} selected={selected}
          kit={selectedKit} paint={trayPaint} hasReplacedTextures={props.hasReplacedTextures} restoring={restoring} onRestore={restoreBoard} onReplaceSettings={replaceSettings} onRegisterImport={registerImport}
          settings={settings} onSettingsChange={changeSettings} rotationStep={rotationStep} />,
        inspectorEl,
      )}
    </div>
  );
}

const noopSubscribe = () => () => undefined;
const emptySnapshot = () => EMPTY_SNAPSHOT;

function ShowcasePanel({ board, manifest, paintkits, kit, paint, hasReplacedTextures, snapshot, selected, restoring, onRestore, onReplaceSettings, onRegisterImport, settings, onSettingsChange, rotationStep }: {
  board: ShowcaseBoard | null;
  manifest: Manifest;
  paintkits: readonly PaintkitEntry[];
  kit: PaintkitEntry | null;
  paint: ShowcasePaint | null;
  hasReplacedTextures: (kitId: number) => boolean;
  snapshot: ShowcaseSnapshot;
  selected: ShowcaseItem | null;
  restoring: boolean;
  onRestore: (items: readonly ShowcaseItem[], layout: AppliedLayout | null, sideEffect: BoardEditSideEffect) => Promise<boolean>;
  onReplaceSettings: (settings: ShowcaseSettings) => void;
  onRegisterImport: (importFile: (file: File) => Promise<string | null>) => void;
  settings: ShowcaseSettings;
  onSettingsChange: (patch: Partial<ShowcaseSettings>) => void;
  rotationStep: number;
}) {
  const problem = selected ? (snapshot.pending?.id === selected.id ? snapshot.pending.problem : snapshot.problems[selected.id]) : null;
  const multiple = useMemo(() => {
    if (snapshot.selectedIds.length < 2) return null;
    const chosen = new Set(snapshot.selectedIds);
    return snapshot.items.filter((item) => chosen.has(item.id));
  }, [snapshot.items, snapshot.selectedIds]);
  const setPoseHandles = useCallback((poseHandles: boolean) => onSettingsChange({ poseHandles }), [onSettingsChange]);
  // A layout fills the layer list, which would push the layouts down mid-click; collapse it as one is picked.
  const [layersOpen, setLayersOpen] = useState(true);
  const collapseLayers = useCallback(() => setLayersOpen(false), []);
  const setWeaponSize = useCallback((weaponSize: number) => onSettingsChange({ weaponSize }), [onSettingsChange]);
  const grades = useMemo(() => new Map(paintkits.map((entry) => [entry.id, entry.grade])), [paintkits]);
  // The weapon the wears and RED and BLU show: the one picked, else the first placed in this paint.
  const [featured, setFeatured] = useState<string | null>(null);
  const [pairs, setPairs] = useState<readonly string[]>([]);
  const firstPlaced = snapshot.items.find((item) => item.paint.kitId === kit?.id && !item.part)?.weaponKey ?? null;
  const focus = featured && kit?.weapons.includes(featured) ? featured : firstPlaced;
  const wearCount = manifest.wearNames.length;
  const layouts = useMemo(() => (kit && paint ? boardLayouts(kit, paint, wearCount, focus, pairs) : []), [kit, paint, wearCount, focus, pairs]);
  // Picking weapons puts the layout showing them straight back on the board.
  const feature = useCallback((pick: FeaturePick, layoutId: string) => {
    const nextFocus = pick.weapon ?? focus;
    const nextPairs = pick.pairs ?? pairs;
    if (pick.weapon) setFeatured(pick.weapon);
    if (pick.pairs) setPairs(pick.pairs);
    return kit && paint ? boardLayouts(kit, paint, wearCount, nextFocus, nextPairs).find((layout) => layout.id === layoutId) : undefined;
  }, [kit, paint, wearCount, focus, pairs]);
  // Bumped to drop the Layouts section's picker, which belongs to the layout a saved board just replaced.
  const [pickerReset, setPickerReset] = useState(0);
  const isKnownPaint = useCallback((kitId: number) => grades.has(kitId), [grades]);
  const saved = useSavedLayouts({
    board, items: snapshot.items, settings, featured, pairs, isKnownPaint, wearCount, selectedPaint: kit, hasReplacedTextures,
    onSettingsChange: onReplaceSettings,
    onFeaturedChange: (weapon, nextPairs) => {
      setFeatured(weapon);
      setPairs(nextPairs);
      setPickerReset((count) => count + 1);
    },
    onApplyStart: collapseLayers,
    onRestore,
  });
  // Controlled, so that a file dropped on the board can open it to show what happened.
  const [savedOpen, setSavedOpen] = useState(true);
  useEffect(() => {
    onRegisterImport((file) => {
      setSavedOpen(true);
      return saved.importFile(file);
    });
  });
  const { detachBoard } = saved;
  const layoutApplied = useCallback(() => {
    collapseLayers();
    detachBoard();
  }, [collapseLayers, detachBoard]);
  const featureOptions = useMemo(() => (kit?.weapons ?? []).flatMap((key) => {
    const weapon = manifest.weapons.find((entry) => entry.key === key);
    return weapon && key !== 'paintkit_tool' ? [{ value: key, label: weapon.name, icon: weapon.icon ? joinData(weapon.icon) : null }] : [];
  }), [kit, manifest]);
  return (
    <div className="showcase-panel" inert={restoring}>
      <LayersSection board={board} manifest={manifest} items={snapshot.items} selectedIds={snapshot.selectedIds}
        problems={snapshot.problems} reorderable={!settings.keepApart} grades={grades} open={layersOpen} onOpenChange={setLayersOpen} />
      {selected?.image && board && (
        <ImageSection board={board} item={selected} problem={problem ?? null} rotationSnap={settings.rotationSnap} rotationStep={rotationStep} />
      )}
      {selected && !selected.image && board && (
        <WeaponSection board={board} item={selected} problem={problem ?? null} rotationSnap={settings.rotationSnap} rotationStep={rotationStep}
          kit={paintkits.find((kit) => kit.id === selected.paint.kitId) ?? null} wearNames={manifest.wearNames}
          poseHandles={settings.poseHandles} onPoseHandlesChange={setPoseHandles} />
      )}
      {multiple && board && (
        <MultiSection board={board} items={multiple} paintkits={paintkits} wearNames={manifest.wearNames}
          rotationSnap={settings.rotationSnap} rotationStep={rotationStep} />
      )}
      {!selected && !multiple && (
        <>
          {board && layouts.length > 0 && <LayoutsSection board={board} layouts={layouts} featureOptions={featureOptions} onFeature={feature} onApply={layoutApplied}
            weaponSize={settings.weaponSize} onWeaponSizeChange={setWeaponSize} pickerReset={pickerReset} />}
          {board && <SavedLayoutsSection saved={saved} hasItems={snapshot.items.length > 0} open={savedOpen} onOpenChange={setSavedOpen} />}
          <PlacementSection settings={settings} onChange={onSettingsChange} />
          <LookSection settings={settings} onChange={onSettingsChange} />
          <ExportSection board={board} settings={settings} onChange={onSettingsChange} />
        </>
      )}
    </div>
  );
}

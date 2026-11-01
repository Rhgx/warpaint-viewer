import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';

import type { RecipeNode, TextureResolver } from '../../compositor/types';
import type { Manifest, PaintkitEntry, TextureMetadata } from '../../data/types';
import { joinData } from '../../data/loader';
import { ShowcaseBoard } from '../../showcase/ShowcaseBoard';
import type { ShowcaseItem, ShowcasePaint, ShowcaseSnapshot } from '../../showcase/showcaseTypes';
import { boardLayouts } from '../../showcase/layouts';
import { downloadBlob } from '../common/download';
import { ShowcaseGizmo, ShowcasePoseHandles } from './ShowcaseGizmo';
import { describeProblem, loadSettings, SETTINGS_STORAGE_KEY, type ShowcaseSettings } from './showcaseSettings';
import { LayersSection } from './ShowcaseLayers';
import { LayoutsSection, type FeaturePick } from './ShowcaseLayouts';
import { ExportSection, LookSection, PlacementSection } from './ShowcaseSettingsSections';
import { ShowcaseToolbar } from './ShowcaseToolbar';
import { ShowcaseTray } from './ShowcaseTray';
import { WeaponSection } from './ShowcaseWeaponSection';
import './Showcase.css';

const EMPTY_SNAPSHOT: ShowcaseSnapshot = {
  items: [], selectedId: null, problems: {}, pending: null, dragging: false, canUndo: false, canRedo: false,
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
  textureMetadataResolver: (ref: string) => Partial<TextureMetadata> | undefined;
  inspectorEl: HTMLElement | null;
  onClose: () => void;
}

export default function ShowcaseMode(props: ShowcaseModeProps) {
  const { manifest, selectedKit, inspectorEl, onClose } = props;
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
      // A paint can swap in its own material per weapon (the Macaw finishes).
      materialOverride: (weaponKey, kitId) => {
        const overrideId = latest.current.paintkits.find((kit) => kit.id === kitId)?.materialOverrides?.[weaponKey];
        return overrideId ? manifest.materials?.[overrideId] : undefined;
      },
      resolveRecipe: (kitId, weaponKey, team, wearIndex) => {
        const { paintkits, resolveRecipe } = latest.current;
        const kit = paintkits.find((entry) => entry.id === kitId);
        return kit ? resolveRecipe(kit, weaponKey, team, wearIndex) : Promise.resolve(null);
      },
    });
    setBoard(instance);
    if (import.meta.env.DEV) (window as unknown as { __showcase?: ShowcaseBoard }).__showcase = instance;
    return () => {
      instance.dispose();
      setBoard(null);
    };
  }, [manifest]);

  // One effect per setting, so changing one never re-measures for the others.
  useEffect(() => { board?.setSnap(settings.snapToGrid); }, [board, settings.snapToGrid]);
  useEffect(() => { board?.setGrid(settings.grid); }, [board, settings.grid]);
  useEffect(() => { board?.setKeepApart(settings.keepApart); }, [board, settings.keepApart]);
  useEffect(() => { board?.setSpacing(settings.spacing); }, [board, settings.spacing]);
  useEffect(() => { board?.setKeepInside(settings.keepInside); }, [board, settings.keepInside]);
  useEffect(() => { board?.setShowGrid(settings.showFootprints); }, [board, settings.showFootprints]);
  useEffect(() => { board?.setLight(settings.lightAzimuth, settings.lightElevation); }, [board, settings.lightAzimuth, settings.lightElevation]);
  useEffect(() => { board?.setShadows(settings.shadows); }, [board, settings.shadows]);
  useEffect(() => { board?.setShadowStrength(settings.shadow / 100); }, [board, settings.shadow]);
  useEffect(() => { board?.setBackground(settings.background); }, [board, settings.background]);

  const snapshot = useSyncExternalStore(board?.subscribe ?? noopSubscribe, board?.getSnapshot ?? emptySnapshot);

  // Picking another paint in the catalog repaints the selected weapon, when that paint covers it.
  const previousKitId = useRef(selectedKit?.id);
  useEffect(() => {
    if (!board || !selectedKit || previousKitId.current === selectedKit.id) return;
    previousKitId.current = selectedKit.id;
    const { selectedId, items } = board.getSnapshot();
    const item = items.find((entry) => entry.id === selectedId);
    if (!item || item.paint.kitId === selectedKit.id || !selectedKit.weapons.includes(item.weaponKey)) return;
    board.setPaint(item.id, { kitId: selectedKit.id, kitName: selectedKit.name });
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
  const warning = snapshot.pending?.problem ? describeProblem(snapshot.pending.problem) : null;
  const outputWidth = settings.outputWidth;
  const exportPng = useCallback(async () => {
    if (board) downloadBlob(await board.exportPng(outputWidth), 'showcase.png');
  }, [board, outputWidth]);
  const copyPng = useCallback(async () => {
    if (!board) return;
    const blob = await board.exportPng(outputWidth);
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
  }, [board, outputWidth]);
  const changeSettings = useCallback((patch: Partial<ShowcaseSettings>) => setSettings((current) => ({ ...current, ...patch })), []);

  return (
    <div className="showcase">
      <div className="showcase-stage">
        <canvas ref={canvasRef} className="showcase-canvas" />
        {board && selected && !snapshot.dragging && (
          <>
            <ShowcaseGizmo board={board} item={selected} snap={settings.rotationSnap} />
            {settings.poseHandles && <ShowcasePoseHandles board={board} item={selected} />}
          </>
        )}
        {warning && <div className="showcase-warning" role="status">{warning}</div>}
        <ShowcaseToolbar board={board} onClose={onClose} hasItems={snapshot.items.length > 0}
          canUndo={snapshot.canUndo} canRedo={snapshot.canRedo} onSave={exportPng} onCopy={copyPng} />
      </div>
      <ShowcaseTray board={board} paint={trayPaint} weapons={trayWeapons} placedCounts={placedCounts} />
      {inspectorEl && createPortal(
        <ShowcasePanel board={board} manifest={manifest} paintkits={props.paintkits} snapshot={snapshot} selected={selected}
          kit={selectedKit} paint={trayPaint}
          settings={settings} onSettingsChange={changeSettings}
          onSave={exportPng} onCopy={copyPng} rotationStep={rotationStep} />,
        inspectorEl,
      )}
    </div>
  );
}

const noopSubscribe = () => () => undefined;
const emptySnapshot = () => EMPTY_SNAPSHOT;

function ShowcasePanel({ board, manifest, paintkits, kit, paint, snapshot, selected, settings, onSettingsChange, onSave, onCopy, rotationStep }: {
  board: ShowcaseBoard | null;
  manifest: Manifest;
  paintkits: readonly PaintkitEntry[];
  kit: PaintkitEntry | null;
  paint: ShowcasePaint | null;
  snapshot: ShowcaseSnapshot;
  selected: ShowcaseItem | null;
  settings: ShowcaseSettings;
  onSettingsChange: (patch: Partial<ShowcaseSettings>) => void;
  onSave: () => Promise<void>;
  onCopy: () => Promise<void>;
  rotationStep: number;
}) {
  const problem = selected ? (snapshot.pending?.id === selected.id ? snapshot.pending.problem : snapshot.problems[selected.id]) : null;
  const setPoseHandles = useCallback((poseHandles: boolean) => onSettingsChange({ poseHandles }), [onSettingsChange]);
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
  const featureOptions = useMemo(() => (kit?.weapons ?? []).flatMap((key) => {
    const weapon = manifest.weapons.find((entry) => entry.key === key);
    return weapon && key !== 'paintkit_tool' ? [{ value: key, label: weapon.name, icon: weapon.icon ? joinData(weapon.icon) : null }] : [];
  }), [kit, manifest]);
  return (
    <div className="showcase-panel">
      <LayersSection board={board} manifest={manifest} items={snapshot.items} selectedId={snapshot.selectedId}
        problems={snapshot.problems} reorderable={!settings.keepApart} grades={grades} />
      {selected && board && (
        <WeaponSection board={board} item={selected} problem={problem ?? null} rotationSnap={settings.rotationSnap} rotationStep={rotationStep}
          kit={paintkits.find((kit) => kit.id === selected.paint.kitId) ?? null} wearNames={manifest.wearNames}
          poseHandles={settings.poseHandles} onPoseHandlesChange={setPoseHandles} />
      )}
      {/* Board-wide settings step aside while a weapon is being edited. */}
      {!selected && (
        <>
          {board && layouts.length > 0 && <LayoutsSection board={board} layouts={layouts} featureOptions={featureOptions} onFeature={feature} />}
          <PlacementSection settings={settings} onChange={onSettingsChange} />
          <LookSection settings={settings} onChange={onSettingsChange} />
          <ExportSection board={board} settings={settings} onChange={onSettingsChange} hasItems={snapshot.items.length > 0}
            onSave={onSave} onCopy={onCopy} />
        </>
      )}
    </div>
  );
}

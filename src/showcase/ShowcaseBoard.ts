// Showcase board engine: a pegboard where painted weapons are dragged onto a grid,
// rotated, posed and exported as one image.
// It runs its own renderer and compositor, so each weapon can wear a different paint
// without touching the main viewer.

import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';

import { Compositor } from '../compositor/compositor';
import { createTf2Uniforms } from '../viewer/materialConfig';
import { DEFAULT_KILLS, supportsStatClock } from '../data/statClock';
import { StatClock } from '../viewer/statClock';
import { loadEditorEnvCube, makeEnvCube } from '../viewer/env';
import type { WeaponEntry } from '../data/types';
import type { LayoutPacking, LayoutRows } from './layouts';
import { POSE_RIGS, WEAPON_PARTS, defaultPose, isRigged, partOf, type RestBone } from './poseRigs';
import { FRAME_SIDE, frameTexture, makeTf2Material, pegboardTexture, vignetteTexture } from './boardTextures';
import { BOARD_HEIGHT, BOARD_WIDTH, GRID_CELL, LOGO_SPACE } from './boardMetrics';
import { arrange, type BoardLayoutHost } from './boardLayout';
import { compose } from './boardComposition';
import { cellKey, refreshFootprint } from './footprint';
import type { AppliedLayout, BoardBackground, BoardEditSideEffect, DragState, GridSize, ItemRuntime, MeshSubset, PoseHandle, ShowcaseBoardOptions, ShowcaseItem, ShowcasePaint, ShowcaseSnapshot, FitProblem } from './showcaseTypes';
import { baseOrientation, findPartBases, partSubset, posedPositions, restingRoll, shownSideFlip } from './weaponGeometry';
import { BoardPaints, MIN_SOURCE_SIZE } from './boardPaints';
import { prepareBoardImage, pruneBoardImages, readBoardImage, saveBoardImage } from './boardImages';
import { PoseHandles } from './poseHandles';

const RESTING_LIFT = 1.4;
/** Pictures lie flat on the board, under the weapons. */
const IMAGE_LIFT = 0.1;
/** Enough that pictures stacked on each other keep their order. */
const IMAGE_THICKNESS = 0.02;
const IMAGE_PAINT: ShowcasePaint = { kitId: -1, kitName: 'Image', team: 'red', wearIndex: 0, seed: '0' };
const CARRY_LIFT = 7;
/** Tilt and turn stay small so every weapon still reads as a side profile on the pegboard. */
export const TILT_LIMIT = 30;
/** Scale of a weapon at 100%, shared by all weapons so their relative sizes stay true. */
const BASE_SCALE = 1.5;
const MAX_CELL_MARKERS = 6000;
const HISTORY_LIMIT = 100;
/** Same settle delay as the viewer: the buffer is resized once a layout reflow stops. */
const RESIZE_DEBOUNCE_MS = 240;
/** Live view margin around the board's frame; exports fit the frame exactly. */
const FIT_PADDING = 1.06;

/** Dual-core laptops with integrated graphics get a smaller, cheaper shadow map. */
const LOW_END = (navigator.hardwareConcurrency ?? 8) <= 4
  || ((navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8) <= 4;

const wrapRoll = (roll: number) => (((roll + 180) % 360) + 360) % 360 - 180;

const copyItem = (item: ShowcaseItem): ShowcaseItem => ({ ...item, paint: { ...item.paint }, pose: { ...item.pose }, hiddenParts: [...item.hiddenParts], ...(item.image ? { image: { ...item.image } } : {}) });

const keyI = (key: number) => Math.floor(key / 4096) - 2048;
const keyJ = (key: number) => (key % 4096) - 2048;

let idCounter = 0;

type ManyPatch = Partial<Pick<ShowcaseItem, 'roll' | 'tilt' | 'turn' | 'flipped' | 'scale'>>;

interface HistoryEntry {
  items: ShowcaseItem[];
  layout: AppliedLayout | null;
  /** What else changed in the step from this state to the next. */
  sideEffect?: BoardEditSideEffect;
}

/** The TF2 shader omits three's 1/pi Lambert factor, as Source does, so lights run at Source strength; the board's Lambert surfaces are brightened by pi to match. */
const SOURCE_LIGHT_SCALE = 1 / Math.PI;

export class ShowcaseBoard {
  readonly renderer: THREE.WebGLRenderer;
  readonly #options: ShowcaseBoardOptions;
  readonly #scene = new THREE.Scene();
  readonly #camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 2000);
  readonly #loader = new GLTFLoader();
  readonly #gltfs = new Map<string, Promise<GLTF>>();
  /** What weapons reflect when their material names no cubemap: TF2's item preview cubemap. */
  #envMap = makeEnvCube(0x9fb8d6, 0x40382c);
  /** Ambient light on weapons, Source's six-sided ambient cube, shared by all of them. */
  readonly #ambientCube = Array.from({ length: 6 }, () => new THREE.Vector3(0.4, 0.4, 0.4));
  readonly #boardPaints: BoardPaints;
  readonly #handles: PoseHandles;
  readonly #compositor: Compositor;
  readonly #runtimes = new Map<string, ItemRuntime>();
  /** Kept after a picture is removed, so undo can bring it back. */
  readonly #imageAssets = new Map<string, Promise<{ url: string; texture: THREE.Texture } | null>>();
  readonly #imageUrls = new Map<string, string>();
  readonly #listeners = new Set<() => void>();
  readonly #raycaster = new THREE.Raycaster();
  readonly #board: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshLambertMaterial>;
  readonly #shadowBoard: THREE.Mesh<THREE.PlaneGeometry, THREE.ShadowMaterial>;
  readonly #vignette: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  readonly #frame: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshLambertMaterial>;
  readonly #ghost: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  readonly #cells: THREE.InstancedMesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  readonly #resizeObserver: ResizeObserver;
  #items: ShowcaseItem[] = [];
  #selection: readonly string[] = [];
  #pending: ShowcaseSnapshot['pending'] = null;
  #snapshot: ShowcaseSnapshot;
  #drag: DragState | null = null;
  /** Last pose of each item that passed the fit rules; edits that end invalid return to it. */
  readonly #lastValid = new Map<string, Pick<ShowcaseItem, 'roll' | 'tilt' | 'turn' | 'flipped' | 'scale' | 'pose'>>();
  #grid: GridSize = 'normal';
  #spacing = 1;
  #layoutSize = 1;
  /** Between updateMany and settleMany. */
  #groupEditing = false;
  #showGrid = false;
  #snap = true;
  #keepApart = true;
  #keepInside = true;
  readonly #light: THREE.DirectionalLight;
  readonly #ambient: THREE.HemisphereLight;
  readonly #clipPlanes = [
    new THREE.Plane(new THREE.Vector3(-1, 0, 0), BOARD_WIDTH / 2),
    new THREE.Plane(new THREE.Vector3(1, 0, 0), BOARD_WIDTH / 2),
    new THREE.Plane(new THREE.Vector3(0, -1, 0), BOARD_HEIGHT / 2),
    new THREE.Plane(new THREE.Vector3(0, 1, 0), BOARD_HEIGHT / 2),
  ];
  #background: BoardBackground = 'framed';
  #shadows = true;
  #raf = 0;
  #resizeTimer = 0;
  #observedResize = false;
  #snapshotStale = false;
  #problemsKey = '';
  /** The weapon in the middle of a rotation or pose drag, until it settles. */
  #liveEditId: string | null = null;
  #liveRulesKey = '';
  #notifyQueued = false;
  /** Latest pointer position of a drag, applied once per frame. */
  #queuedPointer: { x: number; y: number } | null = null;
  /** Items whose rotation, size, or pose changed and need a new footprint this frame. */
  readonly #reshapeQueue = new Set<string>();
  #ghostVersion = -1;
  readonly #ghostCanvas = document.createElement('canvas');
  #footprintVersion = 0;
  #ghostSize = '';
  #dirty = true;
  #disposed = false;
  /** Each mesh's full geometry, kept while a subset of it is drawn. */
  readonly #sourceGeometry = new WeakMap<THREE.Mesh, THREE.BufferGeometry>();
  readonly #subsetGeometry = new Map<string, { geometry: THREE.BufferGeometry; subset: MeshSubset }>();
  /** The board as the layout code sees it; built once, its accessors read live state. */
  readonly #layoutHost: BoardLayoutHost;

  constructor(options: ShowcaseBoardOptions) {
    this.#options = options;
    // Arrow functions keep `this` on the board; the accessors read the live values on every call.
    this.#layoutHost = {
      grid: () => this.#grid,
      spacing: () => this.#spacing,
      keepApart: () => this.#keepApart,
      layoutSize: () => this.#layoutSize,
      scene: this.#scene,
      appendItem: (item) => { this.#items = [...this.#items, item]; },
      reshape: (runtime) => this.#reshape(runtime),
      problemAt: (id, x, y) => this.#problemAt(id, x, y),
      nearestFreeSpot: (id, x, y, maxRing) => this.#nearestFreeSpot(id, x, y, maxRing),
      applyTransform: (runtime) => this.#applyTransform(runtime),
      rememberValid: (runtime) => this.#rememberValid(runtime),
    };
    const renderer = new THREE.WebGLRenderer({ canvas: options.canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, LOW_END ? 1.25 : 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    // PCF shadows; the shadow map size sets the quality tier.
    renderer.shadowMap.type = THREE.PCFShadowMap;
    // Weapons allowed past the board edge are cut where the frame begins.
    renderer.localClippingEnabled = true;
    this.renderer = renderer;
    this.#compositor = new Compositor(options.resolveTexture, {
      renderer,
      size: 1024,
      textureMetadata: options.textureMetadata,
      textureMetadataResolver: options.textureMetadataResolver,
    });

    this.#boardPaints = new BoardPaints({
      options,
      renderer,
      camera: this.#camera,
      compositor: this.#compositor,
      runtimes: this.#runtimes,
      boardHeight: BOARD_HEIGHT,
      getEnvMap: () => this.#envMap,
      isDisposed: () => this.#disposed,
      markDirty: () => {
        this.#dirty = true;
        this.#requestFrame();
      },
    });
    this.#handles = new PoseHandles({ options, camera: this.#camera, runtimes: this.#runtimes });
    this.#camera.position.set(0, 0, 600);
    this.#ambient = new THREE.HemisphereLight(0xfff4e6, 0x3a3128, 1.35 * SOURCE_LIGHT_SCALE);
    this.#scene.add(this.#ambient);
    const light = new THREE.DirectionalLight(0xffffff, 2.1 * SOURCE_LIGHT_SCALE);
    this.#light = light;
    this.#placeLight(125, 55);
    light.castShadow = true;
    light.shadow.mapSize.setScalar(LOW_END ? 1024 : 2048);
    light.shadow.camera.left = -130;
    light.shadow.camera.right = 130;
    light.shadow.camera.top = 90;
    light.shadow.camera.bottom = -90;
    light.shadow.camera.near = 10;
    light.shadow.camera.far = 500;
    light.shadow.bias = -0.0004;
    light.shadow.normalBias = 0.03;
    this.#scene.add(light, light.target);
    this.#syncAmbientCube();
    loadEditorEnvCube((texture) => {
      if (this.#disposed) {
        texture.dispose();
        return;
      }
      const fallback = this.#envMap;
      this.#envMap = texture;
      for (const runtime of this.#runtimes.values()) {
        if (!runtime.customEnvMap) runtime.material.envMap = texture;
        runtime.statClock?.setEnvMap(texture);
      }
      fallback.dispose();
      this.#dirty = true;
      this.#requestFrame();
    });

    const pegboard = pegboardTexture();
    this.#board = new THREE.Mesh(
      new THREE.PlaneGeometry(BOARD_WIDTH, BOARD_HEIGHT),
      new THREE.MeshLambertMaterial({ map: pegboard, color: new THREE.Color(Math.PI, Math.PI, Math.PI) }),
    );
    this.#board.receiveShadow = true;
    this.#shadowBoard = new THREE.Mesh(
      new THREE.PlaneGeometry(BOARD_WIDTH, BOARD_HEIGHT),
      new THREE.ShadowMaterial({ opacity: 0.4 }),
    );
    this.#shadowBoard.receiveShadow = true;
    this.#shadowBoard.visible = false;
    this.#vignette = new THREE.Mesh(
      new THREE.PlaneGeometry(BOARD_WIDTH, BOARD_HEIGHT),
      new THREE.MeshBasicMaterial({ map: vignetteTexture(), transparent: true, depthWrite: false }),
    );
    this.#vignette.position.z = 0.02;
    const frameWidth = BOARD_WIDTH + FRAME_SIDE * 2;
    const frameHeight = BOARD_HEIGHT + FRAME_SIDE * 2;
    this.#frame = new THREE.Mesh(
      new THREE.PlaneGeometry(frameWidth, frameHeight),
      new THREE.MeshLambertMaterial({ map: frameTexture(frameWidth, frameHeight), color: new THREE.Color(Math.PI, Math.PI, Math.PI) }),
    );
    this.#frame.position.set(0, 0, -0.5);
    this.#scene.add(this.#frame, this.#board, this.#shadowBoard, this.#vignette);

    this.#ghost = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      // Drawn over the carried weapon so the landing spot stays readable.
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.6, depthWrite: false, depthTest: false, clippingPlanes: this.#clipPlanes }),
    );
    this.#ghost.visible = false;
    this.#ghost.renderOrder = 10;
    this.#cells = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.32, depthWrite: false }),
      MAX_CELL_MARKERS,
    );
    this.#cells.count = 0;
    this.#cells.renderOrder = 1;
    this.#cells.frustumCulled = false;
    this.#scene.add(this.#ghost, this.#cells);
    this.#applyGridTexture();


    options.canvas.addEventListener('pointerdown', this.#onPointerDown);
    options.canvas.addEventListener('pointermove', this.#onCanvasHover);
    this.#resizeObserver = new ResizeObserver(() => this.#observeResize());
    this.#resizeObserver.observe(options.canvas);
    this.#snapshot = this.#buildSnapshot();
    this.#resize();
    this.#requestFrame();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getSnapshot = (): ShowcaseSnapshot => {
    if (this.#snapshotStale) {
      this.#snapshotStale = false;
      this.#snapshot = this.#buildSnapshot();
    }
    return this.#snapshot;
  };

  /** Mark the board changed; listeners are notified once per frame, however many events arrive. */
  #emit(): void {
    this.#dirty = true;
    this.#requestFrame();
    this.#snapshotStale = true;
    this.#notifyQueued = true;
  }

  /** Unchanged parts keep their identity, so panel sections can skip re-rendering during a drag or turn. */
  #buildSnapshot(): ShowcaseSnapshot {
    const previous = this.#snapshot;
    const problemsKey = `${this.#footprintVersion}|${this.#rulesKey()}`;
    let problems = previous?.problems;
    const live = this.#liveEditId;
    if (previous && live && this.#liveRulesKey === this.#rulesKey() && previous.items.length === this.#items.length) {
      // During a rotation or pose drag only the edited weapon's fit can change; the rest is re-checked on settle.
      const liveItem = this.#items.find((item) => item.id === live);
      const problem = liveItem ? this.#problemAt(live, liveItem.x, liveItem.y) : null;
      if (JSON.stringify(previous.problems[live] ?? null) !== JSON.stringify(problem)) problems = { ...previous.problems, [live]: problem };
    } else if (!previous || previous.items !== this.#items || this.#problemsKey !== problemsKey) {
      const next: Record<string, FitProblem> = {};
      for (const item of this.#items) next[item.id] = this.#problemAt(item.id, item.x, item.y);
      problems = next;
      this.#problemsKey = problemsKey;
    }
    const pending = previous?.pending && this.#pending && previous.pending.id === this.#pending.id
      && JSON.stringify(previous.pending.problem) === JSON.stringify(this.#pending.problem) ? previous.pending : this.#pending;
    return {
      items: this.#items,
      selectedId: this.#selection.length === 1 ? this.#selection[0] : null,
      selectedIds: this.#selection,
      problems: problems ?? {},
      pending,
      dragging: !!this.#drag,
      canUndo: this.#past.length > 0 && !this.#restoring,
      canRedo: this.#future.length > 0 && !this.#restoring,
    };
  }

  #rulesKey(): string {
    return `${this.#grid}|${this.#spacing}|${this.#keepApart}|${this.#keepInside}`;
  }

  setGrid(grid: GridSize): void {
    this.#grid = grid;
    this.#applyGridTexture();
    for (const runtime of this.#runtimes.values()) this.#refreshFootprint(runtime);
    this.#emit();
  }

  setSpacing(cells: number): void {
    this.#spacing = cells;
    this.#emit();
  }

  /** Applies from the next layout. */
  setLayoutSize(fraction: number): void {
    this.#layoutSize = THREE.MathUtils.clamp(fraction, 0.5, 1);
  }

  setShowGrid(show: boolean): void {
    this.#showGrid = show;
    this.#updateCellMarkers();
  }

  setBackground(background: BoardBackground): void {
    this.#background = background;
    this.#board.visible = background !== 'transparent';
    this.#vignette.visible = background !== 'transparent';
    this.#shadowBoard.visible = background === 'transparent' && this.#shadows;
    this.#frame.visible = background === 'framed';
    this.#dirty = true;
    this.#requestFrame();
    this.#resize();
  }

  setSnap(snap: boolean): void {
    this.#snap = snap;
  }

  setKeepApart(keepApart: boolean): void {
    this.#keepApart = keepApart;
    this.#restack();
    this.#updateCellMarkers();
    this.#emit();
  }

  setKeepInside(keepInside: boolean): void {
    this.#keepInside = keepInside;
    this.#updateCellMarkers();
    this.#emit();
  }

  /** Light position on the board: azimuth 0 is the right edge and 90 the top; lower elevation gives longer shadows. */
  setLight(azimuth: number, elevation: number): void {
    this.#placeLight(azimuth, elevation);
    this.#dirty = true;
    this.#requestFrame();
  }

  /** Whether weapons cast shadows on the board. */
  setShadows(enabled: boolean): void {
    this.#shadows = enabled;
    this.#light.castShadow = enabled;
    // On a transparent background the shadows are all the board shows.
    this.#shadowBoard.visible = this.#background === 'transparent' && enabled;
    this.#dirty = true;
    this.#requestFrame();
  }

  /** 0 keeps the board evenly lit, 1 gives hard, dark shadows. */
  setShadowStrength(strength: number): void {
    this.#light.intensity = (0.8 + strength * 2.2) * SOURCE_LIGHT_SCALE;
    this.#ambient.intensity = (2.2 - strength * 1.4) * SOURCE_LIGHT_SCALE;
    this.#syncAmbientCube();
    this.#dirty = true;
    this.#requestFrame();
  }

  /** Weapons take ambient from this cube (the board's sky above, ground below) instead of three's light. */
  #syncAmbientCube(): void {
    const sky = this.#ambient.color.clone().multiplyScalar(this.#ambient.intensity);
    const ground = this.#ambient.groundColor.clone().multiplyScalar(this.#ambient.intensity);
    const side = sky.clone().lerp(ground, 0.5);
    // Source order +x, -x, +y, -y, +z, -z; board +y is up the board, +z faces the viewer.
    const faces = [side, side, sky, ground, sky.clone().lerp(side, 0.5), side];
    faces.forEach((color, index) => this.#ambientCube[index].set(color.r, color.g, color.b));
    this.#dirty = true;
    this.#requestFrame();
  }

  #placeLight(azimuth: number, elevation: number): void {
    const az = THREE.MathUtils.degToRad(azimuth);
    const el = THREE.MathUtils.degToRad(THREE.MathUtils.clamp(elevation, 15, 89));
    const distance = 230;
    this.#light.position.set(
      Math.cos(az) * Math.cos(el) * distance,
      Math.sin(az) * Math.cos(el) * distance,
      Math.sin(el) * distance,
    );
  }

  #applyGridTexture(): void {
    const map = this.#board.material.map;
    if (!map) return;
    const cell = GRID_CELL[this.#grid];
    map.repeat.set(BOARD_WIDTH / cell, BOARD_HEIGHT / cell);
    // Holes sit on the cell corners, which are the snap points.
    map.offset.set(0.5, 0.5);
    map.needsUpdate = true;
    this.#dirty = true;
    this.#requestFrame();
  }

  async addAt(weaponKey: string, paint: ShowcasePaint, x?: number, y?: number): Promise<string | null> {
    const runtime = await this.#createRuntime(weaponKey, paint);
    if (!runtime) return null;
    const spot = x !== undefined && y !== undefined ? { x, y } : this.#findFreeSpot(runtime);
    if (!spot) {
      this.#disposeRuntime(runtime);
      return null;
    }
    runtime.item.x = spot.x;
    runtime.item.y = spot.y;
    this.#commitRuntime(runtime);
    this.select(runtime.item.id);
    return runtime.item.id;
  }

  /** Start dragging a new weapon from the tray; it follows the pointer until dropped. */
  async beginExternalDrag(weaponKey: string, paint: ShowcasePaint, clientX: number, clientY: number): Promise<void> {
    this.#cancelExternalDrag();
    this.#externalRequest += 1;
    const request = this.#externalRequest;
    window.addEventListener('pointermove', this.#onWindowMove);
    window.addEventListener('pointerup', this.#onWindowUp);
    window.addEventListener('pointercancel', this.#onWindowCancel);
    this.#lastPointer = { x: clientX, y: clientY };
    this.#pendingExternal = true;
    const runtime = await this.#createRuntime(weaponKey, paint);
    if (request !== this.#externalRequest || !this.#pendingExternal || !runtime) {
      if (runtime) this.#disposeRuntime(runtime);
      return;
    }
    this.#pendingExternal = false;
    runtime.root.visible = false;
    this.#runtimes.set(runtime.item.id, runtime);
    this.#scene.add(runtime.root);
    this.#drag = { id: runtime.item.id, grabX: 0, grabY: 0, fromX: 0, fromY: 0, external: true, candidate: null };
    this.#requestFrame();
    this.select(runtime.item.id);
    this.#dragTo(this.#lastPointer.x, this.#lastPointer.y);
    if (this.#releasedWhileLoading) {
      this.#releasedWhileLoading = false;
      this.#onWindowUp();
    }
  }

  #pendingExternal = false;
  /** Counts tray drags, so one whose model arrives late cannot take over a newer drag. */
  #externalRequest = 0;
  #releasedWhileLoading = false;
  #past: HistoryEntry[] = [];
  #future: HistoryEntry[] = [];
  #committed: ShowcaseItem[] = [];
  /** What Fill lays out again; undo restores it along with the weapons. */
  #layout: AppliedLayout | null = null;
  #committedLayout: AppliedLayout | null = null;
  #restoring = false;
  #lastPointer = { x: 0, y: 0 };

  #cancelExternalDrag(): void {
    this.#pendingExternal = false;
    this.#releasedWhileLoading = false;
    window.removeEventListener('pointermove', this.#onWindowMove);
    window.removeEventListener('pointerup', this.#onWindowUp);
    window.removeEventListener('pointercancel', this.#onWindowCancel);
  }

  /** Resolves once the board is back. */
  async undo(): Promise<void> {
    if (this.#restoring) return;
    const previous = this.#past.pop();
    if (!previous) return;
    previous.sideEffect?.undo();
    this.#future.push({ items: this.#committed, layout: this.#committedLayout, sideEffect: previous.sideEffect });
    this.#layout = this.#committedLayout = previous.layout;
    await this.#restore(previous.items);
  }

  redo(): void {
    if (this.#restoring) return;
    const next = this.#future.pop();
    if (!next) return;
    next.sideEffect?.redo();
    this.#past.push({ items: this.#committed, layout: this.#committedLayout, sideEffect: next.sideEffect });
    this.#layout = this.#committedLayout = next.layout;
    void this.#restore(next.items);
  }

  #checkpoint(): void {
    if (this.#restoring) return;
    this.#flushReshapes();
    const current = this.#items.map(copyItem);
    if (JSON.stringify(current) === JSON.stringify(this.#committed)) {
      this.#committedLayout = this.#layout;
      return;
    }
    this.#past.push({ items: this.#committed, layout: this.#committedLayout });
    if (this.#past.length > HISTORY_LIMIT) this.#past.shift();
    this.#future = [];
    this.#committed = current;
    this.#committedLayout = this.#layout;
  }

  async #restore(target: ShowcaseItem[]): Promise<void> {
    this.#restoring = true;
    this.#emit();
    try {
      const wanted = new Set(target.map((item) => item.id));
      for (const runtime of [...this.#runtimes.values()]) {
        if (!wanted.has(runtime.item.id)) this.#disposeRuntime(runtime);
      }
      const items: ShowcaseItem[] = [];
      for (const saved of target) {
        let runtime = this.#runtimes.get(saved.id);
        // A removed weapon comes back under its old id, so later steps still find it.
        runtime ??= (await (saved.image ? this.#createImageRuntime(saved.image, saved.weaponName, saved.id) : this.#createRuntime(saved.weaponKey, saved.paint, saved.id, saved.part))) ?? undefined;
        if (!runtime) continue;
        runtime.item = copyItem(saved);
        void this.#applyPaint(runtime);
        if (!runtime.root.parent) this.#scene.add(runtime.root);
        this.#reshape(runtime);
        this.#rememberValid(runtime);
        items.push(runtime.item);
      }
      this.#items = items;
      this.#committed = target.map(copyItem);
      if (this.#selection.some((id) => !wanted.has(id))) this.#selection = this.#selection.filter((id) => wanted.has(id));
      this.#restack();
      this.#updateCellMarkers();
    } finally {
      this.#restoring = false;
      this.#emit();
    }
  }

  select(id: string | null): void {
    this.setSelection(id ? [id] : []);
  }

  /** Hidden or unknown weapons are left out. */
  setSelection(ids: readonly string[]): void {
    const shown = new Set(this.#items.filter((item) => !item.hidden).map((item) => item.id));
    this.#selection = [...new Set(ids)].filter((id) => shown.has(id));
    this.#updateCellMarkers();
    this.#emit();
  }

  toggleSelected(id: string): void {
    this.setSelection(this.#selection.includes(id) ? this.#selection.filter((entry) => entry !== id) : [...this.#selection, id]);
  }

  removeMany(ids: readonly string[]): void {
    const doomed = new Set(ids);
    const runtimes = [...doomed].map((id) => this.#runtimes.get(id)).filter((runtime): runtime is ItemRuntime => !!runtime);
    if (!runtimes.length) return;
    this.#selection = this.#selection.filter((id) => !doomed.has(id));
    this.#items = this.#items.filter((item) => !doomed.has(item.id));
    for (const runtime of runtimes) this.#disposeRuntime(runtime);
    this.#restack();
    this.#checkpoint();
    this.#updateCellMarkers();
    this.#emit();
  }

  setHiddenMany(ids: readonly string[], hidden: boolean): void {
    const runtimes = ids.map((id) => this.#runtimes.get(id)).filter((runtime): runtime is ItemRuntime => !!runtime);
    if (!runtimes.length) return;
    for (const runtime of runtimes) {
      runtime.item.hidden = hidden;
      this.#replaceItem(runtime);
      this.#applyTransform(runtime);
    }
    if (hidden) this.#selection = this.#selection.filter((id) => !ids.includes(id));
    this.#restack();
    this.#checkpoint();
    this.#updateCellMarkers();
    this.#emit();
  }

  setPaintMany(ids: readonly string[], patch: Partial<ShowcasePaint> | ((paint: ShowcasePaint) => Partial<ShowcasePaint>)): void {
    const runtimes = ids.map((id) => this.#runtimes.get(id)).filter((runtime): runtime is ItemRuntime => !!runtime && !runtime.item.image);
    if (!runtimes.length) return;
    for (const runtime of runtimes) {
      const change = typeof patch === 'function' ? patch(runtime.item.paint) : patch;
      runtime.item = { ...runtime.item, paint: { ...runtime.item.paint, ...change } };
      void this.#applyPaint(runtime);
      this.#syncStatClock(runtime);
    }
    const changed = new Map(runtimes.map((runtime) => [runtime.item.id, runtime.item]));
    this.#items = this.#items.map((item) => changed.get(item.id) ?? item);
    this.#checkpoint();
    this.#emit();
  }

  /** A live edit; settleMany() then keeps it or puts them all back. */
  updateMany(ids: readonly string[], patch: ManyPatch | ((item: ShowcaseItem) => ManyPatch)): void {
    this.#groupEditing = true;
    for (const id of ids) {
      const runtime = this.#runtimes.get(id);
      if (!runtime) continue;
      Object.assign(runtime.item, typeof patch === 'function' ? patch(runtime.item) : patch);
      this.#limitAngles(runtime.item);
      this.#applyTransform(runtime);
      this.#replaceItem(runtime);
      this.#reshapeQueue.add(id);
    }
    // Any of them can stop fitting, so the snapshot checks the whole board rather than one live weapon.
    this.#liveEditId = null;
    this.#requestFrame();
    this.#emit();
  }

  settleMany(ids: readonly string[]): void {
    this.#flushReshapes();
    this.#groupEditing = false;
    this.#liveEditId = null;
    const runtimes = ids.map((id) => this.#runtimes.get(id)).filter((runtime): runtime is ItemRuntime => !!runtime);
    if (!runtimes.length) return;
    if (runtimes.some((runtime) => this.#problemAt(runtime.item.id, runtime.item.x, runtime.item.y))) {
      for (const runtime of runtimes) {
        const valid = this.#lastValid.get(runtime.item.id);
        if (!valid) continue;
        Object.assign(runtime.item, valid, { pose: { ...valid.pose } });
        this.#reshape(runtime);
        this.#replaceItem(runtime);
      }
      this.#restack();
    } else {
      for (const runtime of runtimes) this.#rememberValid(runtime);
    }
    this.#pending = null;
    this.#checkpoint();
    this.#updateCellMarkers();
    this.#sharpenPaints();
    this.#emit();
  }

  rotateMany(ids: readonly string[], degrees: number): void {
    this.updateMany(ids, (item) => ({ roll: wrapRoll(item.roll + degrees) }));
    this.settleMany(ids);
  }

  flipMany(ids: readonly string[]): void {
    this.updateMany(ids, (item) => ({ flipped: !item.flipped }));
    this.settleMany(ids);
  }

  nudgeMany(ids: readonly string[], dx: number, dy: number): void {
    this.#flushReshapes();
    const group = new Set(ids);
    const runtimes = [...group].map((id) => this.#runtimes.get(id)).filter((runtime): runtime is ItemRuntime => !!runtime);
    if (!runtimes.length) return;
    const cell = GRID_CELL[this.#grid];
    // The group keeps its own spacing, so only the rest of the board can block it.
    if (runtimes.some((runtime) => this.#problemAt(runtime.item.id, runtime.item.x + dx * cell, runtime.item.y + dy * cell, group))) return;
    for (const runtime of runtimes) {
      runtime.item.x += dx * cell;
      runtime.item.y += dy * cell;
      this.#replaceItem(runtime);
    }
    this.#restack();
    this.#checkpoint();
    this.#updateCellMarkers();
    this.#emit();
  }

  update(id: string, patch: Partial<Pick<ShowcaseItem, 'roll' | 'tilt' | 'turn' | 'flipped' | 'scale' | 'pose'>>): void {
    const runtime = this.#runtimes.get(id);
    if (!runtime) return;
    Object.assign(runtime.item, patch);
    this.#limitAngles(runtime.item);
    // The weapon turns right away; its footprint and fit follow on the next frame.
    this.#applyTransform(runtime);
    this.#replaceItem(runtime);
    this.#reshapeQueue.add(id);
    this.#requestFrame();
    if (this.#liveEditId !== id) {
      // Start from a fully checked board, then track just this weapon.
      this.#liveEditId = null;
      this.#snapshotStale = true;
      this.getSnapshot();
      this.#liveEditId = id;
      this.#liveRulesKey = this.#rulesKey();
    }
    this.#emit();
  }

  /** Pictures always lie flat. */
  #limitAngles(item: ShowcaseItem): void {
    const limit = item.image ? 0 : TILT_LIMIT;
    item.tilt = THREE.MathUtils.clamp(item.tilt, -limit, limit);
    item.turn = THREE.MathUtils.clamp(item.turn, -limit, limit);
  }

  /** Re-measure everything edited since the last frame, then re-check the fit once. */
  #flushReshapes(): void {
    if (!this.#reshapeQueue.size) return;
    let lastId: string | null = null;
    for (const id of this.#reshapeQueue) {
      const runtime = this.#runtimes.get(id);
      if (!runtime) continue;
      this.#reshape(runtime);
      lastId = id;
    }
    this.#reshapeQueue.clear();
    this.#restack();
    const runtime = lastId ? this.#runtimes.get(lastId) : undefined;
    if (runtime && lastId) {
      const problem = this.#problemAt(lastId, runtime.item.x, runtime.item.y);
      // A group only becomes valid together, which settleMany decides.
      if (!problem && !this.#groupEditing) this.#rememberValid(runtime);
      this.#pending = problem ? { id: lastId, problem } : null;
    }
    this.#updateCellMarkers();
    this.#emit();
  }

  /** Turn by a step. A carried weapon turns in hand (its fit is checked on drop); one on the board settles, springing back if the turn does not fit. */
  rotateBy(id: string, degrees: number): void {
    const runtime = this.#runtimes.get(id);
    // A carried group keeps its shape until it lands.
    if (!runtime || this.#drag?.group) return;
    const roll = wrapRoll(runtime.item.roll + degrees);
    if (this.#drag?.id === id) {
      runtime.item.roll = roll;
      this.#reshape(runtime);
      this.#replaceItem(runtime);
      this.#dragTo(this.#lastPointer.x, this.#lastPointer.y);
      return;
    }
    this.update(id, { roll });
    this.settle(id);
  }

  /** The weapon being carried, if any; keyboard rotation applies to it first. */
  get heldId(): string | null {
    return this.#drag?.id ?? null;
  }

  nudge(id: string, dx: number, dy: number): void {
    this.#flushReshapes();
    const runtime = this.#runtimes.get(id);
    if (!runtime) return;
    const cell = GRID_CELL[this.#grid];
    const x = runtime.item.x + dx * cell;
    const y = runtime.item.y + dy * cell;
    if (this.#problemAt(id, x, y)) return;
    runtime.item.x = x;
    runtime.item.y = y;
    this.#replaceItem(runtime);
    this.#restack();
    this.#checkpoint();
    this.#updateCellMarkers();
    this.#emit();
  }

  remove(id: string): void {
    const runtime = this.#runtimes.get(id);
    if (!runtime) return;
    if (this.#selection.includes(id)) this.setSelection(this.#selection.filter((entry) => entry !== id));
    this.#items = this.#items.filter((item) => item.id !== id);
    this.#disposeRuntime(runtime);
    this.#restack();
    this.#checkpoint();
    this.#emit();
  }

  async duplicate(id: string): Promise<void> {
    const source = this.#runtimes.get(id)?.item;
    if (!source) return;
    const runtime = await (source.image ? this.#createImageRuntime(source.image, source.weaponName) : this.#createRuntime(source.weaponKey, source.paint, undefined, source.part));
    if (!runtime) return;
    Object.assign(runtime.item, { roll: source.roll, tilt: source.tilt, turn: source.turn, flipped: source.flipped, scale: source.scale, pose: { ...source.pose }, hiddenParts: [...source.hiddenParts] });
    if (source.statClock !== undefined) runtime.item.statClock = source.statClock;
    if (source.killCount !== undefined) runtime.item.killCount = source.killCount;
    this.#reshape(runtime);
    // Pictures may overlap, so a free spot would just be the board's corner; one step along shows there are two.
    const beside = { x: source.x + GRID_CELL[this.#grid] * 2, y: source.y - GRID_CELL[this.#grid] * 2 };
    const spot = !source.image ? this.#findFreeSpot(runtime)
      : this.#problemAt(runtime.item.id, beside.x, beside.y) ? this.#nearestFreeSpot(runtime.item.id, beside.x, beside.y) : beside;
    if (!spot) {
      this.#disposeRuntime(runtime);
      return;
    }
    runtime.item.x = spot.x;
    runtime.item.y = spot.y;
    this.#commitRuntime(runtime);
    this.select(runtime.item.id);
  }

  /** Puts a saved board back as the starting point, so undo cannot step to the empty board before it. */
  async load(items: readonly ShowcaseItem[], savedImages: ReadonlySet<string> = new Set()): Promise<void> {
    // Saved ids came from an earlier session's counter; new weapons must not reuse them.
    for (const item of items) {
      const saved = Number(/^item-(\d+)$/.exec(item.id)?.[1]);
      if (Number.isSafeInteger(saved)) idCounter = Math.max(idCounter, saved);
    }
    this.#past = [];
    this.#future = [];
    this.#layout = this.#committedLayout = null;
    await this.#restore(items.map(copyItem));
    const keep = new Set([...savedImages, ...items.flatMap((item) => (item.image ? [item.image.assetId] : []))]);
    void pruneBoardImages(keep).catch((cause: unknown) => console.error('[showcase] could not clean up saved images', cause));
  }

  /** The ready-made layout on the board, if any, for saving along with its weapons. */
  get appliedLayout(): AppliedLayout | null {
    return this.#layout;
  }

  /** Replaces the board with a saved one as one undo step, along with whatever else `sideEffect` covers. */
  async replaceWith(items: readonly ShowcaseItem[], layout: AppliedLayout | null, sideEffect?: BoardEditSideEffect): Promise<void> {
    if (this.#restoring) return;
    // A layout or picture still loading would otherwise land on the restored board.
    this.#layoutRequest += 1;
    this.#clears += 1;
    this.#cancelExternalDrag();
    this.#drag = null;
    this.select(null);
    this.#flushReshapes();
    this.#past.push({ items: this.#committed, layout: this.#committedLayout, sideEffect });
    if (this.#past.length > HISTORY_LIMIT) this.#past.shift();
    this.#future = [];
    this.#layout = this.#committedLayout = layout;
    // Fresh ids: a save's ids can belong to other weapons by now, and #restore would reuse those weapons' models.
    await this.#restore(items.map((item) => ({ ...copyItem(item), id: `item-${(idCounter += 1)}` })));
  }

  /** Puts a picture in the middle of the board, sized to the space a logo layout leaves. Rejects when the file is not an image. */
  async addImage(file: Blob, name: string): Promise<void> {
    const clears = this.#clears;
    const image = await this.importImage(file);
    const runtime = await this.#createImageRuntime(image, name);
    if (!runtime) throw new Error('could not load the image');
    if (clears !== this.#clears) {
      this.#disposeRuntime(runtime);
      return;
    }
    this.#commitRuntime(runtime);
    this.select(runtime.item.id);
    this.#updateCellMarkers();
    this.#emit();
  }

  /** Stores a picture under a new id without placing it. Rejects when the file is not an image. */
  async importImage(file: Blob): Promise<NonNullable<ShowcaseItem['image']>> {
    const { blob, aspect } = await prepareBoardImage(file);
    const assetId = crypto.randomUUID();
    this.#imageAssets.set(assetId, this.#loadImageAsset(assetId, blob));
    // Without storage the picture still works for this session.
    await saveBoardImage(assetId, blob).catch((cause: unknown) => console.error('[showcase] could not save the image', cause));
    return { assetId, aspect };
  }

  /** A picture's bytes, for sharing it: from storage, or from this session when storage failed. */
  async imageFile(assetId: string): Promise<Blob | null> {
    const stored = await readBoardImage(assetId).catch(() => null);
    if (stored) return stored;
    const url = this.#imageUrls.get(assetId);
    return url ? (await fetch(url)).blob() : null;
  }

  /** The picture's own address, for showing it in the layer list. */
  imageUrl(assetId: string): string | undefined {
    return this.#imageUrls.get(assetId);
  }

  async #loadImageAsset(assetId: string, blob: Blob): Promise<{ url: string; texture: THREE.Texture } | null> {
    const url = URL.createObjectURL(blob);
    this.#imageUrls.set(assetId, url);
    const texture = await new THREE.TextureLoader().loadAsync(url);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 8;
    return { url, texture };
  }

  /** An autosaved picture whose file is gone gives null, and it drops off the board. */
  #imageAsset(assetId: string): Promise<{ url: string; texture: THREE.Texture } | null> {
    let pending = this.#imageAssets.get(assetId);
    if (!pending) {
      pending = readBoardImage(assetId).then((blob) => (blob ? this.#loadImageAsset(assetId, blob) : null)).catch((cause: unknown) => {
        console.error('[showcase] could not load a saved image', cause);
        return null;
      });
      this.#imageAssets.set(assetId, pending);
    }
    return pending;
  }

  /** Built like a weapon, so moving, turning, selecting, stacking and undo all treat it as one. */
  async #createImageRuntime(image: NonNullable<ShowcaseItem['image']>, name: string, id?: string): Promise<ItemRuntime | null> {
    const asset = await this.#imageAsset(image.assetId);
    if (!asset || this.#disposed) return null;
    const fit = Math.min(LOGO_SPACE.width / image.aspect, LOGO_SPACE.height) / BASE_SCALE;
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(fit * image.aspect, fit),
      // Unlit, so a logo keeps its own colors whatever the board's light does.
      new THREE.MeshBasicMaterial({ map: asset.texture, transparent: true, depthWrite: false, side: THREE.DoubleSide, clippingPlanes: this.#clipPlanes }),
    );
    const item: ShowcaseItem = {
      id: id ?? `item-${(idCounter += 1)}`, weaponKey: '', weaponName: name, paint: IMAGE_PAINT, x: 0, y: 0, roll: 0, tilt: 0, turn: 0, flipped: false, scale: 1, hidden: false, pose: {}, part: null, hiddenParts: [], image,
    };
    const uniforms = createTf2Uniforms();
    // Never drawn: the runtime's material is for weapons, and the plane has its own.
    const material = new THREE.MeshPhongMaterial();
    const runtime: ItemRuntime = { item, root: new THREE.Group(), orient: new THREE.Group(), meshes: [mesh], bones: new Map(), footprint: null, material, uniforms, materialKey: '', emissive: null, lenses: new Set(), statClock: null, clockParent: mesh, stackZ: 0, local: null, paintKey: '', materialReady: Promise.resolve(), materialRequest: 0, paintSize: 0, visibility: '', subsets: [] };
    const flip = new THREE.Group();
    flip.name = 'flip';
    flip.add(mesh);
    runtime.orient.rotation.order = 'ZXY';
    runtime.orient.add(flip);
    runtime.root.add(runtime.orient);
    this.#runtimes.set(item.id, runtime);
    this.#applyTransform(runtime);
    this.#refreshFootprint(runtime);
    return runtime;
  }

  clear(): void {
    // A layout or picture still loading would otherwise land on the cleared board.
    this.#layoutRequest += 1;
    this.#clears += 1;
    this.#layout = null;
    this.select(null);
    for (const runtime of [...this.#runtimes.values()]) this.#disposeRuntime(runtime);
    this.#items = [];
    this.#checkpoint();
    this.#emit();
  }

  #layoutRequest = 0;
  #clears = 0;

  /** Replace the board with a layout as one undo step; all weapons share the one size that fills the board. */
  async applyLayout(rows: LayoutRows, pack?: LayoutPacking, inward = false, upright = false, logoSpace = false): Promise<void> {
    const request = (this.#layoutRequest += 1);
    const loaded = await Promise.all(rows.map((row) => Promise.all(row.map((slot) => this.#createRuntime(slot.weaponKey, slot.paint, undefined, null, true)))));
    const groups = loaded.map((row) => row.filter((runtime): runtime is ItemRuntime => !!runtime)).filter((row) => row.length > 0);
    if (request !== this.#layoutRequest || this.#disposed) {
      // A newer layout was picked while this one loaded.
      for (const runtime of groups.flat()) this.#disposeRuntime(runtime);
      return;
    }
    this.#cancelExternalDrag();
    this.#drag = null;
    this.select(null);
    const keep = new Set(groups.flat());
    // A layout replaces the weapons; a logo already on the board stays where it is.
    for (const runtime of [...this.#runtimes.values()]) if (!keep.has(runtime) && !runtime.item.image) this.#disposeRuntime(runtime);
    this.#items = this.#items.filter((item) => item.image);
    if (pack === 'composed') compose(this.#layoutHost, groups.flat(), logoSpace);
    else if (groups.length) arrange(this.#layoutHost, groups, pack, inward, upright);
    // Painted once at their final size, so none composes at 100% only to shrink.
    for (const runtime of groups.flat()) void this.#applyPaint(runtime);
    this.#layout = { rows, pack, inward, upright, logoSpace };
    this.#restack();
    this.#checkpoint();
    this.#updateCellMarkers();
    this.#emit();
  }

  async reapplyLayout(): Promise<void> {
    if (!this.#layout || !this.#items.some((item) => !item.image)) return;
    const { rows, pack, inward, upright, logoSpace } = this.#layout;
    await this.applyLayout(rows, pack, inward, upright, logoSpace);
  }

  /** Change one item's paint, wear, team or pattern seed, as one undo step. */
  setPaint(id: string, patch: Partial<ShowcasePaint>): void {
    const runtime = this.#runtimes.get(id);
    if (!runtime || runtime.item.image) return;
    runtime.item = { ...runtime.item, paint: { ...runtime.item.paint, ...patch } };
    this.#items = this.#items.map((item) => (item.id === id ? runtime.item : item));
    void this.#applyPaint(runtime);
    this.#syncStatClock(runtime);
    this.#checkpoint();
    this.#emit();
  }

  setStatClockMany(ids: readonly string[], patch: Pick<ShowcaseItem, 'statClock' | 'killCount'>): void {
    const runtimes = ids.map((id) => this.#runtimes.get(id)).filter((runtime): runtime is ItemRuntime => !!runtime && !runtime.item.image && !runtime.item.part && supportsStatClock(runtime.item.weaponKey));
    if (!runtimes.length) return;
    for (const runtime of runtimes) {
      runtime.item = { ...runtime.item, ...patch };
      this.#syncStatClock(runtime);
    }
    const changed = new Map(runtimes.map((runtime) => [runtime.item.id, runtime.item]));
    this.#items = this.#items.map((item) => changed.get(item.id) ?? item);
    this.#checkpoint();
    this.#emit();
  }

  /** Runs on every reshape, so it costs nothing until a weapon has had a clock. */
  #syncStatClock(runtime: ItemRuntime): void {
    const { item } = runtime;
    const on = !!item.statClock && !item.image && !item.part;
    if (!on && !runtime.statClock) return;
    runtime.statClock ??= new StatClock({
      programKey: 'showcase',
      lighting: runtime.uniforms,
      envMap: this.#envMap,
      clippingPlanes: this.#clipPlanes,
      castShadow: true,
      invalidate: () => {
        this.#dirty = true;
        this.#requestFrame();
      },
    });
    runtime.statClock.attachTo(runtime.clockParent, item.weaponKey, runtime.bones.has('c_weapon_stattrack'));
    runtime.statClock.set(on ? { team: item.paint.team, kills: item.killCount ?? DEFAULT_KILLS } : null);
  }

  #replaceItem(runtime: ItemRuntime): void {
    runtime.item = { ...runtime.item, pose: { ...runtime.item.pose } };
    this.#items = this.#items.map((item) => (item.id === runtime.item.id ? runtime.item : item));
  }

  #commitRuntime(runtime: ItemRuntime): void {
    this.#runtimes.set(runtime.item.id, runtime);
    if (!runtime.root.parent) this.#scene.add(runtime.root);
    runtime.root.visible = true;
    this.#applyTransform(runtime);
    this.#rememberValid(runtime);
    this.#items = [...this.#items, runtime.item];
    this.#restack();
    this.#checkpoint();
  }

  #loadModel(weapon: WeaponEntry): Promise<GLTF> {
    const url = this.#options.modelUrl(weapon, isRigged(weapon.key));
    let pending = this.#gltfs.get(url);
    if (!pending) {
      pending = this.#loader.loadAsync(url);
      this.#gltfs.set(url, pending);
    }
    return pending;
  }

  /** Load a layout's models, recipes and sources ahead of a click, such as while the pointer rests on its button. */
  preload(rows: LayoutRows): void {
    const paints = new Set<string>();
    for (const { weaponKey, paint } of rows.flat()) {
      const weapon = this.#options.weapons.find((entry) => entry.key === weaponKey);
      if (!weapon) continue;
      void this.#loadModel(weapon).catch(() => null);
      const key = `${paint.kitId}|${weaponKey}|${paint.team}|${paint.wearIndex}|${paint.seed}`;
      if (paints.has(key)) continue;
      paints.add(key);
      void this.#options.resolveRecipe(paint.kitId, weaponKey, paint.team, paint.wearIndex).then((recipe) => {
        if (recipe && !this.#disposed) this.#compositor.prefetchSources(recipe, paint.seed, MIN_SOURCE_SIZE);
      }).catch(() => null);
    }
  }

  /** `deferPaint` leaves painting to the caller, for weapons about to be resized. */
  async #createRuntime(weaponKey: string, paint: ShowcasePaint, id?: string, partId: string | null = null, deferPaint = false): Promise<ItemRuntime | null> {
    const weapon = this.#options.weapons.find((entry) => entry.key === weaponKey);
    if (!weapon) return null;
    const part = partOf(weaponKey, partId);
    if (partId && !part) return null;
    try {
      const gltf = await this.#loadModel(weapon);
      if (this.#disposed) return null;
      const model = cloneSkinned(gltf.scene);
      const uniforms = createTf2Uniforms();
      // Shared, so changing the board's ambient light reaches every weapon at once.
      uniforms.uTf2AmbientCube.value = this.#ambientCube;
      const material = makeTf2Material(uniforms, this.#envMap);
      material.clippingPlanes = this.#clipPlanes;
      const meshes: THREE.Mesh[] = [];
      const lenses = new Set<THREE.Mesh>();
      const bones = new Map<string, RestBone>();
      model.updateMatrixWorld(true);
      const modelInverse = model.getWorldQuaternion(new THREE.Quaternion()).invert();
      model.traverse((object) => {
        if (object instanceof THREE.Bone) {
          const restInModel = modelInverse.clone().multiply(object.getWorldQuaternion(new THREE.Quaternion()));
          bones.set(object.name, { bone: object, position: object.position.clone(), quaternion: object.quaternion.clone(), modelInverse: restInModel.invert(), base: null });
        }
        if (object instanceof THREE.Mesh) {
          const sourceMaterial: THREE.Material | THREE.Material[] = object.material;
          if (!Array.isArray(sourceMaterial) && /(?:^|_)lens(?:$|_)/i.test(sourceMaterial.name)) lenses.add(object);
          object.material = material;
          object.castShadow = true;
          object.receiveShadow = true;
          object.frustumCulled = false;
          meshes.push(object);
        }
      });
      for (const mesh of meshes) if (mesh instanceof THREE.SkinnedMesh) findPartBases(mesh, bones);
      const item: ShowcaseItem = {
        id: id ?? `item-${(idCounter += 1)}`,
        weaponKey,
        weaponName: part ? `${weapon.name} ${part.label.toLowerCase()}` : weapon.name,
        paint,
        x: 0,
        y: 0,
        roll: restingRoll(weaponKey, part?.id ?? null),
        tilt: 0,
        turn: 0,
        flipped: shownSideFlip(weaponKey, part?.id ?? null) ?? false,
        scale: 1,
        hidden: false,
        pose: part ? {} : defaultPose(weaponKey),
        part: part?.id ?? null,
        hiddenParts: [],
      };
      const runtime: ItemRuntime = { item, root: new THREE.Group(), orient: new THREE.Group(), meshes, bones, footprint: null, material, uniforms, materialKey: '', emissive: null, lenses, statClock: null, clockParent: bones.get('c_weapon_stattrack')?.bone ?? model, stackZ: 0, local: null, paintKey: '', materialReady: Promise.resolve(), materialRequest: 0, paintSize: 0, visibility: '', subsets: [] };
      this.#syncVisibility(runtime);
      // Measured on what is drawn, so a loose reload piece beside the weapon does not shift its centre.
      model.updateMatrixWorld(true);
      const box = new THREE.Box3();
      const corner = new THREE.Vector3();
      meshes.forEach((mesh, meshIndex) => {
        const positions = posedPositions(mesh, mesh.matrixWorld, runtime.subsets[meshIndex]?.used ?? null);
        for (let index = 0; index < positions.length; index += 3) box.expandByPoint(corner.fromArray(positions, index));
      });
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const base = new THREE.Group();
      base.quaternion.copy(baseOrientation(weapon, size));
      const centered = new THREE.Group();
      centered.position.copy(center).negate();
      centered.add(model);
      base.add(centered);
      const flip = new THREE.Group();
      flip.name = 'flip';
      flip.add(base);
      const { orient, root } = runtime;
      orient.rotation.order = 'ZXY';
      orient.add(flip);
      root.add(orient);
      // Registered before it is committed so the fit rules can see its footprint.
      this.#runtimes.set(item.id, runtime);
      this.#applyTransform(runtime);
      this.#refreshFootprint(runtime);
      if (!deferPaint) void this.#applyPaint(runtime);
      return runtime;
    } catch (cause) {
      console.error('[showcase] failed to load weapon', weaponKey, cause);
      return null;
    }
  }

  /** A taken-out piece draws only its own triangles; a weapon leaves out its loose and taken-out pieces. */
  #syncVisibility(runtime: ItemRuntime): void {
    const { item } = runtime;
    const part = partOf(item.weaponKey, item.part);
    const parts = WEAPON_PARTS[item.weaponKey] ?? [];
    const selected = part ? [part] : parts.filter((entry) => entry.loose || item.hiddenParts.includes(entry.id));
    const key = `${part ? 'keep' : 'drop'}:${selected.map((entry) => entry.id).sort().join(',')}`;
    if (key === runtime.visibility) return;
    runtime.visibility = key;
    runtime.local = null;
    runtime.subsets = runtime.meshes.map((mesh) => {
      const source = this.#sourceGeometry.get(mesh) ?? mesh.geometry;
      this.#sourceGeometry.set(mesh, source);
      if (!(mesh instanceof THREE.SkinnedMesh) || !selected.length) {
        mesh.geometry = source;
        return null;
      }
      // Subsets share the vertex buffers and only swap the index, and they are
      // kept per variant: disposing one would free buffers its siblings use.
      const cacheKey = `${source.uuid}|${key}`;
      let cached = this.#subsetGeometry.get(cacheKey);
      if (!cached) {
        mesh.geometry = source;
        const subset = partSubset(mesh, selected, !!part);
        const geometry = new THREE.BufferGeometry();
        for (const [name, attribute] of Object.entries(source.attributes)) geometry.setAttribute(name, attribute);
        geometry.setIndex(new THREE.BufferAttribute(subset.drawIndex, 1));
        cached = { geometry, subset };
        this.#subsetGeometry.set(cacheKey, cached);
      }
      mesh.geometry = cached.geometry;
      return cached.subset;
    });
    this.#boardPaints.syncEmissiveGeometry(runtime);
    this.#dirty = true;
    this.#requestFrame();
  }

  /** Show or leave out a piece of a weapon. */
  setPartShown(id: string, partId: string, shown: boolean): void {
    const runtime = this.#runtimes.get(id);
    if (!runtime || !partOf(runtime.item.weaponKey, partId)) return;
    const hiddenParts = runtime.item.hiddenParts.filter((entry) => entry !== partId);
    runtime.item.hiddenParts = shown ? hiddenParts : [...hiddenParts, partId];
    this.#replaceItem(runtime);
    this.#reshape(runtime);
    this.#restack();
    this.#checkpoint();
    this.#updateCellMarkers();
    this.#emit();
  }

  /** Take a piece out of a weapon and put it on the board next to it, as one step. */
  async pullOutPart(id: string, partId: string): Promise<void> {
    const source = this.#runtimes.get(id);
    const part = source ? partOf(source.item.weaponKey, partId) : null;
    if (!source || !part) return;
    const runtime = await this.#createRuntime(source.item.weaponKey, source.item.paint, undefined, part.id);
    if (!runtime || !this.#runtimes.has(id)) {
      if (runtime) this.#disposeRuntime(runtime);
      return;
    }
    runtime.item.scale = source.item.scale;
    this.#reshape(runtime);
    const below = source.footprint ? source.item.y + source.footprint.originY - (runtime.footprint?.height ?? 0) / 2 : source.item.y;
    const spot = this.#nearestFreeSpot(runtime.item.id, source.item.x, below) ?? this.#findFreeSpot(runtime);
    if (!spot) {
      this.#disposeRuntime(runtime);
      return;
    }
    runtime.item.x = spot.x;
    runtime.item.y = spot.y;
    if (!part.loose && !source.item.hiddenParts.includes(part.id)) {
      source.item.hiddenParts = [...source.item.hiddenParts, part.id];
      this.#replaceItem(source);
      this.#reshape(source);
    }
    this.#commitRuntime(runtime);
    this.select(runtime.item.id);
  }

  #pixelsPerUnit(): number { return this.#boardPaints.pixelsPerUnit(); }

  #sharpenPaints(pixelsPerUnit?: number): void { this.#boardPaints.sharpenPaints(pixelsPerUnit); }

  #applyPaint(runtime: ItemRuntime, pixelsPerUnit?: number): Promise<void> { return this.#boardPaints.applyPaint(runtime, pixelsPerUnit); }

  #releaseRetiredPaints(): void { this.#boardPaints.releaseRetiredPaints(); }

  #sweepPaints(): void { this.#boardPaints.sweepPaints(); }

  #applyTransform(runtime: ItemRuntime): void {
    const { item, orient, root } = runtime;
    orient.rotation.set(
      THREE.MathUtils.degToRad(item.tilt),
      THREE.MathUtils.degToRad(item.turn),
      THREE.MathUtils.degToRad(item.roll),
      'ZXY',
    );
    const flip = orient.getObjectByName('flip');
    if (flip) flip.rotation.y = item.flipped ? Math.PI : 0;
    orient.scale.setScalar(item.scale * BASE_SCALE);
    root.visible = !item.hidden;
    const rig = item.part ? undefined : POSE_RIGS[item.weaponKey];
    if (rig) rig.apply(runtime.bones, item.pose);
    root.position.set(item.x, item.y, runtime.stackZ + (item.image ? IMAGE_LIFT : (runtime.footprint ? -runtime.footprint.minZ : 4) + RESTING_LIFT));
  }

  /** Re-pose and re-measure: the resting height depends on the new footprint's depth. */
  #reshape(runtime: ItemRuntime): void {
    this.#syncStatClock(runtime);
    this.#syncVisibility(runtime);
    this.#applyTransform(runtime);
    this.#refreshFootprint(runtime);
    this.#applyTransform(runtime);
  }

  #topOf(runtime: ItemRuntime): number {
    const footprint = runtime.footprint;
    if (runtime.item.image) return runtime.stackZ + IMAGE_THICKNESS;
    return footprint ? runtime.stackZ + footprint.maxZ - footprint.minZ + RESTING_LIFT : 0;
  }

  #overlaps(a: ItemRuntime, b: ItemRuntime): boolean {
    if (!a.footprint || !b.footprint) return false;
    const cell = GRID_CELL[this.#grid];
    const di = Math.round(a.item.x / cell) - Math.round(b.item.x / cell);
    const dj = Math.round(a.item.y / cell) - Math.round(b.item.y / cell);
    for (const key of a.footprint.cells) {
      if (b.footprint.cells.has(cellKey(keyI(key) + di, keyJ(key) + dj))) return true;
    }
    return false;
  }

  /** With overlaps allowed, later weapons rest on the earlier ones they cover; board order is stacking order. */
  #restack(): void {
    const placed: ItemRuntime[] = [];
    for (const item of this.#items) {
      const runtime = this.#runtimes.get(item.id);
      if (!runtime || item.hidden) continue;
      runtime.stackZ = 0;
      for (const below of placed) {
        // Keeping apart only spares weapons from resting on each other; pictures always stack in order.
        const stacks = !this.#keepApart || (item.image && below.item.image);
        if (stacks && this.#overlaps(runtime, below)) runtime.stackZ = Math.max(runtime.stackZ, this.#topOf(below));
      }
      this.#applyTransform(runtime);
      placed.push(runtime);
    }
  }

  /** Move a layer to a new place in the stacking order (0 is the back). */
  reorder(id: string, index: number): void {
    const item = this.#items.find((entry) => entry.id === id);
    if (!item) return;
    const rest = this.#items.filter((entry) => entry.id !== id);
    rest.splice(Math.max(0, Math.min(rest.length, index)), 0, item);
    this.#items = rest;
    this.#restack();
    this.#checkpoint();
    this.#emit();
  }

  setHidden(id: string, hidden: boolean): void {
    const runtime = this.#runtimes.get(id);
    if (!runtime) return;
    runtime.item.hidden = hidden;
    this.#replaceItem(runtime);
    this.#applyTransform(runtime);
    if (hidden) this.#selection = this.#selection.filter((entry) => entry !== id);
    this.#restack();
    this.#checkpoint();
    this.#updateCellMarkers();
    this.#emit();
  }

  #disposeRuntime(runtime: ItemRuntime): void {
    runtime.root.removeFromParent();
    runtime.material.dispose();
    runtime.statClock?.dispose();
    this.#boardPaints.removeEmissive(runtime);
    if (runtime.item.image) {
      for (const mesh of runtime.meshes) {
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
      }
    }
    this.#runtimes.delete(runtime.item.id);
    this.#releaseRetiredPaints();
    this.#sweepPaints();
  }

  #refreshFootprint(runtime: ItemRuntime): void {
    refreshFootprint(runtime, GRID_CELL[this.#grid], () => (this.#footprintVersion += 1));
  }

  /** `ignore` leaves out weapons moving with this one. */
  #problemAt(id: string, x: number, y: number, ignore?: ReadonlySet<string>): FitProblem {
    const runtime = this.#runtimes.get(id);
    const footprint = runtime?.footprint;
    if (!footprint) return null;
    const cell = GRID_CELL[this.#grid];
    const offsetI = Math.round(x / cell);
    const offsetJ = Math.round(y / cell);
    const halfW = Math.floor(BOARD_WIDTH / cell / 2);
    const halfH = Math.floor(BOARD_HEIGHT / cell / 2);
    if (this.#keepInside) {
      for (const key of footprint.solid) {
        const i = keyI(key) + offsetI;
        const j = keyJ(key) + offsetJ;
        if (i < -halfW || i >= halfW || j < -halfH || j >= halfH) return { kind: 'outside' };
      }
    } else if (Math.abs(x) > BOARD_WIDTH / 2 || Math.abs(y) > BOARD_HEIGHT / 2) {
      // Parts may hang past the edge, but the weapon itself stays on the board.
      return { kind: 'outside' };
    }
    // Keeping apart is for weapons; a logo may lie under or near them.
    if (!this.#keepApart || runtime.item.image) return null;
    for (const other of this.#items) {
      if (other.id === id || other.hidden || other.image || ignore?.has(other.id)) continue;
      const otherRuntime = this.#runtimes.get(other.id);
      if (!otherRuntime?.footprint) continue;
      const otherI = Math.round(other.x / cell);
      const otherJ = Math.round(other.y / cell);
      const occupied = otherRuntime.footprint.cells;
      for (const key of footprint.cells) {
        const i = keyI(key) + offsetI - otherI;
        const j = keyJ(key) + offsetJ - otherJ;
        for (let di = -this.#spacing; di <= this.#spacing; di += 1) {
          for (let dj = -this.#spacing; dj <= this.#spacing; dj += 1) {
            if (occupied.has(cellKey(i + di, j + dj))) return { kind: 'overlap', otherName: other.weaponName };
          }
        }
      }
    }
    return null;
  }

  #nearestFreeSpot(id: string, x: number, y: number, maxRing = 16): { x: number; y: number } | null {
    return this.#nearestSpot((spotX, spotY) => !this.#problemAt(id, spotX, spotY), x, y, maxRing);
  }

  /** A group keeps its own spacing, so only the rest of the board counts. */
  #dragProblem(drag: DragState, x: number, y: number): FitProblem {
    if (!drag.group) return this.#problemAt(drag.id, x, y);
    const carried = new Set([drag.id, ...drag.group.map((member) => member.id)]);
    const own = this.#problemAt(drag.id, x, y, carried);
    if (own) return own;
    for (const member of drag.group) {
      const problem = this.#problemAt(member.id, x + member.dx, y + member.dy, carried);
      if (problem) return problem;
    }
    return null;
  }

  #nearestSpot(fits: (x: number, y: number) => boolean, x: number, y: number, maxRing = 16): { x: number; y: number } | null {
    const cell = GRID_CELL[this.#grid];
    for (let ring = 1; ring <= maxRing; ring += 1) {
      let best: { x: number; y: number } | null = null;
      let bestDistance = Infinity;
      for (let di = -ring; di <= ring; di += 1) {
        for (let dj = -ring; dj <= ring; dj += 1) {
          if (Math.max(Math.abs(di), Math.abs(dj)) !== ring) continue;
          const distance = di * di + dj * dj;
          if (distance >= bestDistance) continue;
          const spot = { x: x + di * cell, y: y + dj * cell };
          if (fits(spot.x, spot.y)) {
            best = spot;
            bestDistance = distance;
          }
        }
      }
      if (best) return best;
    }
    return null;
  }

  #findFreeSpot(runtime: ItemRuntime): { x: number; y: number } | null {
    const cell = GRID_CELL[this.#grid];
    const halfW = Math.floor(BOARD_WIDTH / cell / 2);
    const halfH = Math.floor(BOARD_HEIGHT / cell / 2);
    // Reading order: top-left first, the way a board is usually filled.
    for (let j = halfH; j >= -halfH; j -= 1) {
      for (let i = -halfW; i <= halfW; i += 1) {
        if (!this.#problemAt(runtime.item.id, i * cell, j * cell)) return { x: i * cell, y: j * cell };
      }
    }
    return null;
  }

  #updateCellMarkers(): void {
    const cell = GRID_CELL[this.#grid];
    const matrix = new THREE.Matrix4();
    const color = new THREE.Color();
    let count = 0;
    const add = (i: number, j: number, hex: number) => {
      if (count >= MAX_CELL_MARKERS) return;
      matrix.makeScale(cell * 0.82, cell * 0.82, 1).setPosition((i + 0.5) * cell, (j + 0.5) * cell, 0.05);
      this.#cells.setMatrixAt(count, matrix);
      this.#cells.setColorAt(count, color.setHex(hex));
      count += 1;
    };
    const drawItem = (id: string, x: number, y: number, hex: number) => {
      const footprint = this.#runtimes.get(id)?.footprint;
      if (!footprint) return;
      const offsetI = Math.round(x / cell);
      const offsetJ = Math.round(y / cell);
      for (const key of footprint.cells) add(keyI(key) + offsetI, keyJ(key) + offsetJ, hex);
    };
    const drag = this.#drag;
    if (this.#showGrid) {
      for (const item of this.#items) {
        if (item.id !== drag?.id && !drag?.group?.some((member) => member.id === item.id)) drawItem(item.id, item.x, item.y, 0x8a96a8);
      }
    }
    if (drag?.candidate) {
      const hex = this.#dragProblem(drag, drag.candidate.x, drag.candidate.y) ? 0xe06060 : 0x46c07a;
      drawItem(drag.id, drag.candidate.x, drag.candidate.y, hex);
      for (const member of drag.group ?? []) drawItem(member.id, drag.candidate.x + member.dx, drag.candidate.y + member.dy, hex);
    } else if (this.#selection.length === 1) {
      const item = this.#items.find((entry) => entry.id === this.#selection[0]);
      // A selected weapon that fits keeps a clean view; only a conflict is marked.
      if (item && this.#problemAt(item.id, item.x, item.y)) drawItem(item.id, item.x, item.y, 0xe06060);
    } else {
      // Several selected have no gizmo, so their footprints show which they are.
      for (const id of this.#selection) {
        const item = this.#items.find((entry) => entry.id === id);
        if (item) drawItem(item.id, item.x, item.y, this.#problemAt(item.id, item.x, item.y) ? 0xe06060 : 0x4f8dff);
      }
    }
    this.#dirty = true;
    this.#requestFrame();
    this.#cells.count = count;
    // Upload just the markers in use; the buffer holds thousands, most frames draw none.
    if (count) {
      this.#cells.instanceMatrix.clearUpdateRanges();
      this.#cells.instanceMatrix.addUpdateRange(0, count * 16);
      this.#cells.instanceMatrix.needsUpdate = true;
      if (this.#cells.instanceColor) {
        this.#cells.instanceColor.clearUpdateRanges();
        this.#cells.instanceColor.addUpdateRange(0, count * 3);
        this.#cells.instanceColor.needsUpdate = true;
      }
    }
  }

  #showGhost(id: string, x: number, y: number, ok: boolean): void {
    const footprint = this.#runtimes.get(id)?.footprint;
    if (!footprint) return;
    const material = this.#ghost.material;
    const canvas = this.#ghostCanvas;
    if (this.#ghostVersion !== footprint.version) {
      canvas.width = footprint.maskWidth;
      canvas.height = footprint.maskHeight;
      const ctx = canvas.getContext('2d')!;
      const image = ctx.createImageData(canvas.width, canvas.height);
      for (let index = 0; index < footprint.mask.length; index += 1) {
        if (!footprint.mask[index]) continue;
        image.data[index * 4] = 255;
        image.data[index * 4 + 1] = 255;
        image.data[index * 4 + 2] = 255;
        image.data[index * 4 + 3] = 255;
      }
      ctx.putImageData(image, 0, 0);
    }
    const map = material.map;
    // GPU texture storage is fixed at its first size, and a rotation resizes the
    // silhouette canvas, so a resized canvas needs a fresh texture.
    if (!map || map.image !== canvas || this.#ghostSize !== `${canvas.width}x${canvas.height}`) {
      map?.dispose();
      material.map = new THREE.CanvasTexture(canvas);
      this.#ghostSize = `${canvas.width}x${canvas.height}`;
      material.needsUpdate = true;
    } else if (this.#ghostVersion !== footprint.version) {
      map.needsUpdate = true;
    }
    this.#ghostVersion = footprint.version;
    material.color.setHex(ok ? 0xdfe8f5 : 0xe04848);
    material.opacity = ok ? 0.42 : 0.55;
    this.#ghost.scale.set(footprint.width, footprint.height, 1);
    this.#ghost.position.set(x + footprint.originX + footprint.width / 2, y + footprint.originY + footprint.height / 2, 0.08);
    this.#ghost.visible = true;
  }

  #boardPoint(clientX: number, clientY: number): THREE.Vector2 | null {
    const rect = this.#options.canvas.getBoundingClientRect();
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return null;
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    const point = new THREE.Vector3(ndc.x, ndc.y, 0).unproject(this.#camera);
    return new THREE.Vector2(point.x, point.y);
  }

  #pick(clientX: number, clientY: number): ItemRuntime | null {
    const rect = this.#options.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.#raycaster.setFromCamera(ndc, this.#camera);
    const roots = this.#items.filter((item) => !item.hidden).map((item) => this.#runtimes.get(item.id)?.root).filter((root): root is THREE.Group => !!root);
    const hit = this.#raycaster.intersectObjects(roots, true)[0];
    if (!hit) return null;
    for (const runtime of this.#runtimes.values()) {
      let node: THREE.Object3D | null = hit.object;
      while (node) {
        if (node === runtime.root) return runtime;
        node = node.parent;
      }
    }
    return null;
  }

  #onCanvasHover = (event: PointerEvent): void => {
    if (this.#drag) return;
    const hovering = this.#pick(event.clientX, event.clientY);
    this.#options.canvas.style.cursor = hovering ? 'grab' : '';
  };

  #onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    const runtime = this.#pick(event.clientX, event.clientY);
    if (event.ctrlKey || event.metaKey) {
      if (runtime) this.toggleSelected(runtime.item.id);
      return;
    }
    if (!runtime) {
      this.select(null);
      return;
    }
    const point = this.#boardPoint(event.clientX, event.clientY);
    if (!point) return;
    // Pressing a weapon in a selection of several carries them all; letting go without moving selects just it.
    const carriesGroup = this.#selection.length > 1 && this.#selection.includes(runtime.item.id);
    if (!carriesGroup) this.select(runtime.item.id);
    this.#drag = {
      id: runtime.item.id,
      grabX: point.x - runtime.item.x,
      grabY: point.y - runtime.item.y,
      fromX: runtime.item.x,
      fromY: runtime.item.y,
      external: false,
      candidate: { x: runtime.item.x, y: runtime.item.y },
      group: carriesGroup
        ? this.#selection.flatMap((id) => {
          const other = id === runtime.item.id ? undefined : this.#runtimes.get(id)?.item;
          return other ? [{ id, dx: other.x - runtime.item.x, dy: other.y - runtime.item.y }] : [];
        })
        : undefined,
    };
    this.#updateCellMarkers();
    this.#requestFrame();
    this.#options.canvas.style.cursor = 'grabbing';
    window.addEventListener('pointermove', this.#onWindowMove);
    window.addEventListener('pointerup', this.#onWindowUp);
    window.addEventListener('pointercancel', this.#onWindowCancel);
  };

  #onWindowMove = (event: PointerEvent): void => {
    this.#lastPointer = { x: event.clientX, y: event.clientY };
    if (!this.#drag) return;
    this.#queuedPointer = this.#lastPointer;
    this.#dirty = true;
    this.#requestFrame();
  };

  #dragTo(clientX: number, clientY: number): void {
    const drag = this.#drag;
    if (!drag) return;
    const runtime = this.#runtimes.get(drag.id);
    if (!runtime) return;
    const point = this.#boardPoint(clientX, clientY);
    if (!point) {
      if (drag.external) {
        runtime.root.visible = false;
        this.#ghost.visible = false;
        drag.candidate = null;
        this.#pending = null;
        this.#updateCellMarkers();
        this.#emit();
      }
      return;
    }
    runtime.root.visible = true;
    const cell = GRID_CELL[this.#grid];
    const rawX = point.x - drag.grabX;
    const rawY = point.y - drag.grabY;
    drag.candidate = this.#snap
      ? { x: Math.round(rawX / cell) * cell, y: Math.round(rawY / cell) * cell }
      : { x: rawX, y: rawY };
    const problem = this.#dragProblem(drag, drag.candidate.x, drag.candidate.y);
    // The weapon is carried above the board under the pointer; its flat
    // silhouette marks where it will land.
    let floor = 0;
    if (!this.#keepApart) {
      for (const item of this.#items) {
        const other = this.#runtimes.get(item.id);
        if (other && other !== runtime && !drag.group?.some((member) => member.id === item.id)) floor = Math.max(floor, this.#topOf(other));
      }
    }
    runtime.root.position.set(rawX, rawY, floor + (runtime.footprint ? -runtime.footprint.minZ : 4) + CARRY_LIFT);
    for (const member of drag.group ?? []) {
      const carried = this.#runtimes.get(member.id);
      carried?.root.position.set(rawX + member.dx, rawY + member.dy, floor + (carried.footprint ? -carried.footprint.minZ : 4) + CARRY_LIFT);
    }
    this.#showGhost(drag.id, drag.candidate.x, drag.candidate.y, !problem);
    this.#pending = { id: drag.id, problem };
    this.#updateCellMarkers();
    this.#emit();
  }

  /** A cancelled pointer (system gesture, palm rejection) never sends pointerup: nothing is dropped, and carried weapons go back. */
  #onWindowCancel = (): void => {
    this.#queuedPointer = null;
    if (!this.#drag) {
      this.#cancelExternalDrag();
      return;
    }
    this.#drag.candidate = null;
    this.#onWindowUp();
  };

  #onWindowUp = (): void => {
    if (this.#pendingExternal && !this.#drag) {
      // Let go before the weapon finished loading: it drops here once it arrives.
      this.#releasedWhileLoading = true;
      window.removeEventListener('pointermove', this.#onWindowMove);
      window.removeEventListener('pointerup', this.#onWindowUp);
      window.removeEventListener('pointercancel', this.#onWindowCancel);
      return;
    }
    // Land where the pointer actually let go, even if that move never got a frame.
    if (this.#drag && this.#queuedPointer) this.#dragTo(this.#queuedPointer.x, this.#queuedPointer.y);
    this.#queuedPointer = null;
    this.#cancelExternalDrag();
    const drag = this.#drag;
    this.#drag = null;
    this.#ghost.visible = false;
    this.#pending = null;
    this.#options.canvas.style.cursor = '';
    if (!drag) return;
    const runtime = this.#runtimes.get(drag.id);
    if (!runtime) return;
    // Released over the board: land on the spot under the pointer, or the
    // nearest one that fits. Released anywhere else: nothing is placed.
    const fits = (x: number, y: number) => !this.#dragProblem(drag, x, y);
    const candidate = drag.candidate
      ? (fits(drag.candidate.x, drag.candidate.y) ? drag.candidate : this.#nearestSpot(fits, drag.candidate.x, drag.candidate.y))
      : null;
    if (drag.group) {
      if (drag.candidate?.x === drag.fromX && drag.candidate.y === drag.fromY) {
        // Never left its spot, so this was a click.
        this.#restack();
        this.select(drag.id);
      } else {
        // With nowhere for all of them to land, restacking puts the group back where it was.
        if (candidate) {
          runtime.item.x = candidate.x;
          runtime.item.y = candidate.y;
          this.#replaceItem(runtime);
          for (const member of drag.group) {
            const carried = this.#runtimes.get(member.id);
            if (!carried) continue;
            carried.item.x = candidate.x + member.dx;
            carried.item.y = candidate.y + member.dy;
            this.#replaceItem(carried);
          }
        }
        this.#restack();
        this.#checkpoint();
      }
    } else if (drag.external) {
      if (candidate) {
        runtime.item.x = candidate.x;
        runtime.item.y = candidate.y;
        this.#commitRuntime(runtime);
        this.select(runtime.item.id);
      } else {
        this.#disposeRuntime(runtime);
        this.#selection = [];
      }
    } else {
      if (candidate) {
        runtime.item.x = candidate.x;
        runtime.item.y = candidate.y;
        this.#replaceItem(runtime);
      }
      this.#restack();
      this.select(drag.id);
      this.#checkpoint();
    }
    this.#updateCellMarkers();
    this.#emit();
  };

  /** Keep an edit that fits; put back the last fitting pose if it does not. */
  settle(id: string): void {
    this.#flushReshapes();
    this.#liveEditId = null;
    const runtime = this.#runtimes.get(id);
    if (!runtime) return;
    if (!this.#problemAt(id, runtime.item.x, runtime.item.y)) {
      this.#rememberValid(runtime);
    } else {
      const valid = this.#lastValid.get(id);
      if (valid) {
        Object.assign(runtime.item, valid, { pose: { ...valid.pose } });
        this.#reshape(runtime);
        this.#replaceItem(runtime);
        this.#restack();
      }
    }
    this.#pending = null;
    this.#checkpoint();
    this.#updateCellMarkers();
    this.#sharpenPaints();
    this.#emit();
  }

  #rememberValid(runtime: ItemRuntime): void {
    const { roll, tilt, turn, flipped, scale, pose } = runtime.item;
    this.#lastValid.set(runtime.item.id, { roll, tilt, turn, flipped, scale, pose: { ...pose } });
  }

  screenInfo(id: string): { x: number; y: number; radius: number } | null { return this.#handles.screenInfo(id); }

  poseHandles(id: string): PoseHandle[] { return this.#handles.poseHandles(id); }

  poseHandlePath(id: string, controlId: string): { values: number[]; points: { x: number; y: number }[] } | null { return this.#handles.poseHandlePath(id, controlId); }

  #frameBounds(): { width: number; height: number } {
    if (this.#background === 'framed') {
      return { width: BOARD_WIDTH + FRAME_SIDE * 2, height: BOARD_HEIGHT + FRAME_SIDE * 2 };
    }
    return { width: BOARD_WIDTH, height: BOARD_HEIGHT };
  }

  #fitCamera(aspect: number, padding: number): void {
    const bounds = this.#frameBounds();
    const width = bounds.width * padding;
    const height = bounds.height * padding;
    const halfH = Math.max(height, width / aspect) / 2;
    const halfW = halfH * aspect;
    this.#camera.left = -halfW;
    this.#camera.right = halfW;
    this.#camera.top = halfH;
    this.#camera.bottom = -halfH;
    this.#camera.updateProjectionMatrix();
  }

  /** Resizes the buffer now; exports and background changes call this directly. */
  #resize(): void {
    const canvas = this.#options.canvas;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (!width || !height) return;
    this.renderer.setSize(width, height, false);
    this.#fitCamera(width / height, FIT_PADDING);
    this.#sharpenPaints();
    this.#emit();
  }

  /** Observer callback: the first call sizes the buffer, later ones fit the view at once and resize after a settle. */
  #observeResize(): void {
    const canvas = this.#options.canvas;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (!width || !height) return;
    if (!this.#observedResize) {
      this.#observedResize = true;
      this.#resize();
      return;
    }
    // Matching the projection to the CSS box keeps the old buffer from squeezing while the layout moves.
    this.#fitCamera(width / height, FIT_PADDING);
    this.#dirty = true;
    this.#requestFrame();
    window.clearTimeout(this.#resizeTimer);
    this.#resizeTimer = window.setTimeout(() => this.#resize(), RESIZE_DEBOUNCE_MS);
  }

  /** Schedules one frame; no-op while one is already queued or after disposal. */
  #requestFrame(): void {
    if (this.#disposed || this.#raf) return;
    this.#raf = requestAnimationFrame(this.#frameLoop);
  }

  #frameLoop = (): void => {
    this.#raf = 0;
    if (this.#disposed) return;
    // A drag samples the pointer every vsync; with no drag the loop stops once nothing is queued.
    if (this.#drag) this.#requestFrame();
    if (this.#drag && this.#queuedPointer) {
      const { x, y } = this.#queuedPointer;
      this.#queuedPointer = null;
      this.#dragTo(x, y);
    }
    this.#flushReshapes();
    if (this.#notifyQueued) {
      this.#notifyQueued = false;
      for (const listener of this.#listeners) listener();
    }
    if (!this.#dirty) return;
    this.#dirty = false;
    this.renderer.render(this.#scene, this.#camera);
  };

  /** A small picture of the board as it looks now, for telling saved layouts apart. Null if the browser cannot make one. */
  thumbnail(width: number): string | null {
    if (this.#disposed) return null;
    this.#flushReshapes();
    const hidden = [this.#cells, this.#ghost].filter((object) => object.visible);
    for (const object of hidden) object.visible = false;
    // A WebGL canvas can only be read straight after drawing, so this draws now rather than on the next frame.
    this.renderer.render(this.#scene, this.#camera);
    const source = this.renderer.domElement;
    const bounds = this.#frameBounds();
    const perUnit = source.width / (this.#camera.right - this.#camera.left);
    const [sourceWidth, sourceHeight] = [bounds.width * perUnit, bounds.height * perUnit];
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = Math.round(width * bounds.height / bounds.width);
    const context = canvas.getContext('2d');
    if (context) {
      context.imageSmoothingQuality = 'high';
      context.drawImage(source, (source.width - sourceWidth) / 2, (source.height - sourceHeight) / 2, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height);
    }
    for (const object of hidden) object.visible = true;
    this.#dirty = true;
    this.#requestFrame();
    const url = canvas.toDataURL('image/webp', 0.8);
    return context && url.startsWith('data:image/') ? url : null;
  }

  outputSize(width: number): { width: number; height: number } {
    const bounds = this.#frameBounds();
    return { width, height: Math.round(width * bounds.height / bounds.width) };
  }

  /** Resolves once every weapon on the board wears its finished paint and material. */
  async whenPainted(): Promise<void> {
    let waitedFor = '';
    for (;;) {
      const runtimes = [...this.#runtimes.values()];
      const keys = [...new Set(runtimes.map((runtime) => runtime.paintKey))].filter(Boolean).sort();
      const state = [...keys, ...runtimes.map((runtime) => runtime.materialKey)].join('\n');
      // Paints and materials can change while waiting, so wait again until a pass finds nothing new.
      if (state === waitedFor) return;
      waitedFor = state;
      await Promise.all([...keys.map((key) => this.#boardPaints.pendingPaint(key)), ...runtimes.map((runtime) => runtime.materialReady), ...runtimes.map((runtime) => runtime.statClock?.ready)]);
    }
  }

  async exportPng(outputWidth = 1920): Promise<Blob> {
    // Paints sized for the screen are sharpened for the export first, and an
    // export taken while they are still streaming in would show them half done.
    this.#sharpenPaints(this.#pixelsPerUnit() * outputWidth / Math.max(1, this.renderer.domElement.width));
    await this.whenPainted();
    this.#flushReshapes();
    const outputHeight = this.outputSize(outputWidth).height;
    const hidden = [this.#cells, this.#ghost].filter((object) => object.visible);
    for (const object of hidden) object.visible = false;
    const previousRatio = this.renderer.getPixelRatio();
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(outputWidth, outputHeight, false);
    this.#fitCamera(outputWidth / outputHeight, 1);
    this.renderer.render(this.#scene, this.#camera);
    const blob = await new Promise<Blob | null>((resolve) => this.renderer.domElement.toBlob(resolve, 'image/png'));
    for (const object of hidden) object.visible = true;
    this.renderer.setPixelRatio(previousRatio);
    this.#resize();
    if (!blob) throw new Error('export failed');
    return blob;
  }

  dispose(): void {
    this.#disposed = true;
    cancelAnimationFrame(this.#raf);
    window.clearTimeout(this.#resizeTimer);
    this.#boardPaints.cancelSweep();
    this.#cancelExternalDrag();
    window.removeEventListener('pointermove', this.#onWindowMove);
    window.removeEventListener('pointerup', this.#onWindowUp);
    window.removeEventListener('pointercancel', this.#onWindowCancel);
    this.#options.canvas.removeEventListener('pointerdown', this.#onPointerDown);
    this.#options.canvas.removeEventListener('pointermove', this.#onCanvasHover);
    this.#resizeObserver.disconnect();
    for (const runtime of this.#runtimes.values()) this.#disposeRuntime(runtime);
    for (const pending of this.#imageAssets.values()) void pending.then((asset) => asset?.texture.dispose()).catch(() => undefined);
    for (const url of this.#imageUrls.values()) URL.revokeObjectURL(url);
    this.#compositor.dispose();
    this.renderer.dispose();
  }
}

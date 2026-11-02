// Showcase board engine: a pegboard where painted weapons are dragged onto a grid,
// rotated, posed and exported as one image.
// It runs its own renderer and compositor, so each weapon can wear a different paint
// without touching the main viewer.

import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';

import { Compositor } from '../compositor/compositor';
import { createTf2Uniforms } from '../viewer/materialConfig';
import { loadEditorEnvCube, makeEnvCube } from '../viewer/env';
import type { WeaponEntry } from '../data/types';
import type { LayoutPacking, LayoutRows } from './layouts';
import { POSE_RIGS, WEAPON_PARTS, defaultPose, isRigged, partOf, type RestBone } from './poseRigs';
import { FRAME_SIDE, frameTexture, makeTf2Material, pegboardTexture, vignetteTexture } from './boardTextures';
import { BOARD_HEIGHT, BOARD_WIDTH, GRID_CELL } from './boardMetrics';
import { arrange, type BoardLayoutHost } from './boardLayout';
import { cellKey, refreshFootprint } from './footprint';
import type { BoardBackground, DragState, GridSize, ItemRuntime, MeshSubset, PoseHandle, ShowcaseBoardOptions, ShowcaseItem, ShowcasePaint, ShowcaseSnapshot, FitProblem } from './showcaseTypes';
import { baseOrientation, findPartBases, partSubset, posedPositions, restingRoll } from './weaponGeometry';
import { BoardPaints, MIN_SOURCE_SIZE } from './boardPaints';
import { PoseHandles } from './poseHandles';

const RESTING_LIFT = 1.4;
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

const copyItem = (item: ShowcaseItem): ShowcaseItem => ({ ...item, paint: { ...item.paint }, pose: { ...item.pose }, hiddenParts: [...item.hiddenParts] });

const keyI = (key: number) => Math.floor(key / 4096) - 2048;
const keyJ = (key: number) => (key % 4096) - 2048;

let idCounter = 0;

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
  #selectedId: string | null = null;
  #pending: ShowcaseSnapshot['pending'] = null;
  #snapshot: ShowcaseSnapshot;
  #drag: DragState | null = null;
  /** Last pose of each item that passed the fit rules; edits that end invalid return to it. */
  readonly #lastValid = new Map<string, Pick<ShowcaseItem, 'roll' | 'tilt' | 'turn' | 'flipped' | 'scale' | 'pose'>>();
  #grid: GridSize = 'normal';
  #spacing = 1;
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
      selectedId: this.#selectedId,
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
    window.addEventListener('pointermove', this.#onWindowMove);
    window.addEventListener('pointerup', this.#onWindowUp);
    this.#lastPointer = { x: clientX, y: clientY };
    this.#pendingExternal = true;
    const runtime = await this.#createRuntime(weaponKey, paint);
    if (!this.#pendingExternal || !runtime) {
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
  #releasedWhileLoading = false;
  /** Board states before and after the current one; each entry is a full item list. */
  #past: ShowcaseItem[][] = [];
  #future: ShowcaseItem[][] = [];
  #committed: ShowcaseItem[] = [];
  #restoring = false;
  #lastPointer = { x: 0, y: 0 };

  #cancelExternalDrag(): void {
    this.#pendingExternal = false;
    this.#releasedWhileLoading = false;
    window.removeEventListener('pointermove', this.#onWindowMove);
    window.removeEventListener('pointerup', this.#onWindowUp);
  }

  undo(): void {
    const previous = this.#past.pop();
    if (!previous || this.#restoring) return;
    this.#future.push(this.#committed);
    void this.#restore(previous);
  }

  redo(): void {
    const next = this.#future.pop();
    if (!next || this.#restoring) return;
    this.#past.push(this.#committed);
    void this.#restore(next);
  }

  #checkpoint(): void {
    if (this.#restoring) return;
    this.#flushReshapes();
    const current = this.#items.map(copyItem);
    if (JSON.stringify(current) === JSON.stringify(this.#committed)) return;
    this.#past.push(this.#committed);
    if (this.#past.length > HISTORY_LIMIT) this.#past.shift();
    this.#future = [];
    this.#committed = current;
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
        runtime ??= (await this.#createRuntime(saved.weaponKey, saved.paint, saved.id, saved.part)) ?? undefined;
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
      if (this.#selectedId && !wanted.has(this.#selectedId)) this.#selectedId = null;
      this.#restack();
      this.#updateCellMarkers();
    } finally {
      this.#restoring = false;
      this.#emit();
    }
  }

  select(id: string | null): void {
    this.#selectedId = id;
    this.#updateCellMarkers();
    this.#emit();
  }

  update(id: string, patch: Partial<Pick<ShowcaseItem, 'roll' | 'tilt' | 'turn' | 'flipped' | 'scale' | 'pose'>>): void {
    const runtime = this.#runtimes.get(id);
    if (!runtime) return;
    Object.assign(runtime.item, patch);
    runtime.item.tilt = THREE.MathUtils.clamp(runtime.item.tilt, -TILT_LIMIT, TILT_LIMIT);
    runtime.item.turn = THREE.MathUtils.clamp(runtime.item.turn, -TILT_LIMIT, TILT_LIMIT);
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
      if (!problem) this.#rememberValid(runtime);
      this.#pending = problem ? { id: lastId, problem } : null;
    }
    this.#updateCellMarkers();
    this.#emit();
  }

  /** Turn by a step. A carried weapon turns in hand (its fit is checked on drop); one on the board settles, springing back if the turn does not fit. */
  rotateBy(id: string, degrees: number): void {
    const runtime = this.#runtimes.get(id);
    if (!runtime) return;
    const roll = ((((runtime.item.roll + degrees + 180) % 360) + 360) % 360) - 180;
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
    if (this.#selectedId === id) this.select(null);
    this.#items = this.#items.filter((item) => item.id !== id);
    this.#disposeRuntime(runtime);
    this.#restack();
    this.#checkpoint();
    this.#emit();
  }

  async duplicate(id: string): Promise<void> {
    const source = this.#runtimes.get(id)?.item;
    if (!source) return;
    const runtime = await this.#createRuntime(source.weaponKey, source.paint, undefined, source.part);
    if (!runtime) return;
    Object.assign(runtime.item, { roll: source.roll, tilt: source.tilt, turn: source.turn, flipped: source.flipped, scale: source.scale, pose: { ...source.pose }, hiddenParts: [...source.hiddenParts] });
    this.#reshape(runtime);
    const spot = this.#findFreeSpot(runtime);
    if (!spot) {
      this.#disposeRuntime(runtime);
      return;
    }
    runtime.item.x = spot.x;
    runtime.item.y = spot.y;
    this.#commitRuntime(runtime);
    this.select(runtime.item.id);
  }

  clear(): void {
    // A layout still loading would otherwise land on the cleared board.
    this.#layoutRequest += 1;
    this.select(null);
    for (const runtime of [...this.#runtimes.values()]) this.#disposeRuntime(runtime);
    this.#items = [];
    this.#checkpoint();
    this.#emit();
  }

  #layoutRequest = 0;

  /** Replace the board with a layout as one undo step; all weapons share the one size that fills the board. */
  async applyLayout(rows: LayoutRows, pack?: LayoutPacking, inward = false, upright = false): Promise<void> {
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
    for (const runtime of [...this.#runtimes.values()]) if (!keep.has(runtime)) this.#disposeRuntime(runtime);
    this.#items = [];
    if (groups.length) this.#arrange(groups, pack, inward, upright);
    // Painted once at their final size, so none composes at 100% only to shrink.
    for (const runtime of groups.flat()) void this.#applyPaint(runtime);
    this.#restack();
    this.#checkpoint();
    this.#updateCellMarkers();
    this.#emit();
  }

  #arrange(rows: ItemRuntime[][], pack: LayoutPacking | undefined, inward: boolean, upright: boolean): void {
    arrange(this.#layoutHost, rows, pack, inward, upright);
  }

  /** Change one item's paint, wear, team or pattern seed, as one undo step. */
  setPaint(id: string, patch: Partial<ShowcasePaint>): void {
    const runtime = this.#runtimes.get(id);
    if (!runtime) return;
    runtime.item = { ...runtime.item, paint: { ...runtime.item.paint, ...patch } };
    this.#items = this.#items.map((item) => (item.id === id ? runtime.item : item));
    void this.#applyPaint(runtime);
    this.#checkpoint();
    this.#emit();
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
      const bones = new Map<string, RestBone>();
      model.updateMatrixWorld(true);
      const modelInverse = model.getWorldQuaternion(new THREE.Quaternion()).invert();
      model.traverse((object) => {
        if (object instanceof THREE.Bone) {
          const restInModel = modelInverse.clone().multiply(object.getWorldQuaternion(new THREE.Quaternion()));
          bones.set(object.name, { bone: object, position: object.position.clone(), quaternion: object.quaternion.clone(), modelInverse: restInModel.invert(), base: null });
        }
        if (object instanceof THREE.Mesh) {
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
        flipped: false,
        scale: 1,
        hidden: false,
        pose: part ? {} : defaultPose(weaponKey),
        part: part?.id ?? null,
        hiddenParts: [],
      };
      const runtime: ItemRuntime = { item, root: new THREE.Group(), orient: new THREE.Group(), meshes, bones, footprint: null, material, uniforms, materialKey: '', stackZ: 0, local: null, paintKey: '', materialReady: Promise.resolve(), paintSize: 0, visibility: '', subsets: [] };
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

  #releaseRetiredPreviews(): void { this.#boardPaints.releaseRetiredPreviews(); }

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
    root.position.set(item.x, item.y, runtime.stackZ + (runtime.footprint ? -runtime.footprint.minZ : 4) + RESTING_LIFT);
  }

  /** Re-pose and re-measure: the resting height depends on the new footprint's depth. */
  #reshape(runtime: ItemRuntime): void {
    this.#syncVisibility(runtime);
    this.#applyTransform(runtime);
    this.#refreshFootprint(runtime);
    this.#applyTransform(runtime);
  }

  #topOf(runtime: ItemRuntime): number {
    const footprint = runtime.footprint;
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
      if (!this.#keepApart) {
        for (const below of placed) {
          if (this.#overlaps(runtime, below)) runtime.stackZ = Math.max(runtime.stackZ, this.#topOf(below));
        }
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
    if (hidden && this.#selectedId === id) this.#selectedId = null;
    this.#restack();
    this.#checkpoint();
    this.#updateCellMarkers();
    this.#emit();
  }

  #disposeRuntime(runtime: ItemRuntime): void {
    runtime.root.removeFromParent();
    runtime.material.dispose();
    this.#runtimes.delete(runtime.item.id);
    this.#releaseRetiredPreviews();
    this.#sweepPaints();
  }

  #refreshFootprint(runtime: ItemRuntime): void {
    refreshFootprint(runtime, GRID_CELL[this.#grid], () => (this.#footprintVersion += 1));
  }

  #problemAt(id: string, x: number, y: number): FitProblem {
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
    if (!this.#keepApart) return null;
    for (const other of this.#items) {
      if (other.id === id || other.hidden) continue;
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
          if (!this.#problemAt(id, spot.x, spot.y)) {
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
    if (this.#showGrid) {
      for (const item of this.#items) {
        if (item.id !== this.#drag?.id) drawItem(item.id, item.x, item.y, 0x8a96a8);
      }
    }
    const drag = this.#drag;
    if (drag?.candidate) {
      const ok = !this.#problemAt(drag.id, drag.candidate.x, drag.candidate.y);
      drawItem(drag.id, drag.candidate.x, drag.candidate.y, ok ? 0x46c07a : 0xe06060);
    } else if (this.#selectedId) {
      const item = this.#items.find((entry) => entry.id === this.#selectedId);
      // A selected weapon that fits keeps a clean view; only a conflict is marked.
      if (item && this.#problemAt(item.id, item.x, item.y)) drawItem(item.id, item.x, item.y, 0xe06060);
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
    if (!runtime) {
      this.select(null);
      return;
    }
    const point = this.#boardPoint(event.clientX, event.clientY);
    if (!point) return;
    this.select(runtime.item.id);
    this.#drag = {
      id: runtime.item.id,
      grabX: point.x - runtime.item.x,
      grabY: point.y - runtime.item.y,
      fromX: runtime.item.x,
      fromY: runtime.item.y,
      external: false,
      candidate: { x: runtime.item.x, y: runtime.item.y },
    };
    this.#requestFrame();
    this.#options.canvas.style.cursor = 'grabbing';
    window.addEventListener('pointermove', this.#onWindowMove);
    window.addEventListener('pointerup', this.#onWindowUp);
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
    const problem = this.#problemAt(drag.id, drag.candidate.x, drag.candidate.y);
    // The weapon is carried above the board under the pointer; its flat
    // silhouette marks where it will land.
    let floor = 0;
    if (!this.#keepApart) {
      for (const item of this.#items) {
        const other = this.#runtimes.get(item.id);
        if (other && other !== runtime) floor = Math.max(floor, this.#topOf(other));
      }
    }
    runtime.root.position.set(rawX, rawY, floor + (runtime.footprint ? -runtime.footprint.minZ : 4) + CARRY_LIFT);
    this.#showGhost(drag.id, drag.candidate.x, drag.candidate.y, !problem);
    this.#pending = { id: drag.id, problem };
    this.#updateCellMarkers();
    this.#emit();
  }

  #onWindowUp = (): void => {
    if (this.#pendingExternal && !this.#drag) {
      // Let go before the weapon finished loading: it drops here once it arrives.
      this.#releasedWhileLoading = true;
      window.removeEventListener('pointermove', this.#onWindowMove);
      window.removeEventListener('pointerup', this.#onWindowUp);
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
    const candidate = drag.candidate
      ? (this.#problemAt(drag.id, drag.candidate.x, drag.candidate.y) ? this.#nearestFreeSpot(drag.id, drag.candidate.x, drag.candidate.y) : drag.candidate)
      : null;
    if (drag.external) {
      if (candidate) {
        runtime.item.x = candidate.x;
        runtime.item.y = candidate.y;
        this.#commitRuntime(runtime);
        this.select(runtime.item.id);
      } else {
        this.#disposeRuntime(runtime);
        this.#selectedId = null;
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

  /** Pixel size of an export at the given width, following the visible frame's aspect. */
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
      await Promise.all([...keys.map((key) => this.#boardPaints.pendingPaint(key)), ...runtimes.map((runtime) => runtime.materialReady)]);
    }
  }

  /** Render the board alone (no gizmo, markers, or silhouette) at a fixed output width. */
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
    this.#options.canvas.removeEventListener('pointerdown', this.#onPointerDown);
    this.#options.canvas.removeEventListener('pointermove', this.#onCanvasHover);
    this.#resizeObserver.disconnect();
    for (const runtime of this.#runtimes.values()) this.#disposeRuntime(runtime);
    this.#compositor.dispose();
    this.renderer.dispose();
  }
}

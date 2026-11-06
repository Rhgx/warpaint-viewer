import * as THREE from 'three';

import { joinData } from '../data/loader';
import type { WeaponMaterial } from '../data/types';
import { configureTf2Material, createTf2Uniforms, type Tf2Uniforms } from './materialConfig';
import { ModelLoader, type ModelPart } from './modelLoader';
import { installTf2VertexLit, TF2_VERTEXLIT_CACHE_KEY } from './shaders/vertexlit';

// TF2's Stat Clock on a weapon, for both the viewer and the Showcase board. It sits on the weapon's c_weapon_stattrack
// bone at the size items_game gives that weapon, as the game's bone merge does (tools/extract/stat-clock.mjs).
// Its own materials have no sheen or wear pass, so it takes neither. Nothing here loads until a clock goes on.

type StatClockTeam = 'red' | 'blu';

export interface WantedClock {
  team: StatClockTeam;
  kills: number;
}

interface StatClockPlacement {
  pos: [number, number, number];
  quat: [number, number, number, number];
  scale: number;
}

interface StatClockData {
  model: string;
  dial: { texture: string; frames: number; digits: number };
  teams: Record<StatClockTeam, { body: string; face: string }>;
  lines: string;
  lightwarp: string;
  materials: Record<'body' | 'dial' | 'face', WeaponMaterial>;
  placements: Record<string, StatClockPlacement>;
}

interface SharedAssets {
  data: StatClockData;
  parts: ModelPart[];
  dial: THREE.Texture;
  lines: THREE.Texture;
  lightwarp: THREE.Texture;
}

interface TeamMaps {
  body: THREE.Texture;
  face: THREE.Texture;
}

// CStatTrakIllumProxy sets the digits' $color to 0.75 on a viewmodel and leaves it at 1 elsewhere. The shader takes
// $color through GammaToLinear, and this shader's colour is already linear.
const VIEWMODEL_DIAL_COLOR = 0.75 ** 2.2;

/** Which dial frame a digit shows, the way CStatTrakDigitProxy works it out, with digit 0 the ones. */
export const dialFrame = (kills: number, digit: number) => Math.floor(kills / 10 ** digit) % 10;

const textureLoader = new THREE.TextureLoader();

async function loadMap(ref: string, wrap: THREE.Wrapping): Promise<THREE.Texture> {
  const texture = await textureLoader.loadAsync(joinData(ref));
  // Sampled raw: the shader decodes base colours itself, and alpha is a specular mask.
  texture.flipY = false;
  texture.colorSpace = THREE.NoColorSpace;
  texture.wrapS = texture.wrapT = wrap;
  texture.anisotropy = 8;
  return texture;
}

// Shared by every renderer and never freed: the whole set is smaller than one weapon's maps.
let sharedAssets: Promise<SharedAssets> | null = null;
const teamMaps = new Map<StatClockTeam, Promise<TeamMaps>>();

function loadShared(): Promise<SharedAssets> {
  sharedAssets ??= (async () => {
    const response = await fetch(joinData('stat-clock/stat-clock.json'));
    if (!response.ok) throw new Error(`stat-clock.json: ${response.status}`);
    const data = await response.json() as StatClockData;
    const [parts, dial, lines, lightwarp] = await Promise.all([
      new ModelLoader().load(joinData(data.model)),
      loadMap(data.dial.texture, THREE.RepeatWrapping),
      loadMap(data.lines, THREE.RepeatWrapping),
      loadMap(data.lightwarp, THREE.ClampToEdgeWrapping),
    ]);
    return { data, parts, dial, lines, lightwarp };
  })().catch((error: unknown) => {
    // A later clock can try again.
    sharedAssets = null;
    throw error;
  });
  return sharedAssets;
}

function loadTeamMaps(data: StatClockData, team: StatClockTeam): Promise<TeamMaps> {
  let pending = teamMaps.get(team);
  if (!pending) {
    pending = Promise.all([loadMap(data.teams[team].body, THREE.RepeatWrapping), loadMap(data.teams[team].face, THREE.RepeatWrapping)])
      .then(([body, face]) => ({ body, face }))
      .catch((error: unknown) => {
        teamMaps.delete(team);
        throw error;
      });
    teamMaps.set(team, pending);
  }
  return pending;
}

interface StatClockHost {
  /** Ends the program's cache key, so a clock can share a program its host has already compiled. */
  readonly programKey: string;
  /** The host's own uniform slots, so the clock is lit by what lights the weapon. */
  readonly lighting: Pick<Tf2Uniforms, 'uTf2AmbientCube' | 'uTf2AmbientBasis' | 'uTf2SpotFalloff'>;
  readonly envMap: THREE.CubeTexture;
  readonly clippingPlanes?: THREE.Plane[];
  readonly castShadow?: boolean;
  readonly invalidate: () => void;
}

interface BuiltClock {
  group: THREE.Group;
  body: THREE.MeshPhongMaterial;
  face: THREE.MeshPhongMaterial;
  faceUniforms: Tf2Uniforms;
  /** Index is the digit, 0 being the ones. Each is its own view of the one dial texture. */
  digits: THREE.Texture[];
  dials: THREE.MeshPhongMaterial[];
  materials: THREE.MeshPhongMaterial[];
}

export class StatClock {
  readonly #host: StatClockHost;
  #envMap: THREE.CubeTexture;
  #wanted: WantedClock | null = null;
  #parent: THREE.Object3D | null = null;
  #weaponKey: string | null = null;
  /** The parent is the weapon's own clock bone, which already holds the position and rotation. */
  #onBone = false;
  #onViewmodel = false;
  #built: BuiltClock | null = null;
  #request = 0;
  #disposed = false;
  ready: Promise<void> = Promise.resolve();

  constructor(host: StatClockHost) {
    this.#host = host;
    this.#envMap = host.envMap;
  }

  attachTo(parent: THREE.Object3D | null, weaponKey: string | null, onBone = false, onViewmodel = false): void {
    if (parent === this.#parent && weaponKey === this.#weaponKey && onBone === this.#onBone && onViewmodel === this.#onViewmodel) return;
    // At once and not when the assets arrive, as the old parent may be about to be disposed.
    if (parent !== this.#parent) this.#built?.group.removeFromParent();
    this.#parent = parent;
    this.#weaponKey = weaponKey;
    this.#onBone = onBone;
    this.#onViewmodel = onViewmodel;
    this.#sync();
  }

  set(wanted: WantedClock | null): void {
    const current = this.#wanted;
    if (current?.team === wanted?.team && current?.kills === wanted?.kills) return;
    this.#wanted = wanted;
    this.#sync();
  }

  setEnvMap(texture: THREE.CubeTexture): void {
    this.#envMap = texture;
    if (!this.#built) return;
    for (const material of this.#built.materials) material.envMap = texture;
    this.#host.invalidate();
  }

  /** The face's TextureScroll runs on game time, so it scrolls in the inspect view too. */
  step(dt: number): boolean {
    const built = this.#built;
    if (!built?.group.visible) return false;
    const uniforms = built.faceUniforms;
    const scroll = uniforms.uTf2DetailScroll.value;
    if (scroll.lengthSq() === 0) return false;
    const period = 1 / Math.max(Math.abs(scroll.x), Math.abs(scroll.y));
    uniforms.uTf2Time.value = (uniforms.uTf2Time.value + dt) % period;
    return true;
  }

  dispose(): void {
    this.#disposed = true;
    this.#request += 1;
    const built = this.#built;
    if (!built) return;
    built.group.removeFromParent();
    for (const material of built.materials) material.dispose();
    for (const digit of built.digits) digit.dispose();
    this.#built = null;
  }

  #hide(): void {
    if (!this.#built?.group.visible) return;
    this.#built.group.visible = false;
    this.#built.group.removeFromParent();
    this.#host.invalidate();
  }

  #sync(): void {
    const request = (this.#request += 1);
    const wanted = this.#wanted;
    if (!wanted || !this.#parent || !this.#weaponKey) {
      this.#hide();
      this.ready = Promise.resolve();
      return;
    }
    this.ready = this.#show(request, wanted).catch((error: unknown) => {
      // Left out, like an attached model that fails to load; the weapon is still there.
      console.warn('[warpaint-viewer] stat clock failed to load:', error);
    });
  }

  async #show(request: number, wanted: WantedClock): Promise<void> {
    const assets = await loadShared();
    const maps = await loadTeamMaps(assets.data, wanted.team);
    if (request !== this.#request || this.#disposed) return;
    const parent = this.#parent;
    const placement = this.#weaponKey ? assets.data.placements[this.#weaponKey] : undefined;
    if (!parent || !placement) {
      this.#hide();
      return;
    }
    const built = this.#built ?? this.#build(assets, maps);
    this.#built = built;
    const { group } = built;
    built.body.map = maps.body;
    built.face.map = maps.face;
    built.digits.forEach((digit, index) => {
      digit.offset.y = dialFrame(wanted.kills, index) / assets.data.dial.frames;
    });
    if (this.#onBone) {
      group.position.set(0, 0, 0);
      group.quaternion.identity();
    } else {
      group.position.fromArray(placement.pos);
      group.quaternion.fromArray(placement.quat);
    }
    group.scale.setScalar(placement.scale);
    for (const dial of built.dials) dial.color.setScalar(this.#onViewmodel ? VIEWMODEL_DIAL_COLOR : 1);
    if (group.parent !== parent) parent.add(group);
    group.visible = true;
    this.#host.invalidate();
  }

  #material(params: WeaponMaterial, map: THREE.Texture, lightwarp: THREE.Texture | null, detail: THREE.Texture | null): { material: THREE.MeshPhongMaterial; uniforms: Tf2Uniforms } {
    const { programKey, lighting: { uTf2AmbientCube, uTf2AmbientBasis, uTf2SpotFalloff }, clippingPlanes } = this.#host;
    // Only these three are shared: the host usually passes all its uniforms, and the rest are the weapon's own material.
    const uniforms: Tf2Uniforms = { ...createTf2Uniforms(), uTf2AmbientCube, uTf2AmbientBasis, uTf2SpotFalloff };
    const material = new THREE.MeshPhongMaterial({ color: 0xffffff, map, envMap: this.#envMap, combine: THREE.AddOperation, reflectivity: 1 });
    configureTf2Material(params, material, uniforms);
    uniforms.uTf2UseLightwarp.value = lightwarp ? 1 : 0;
    uniforms.uTf2LightwarpMap.value = lightwarp;
    uniforms.uTf2DetailMap.value = detail;
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      installTf2VertexLit(shader);
    };
    material.customProgramCacheKey = () => `${TF2_VERTEXLIT_CACHE_KEY}-${programKey}`;
    if (clippingPlanes) material.clippingPlanes = clippingPlanes;
    return { material, uniforms };
  }

  #build({ data, parts, dial, lines, lightwarp }: SharedAssets, maps: TeamMaps): BuiltClock {
    const body = this.#material(data.materials.body, maps.body, lightwarp, null);
    const face = this.#material(data.materials.face, maps.face, null, lines);
    const materials = [body.material, face.material];
    const dials: THREE.MeshPhongMaterial[] = [];
    const digits = Array.from({ length: data.dial.digits }, () => {
      const view = dial.clone();
      view.repeat.set(1, 1 / data.dial.frames);
      view.needsUpdate = true;
      return view;
    });
    const group = new THREE.Group();
    group.name = 'stat-clock';
    group.visible = false;
    for (const { geometry, materialName } of parts) {
      const digit = /stattrack_dial(\d+)$/.exec(materialName)?.[1];
      let material = body.material;
      if (digit !== undefined) {
        material = this.#material(data.materials.dial, digits[Number(digit)], lightwarp, null).material;
        materials.push(material);
        dials.push(material);
      } else if (materialName.endsWith('_happy')) {
        material = face.material;
      }
      const mesh = new THREE.Mesh(geometry, material);
      mesh.castShadow = !!this.#host.castShadow;
      mesh.receiveShadow = !!this.#host.castShadow;
      group.add(mesh);
    }
    return { group, body: body.material, face: face.material, faceUniforms: face.uniforms, digits, dials, materials };
  }
}

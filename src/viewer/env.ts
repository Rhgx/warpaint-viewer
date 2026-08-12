import * as THREE from 'three';
import stockCubemaps from './stockCubemaps.generated.json';

const STOCK_CUBEMAPS: Readonly<Record<string, string>> = stockCubemaps;
const CUBEMAP_FACES = ['px', 'nx', 'py', 'ny', 'pz', 'nz'] as const;

export function materialCubemapIdentity(ref: string): string {
  return ref.trim().replace(/\\/g, '/').replace(/^(?:textures|materials)\//i, '')
    .replace(/\.(?:hdr\.)?(?:vtf|png|webp)$/i, '').replace(/^\/+/g, '').toLowerCase();
}

export function isStockMaterialCubemap(ref: string): boolean {
  const identity = materialCubemapIdentity(ref);
  return identity === 'env_cubemap' || identity === 'editor/cubemap' || identity in STOCK_CUBEMAPS;
}

// Cheap PMREM-less environment: a 6-face cube with a vertical sky->ground
// gradient, used to fake VertexLitGeneric's envmap reflections on the phong
// material. Subtle but enough to give specular highlights something to reflect.
export function makeEnvCube(sky: THREE.ColorRepresentation, ground: THREE.ColorRepresentation): THREE.CubeTexture {
  const size = 64;
  const skyC = new THREE.Color(sky);
  const groundC = new THREE.Color(ground);
  const horizon = skyC.clone().lerp(groundC, 0.5);

  const face = (top: THREE.Color, bottom: THREE.Color): HTMLCanvasElement => {
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    const ctx = c.getContext('2d')!;
    const grad = ctx.createLinearGradient(0, 0, 0, size);
    grad.addColorStop(0, `#${top.getHexString()}`);
    grad.addColorStop(1, `#${bottom.getHexString()}`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
    return c;
  };

  // order: px, nx, py, ny, pz, nz
  const sides = [
    face(skyC, groundC),
    face(skyC, groundC),
    face(skyC, skyC), // up
    face(groundC, groundC), // down
    face(skyC, groundC),
    face(skyC, groundC),
  ];
  void horizon;
  const tex = new THREE.CubeTexture(sides as unknown as HTMLImageElement[]);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

// TF2's CMDLPanel binds materials/editor/cubemap for item previews. The
// extraction pipeline writes its VTF faces in the order CubeTextureLoader
// expects, so reflections use the same image data as the game.
export function loadEditorEnvCube(
  onLoad: (texture: THREE.CubeTexture) => void,
  onError?: (error: unknown) => void,
): void {
  const root = `${import.meta.env.BASE_URL}data/env/editor-cubemap/`;
  new THREE.CubeTextureLoader().setPath(root).load(
    ['px.png', 'nx.png', 'py.png', 'ny.png', 'pz.png', 'nz.png'],
    (texture) => {
      // The shipped TF2 archives contain editor/cubemap.vtf (LDR), not an
      // editor/cubemap.hdr.vtf asset. VertexLitGeneric loads that LDR cubemap
      // with TEXTUREFLAGS_SRGB, so reflections must decode to linear before
      // the material's neutral envmap tint is applied.
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.needsUpdate = true;
      onLoad(texture);
    },
    undefined,
    onError,
  );
}

/** URLs for stock TF2 cubemaps that imported weapon VMTs commonly reference. */
export function stockMaterialCubemapUrls(ref: string): string[] | null {
  const identity = materialCubemapIdentity(ref);
  if (identity === 'env_cubemap') return null;
  if (identity === 'editor/cubemap') {
    const root = `${import.meta.env.BASE_URL}data/env/editor-cubemap/`;
    return CUBEMAP_FACES.map((face) => `${root}${face}.png`);
  }
  const directory = STOCK_CUBEMAPS[identity];
  if (!directory) return null;
  const root = `${import.meta.env.BASE_URL}data/effects/material-cubemaps/${directory}/`;
  return CUBEMAP_FACES.map((face) => `${root}${face}.png`);
}

export function loadMapSkybox(skybox: string): Promise<THREE.CubeTexture> {
  const root = `${import.meta.env.BASE_URL}data/env/maps/${skybox}/`;
  return new THREE.CubeTextureLoader().setPath(root).loadAsync([
    'px.png', 'nx.png', 'py.png', 'ny.png', 'pz.png', 'nz.png',
  ]).then((texture) => {
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    return texture;
  });
}

import * as THREE from 'three';
import { CUBEMAP_FACES } from './stockCubemapUrls';

// Cheap PMREM-less environment: a 6-face sky-to-ground gradient cube that fakes
// VertexLitGeneric envmap reflections on the phong material.
export function makeEnvCube(sky: THREE.ColorRepresentation, ground: THREE.ColorRepresentation): THREE.CubeTexture {
  const size = 64;
  const skyC = new THREE.Color(sky);
  const groundC = new THREE.Color(ground);

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
  const tex = new THREE.CubeTexture(sides);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

// TF2's CMDLPanel binds materials/editor/cubemap for item previews. The extraction
// pipeline writes its faces in CubeTextureLoader order, so the image data matches.
export function loadEditorEnvCube(
  onLoad: (texture: THREE.CubeTexture) => void,
  onError?: (error: unknown) => void,
): void {
  const root = `${import.meta.env.BASE_URL}data/env/editor-cubemap/`;
  new THREE.CubeTextureLoader().setPath(root).load(
    CUBEMAP_FACES.map((face) => `${face}.png`),
    (texture) => {
      // Shipped archives only have the LDR editor/cubemap.vtf. VertexLitGeneric loads it
      // with TEXTUREFLAGS_SRGB, so it must decode to linear before the envmap tint is applied.
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.needsUpdate = true;
      onLoad(texture);
    },
    undefined,
    onError,
  );
}

import * as THREE from 'three';

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
  const root = '/data/env/editor-cubemap/';
  new THREE.CubeTextureLoader().setPath(root).load(
    ['px.png', 'nx.png', 'py.png', 'ny.png', 'pz.png', 'nz.png'],
    (texture) => {
      // skin_dx9_helper.cpp only enables sRGB reads on the envmap sampler when
      // HDR_TYPE_NONE; TF2 runs HDR and editor/cubemap is an LDR texture, so
      // the game feeds its stored gamma values straight into lighting math.
      // Decoding to linear here made reflections ~5x too dim on metal.
      texture.colorSpace = THREE.NoColorSpace;
      texture.needsUpdate = true;
      onLoad(texture);
    },
    undefined,
    onError,
  );
}

export function loadMapSkybox(skybox: string): Promise<THREE.CubeTexture> {
  const root = `/data/env/maps/${skybox}/`;
  return new THREE.CubeTextureLoader().setPath(root).loadAsync([
    'px.png', 'nx.png', 'py.png', 'ny.png', 'pz.png', 'nz.png',
  ]).then((texture) => {
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    return texture;
  });
}

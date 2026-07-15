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
  tex.needsUpdate = true;
  return tex;
}

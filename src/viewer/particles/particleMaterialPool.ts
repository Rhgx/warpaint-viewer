// Pooled particle ShaderMaterials, reused across effects so their shader programs stay compiled.
import * as THREE from 'three';

import { PARTICLE_FRAGMENT, PARTICLE_VERTEX, applyAdditiveBlending, particlePointScale } from './particleRenderer';
import { dotTexture } from './util';

// Disposing a material at teardown would drop its program to zero users, so the next
// effect would recompile the shader: a blocking compile on every weapon switch. Pooled
// materials keep the program alive.
const particleMaterialPool: THREE.ShaderMaterial[] = [];

export function takeParticleMaterial(): THREE.ShaderMaterial {
  const material = particleMaterialPool.pop() ?? new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: dotTexture() },
      uFrames: { value: 1 },
      uPointScale: particlePointScale,
    },
    vertexShader: PARTICLE_VERTEX,
    fragmentShader: PARTICLE_FRAGMENT,
    transparent: true,
    depthWrite: false,
    depthTest: true,
  });
  material.uniforms.uMap.value = dotTexture();
  material.uniforms.uFrames.value = 1;
  applyAdditiveBlending(material);
  material.needsUpdate = true;
  return material;
}

export function releaseParticleMaterial(material: THREE.ShaderMaterial) {
  particleMaterialPool.push(material);
}

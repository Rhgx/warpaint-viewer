import * as THREE from 'three';

import { TF2_VERTEXLIT_CACHE_KEY, installTf2VertexLit } from '../viewer/shaders/vertexlit';
import type { Tf2Uniforms } from '../viewer/materialConfig';

// Procedural canvas textures for the board and the TF2 material weapons wear on it.
/** The viewer's TF2 VertexLitGeneric shading on a board weapon; the shader decodes the sRGB composite itself. */
export function makeTf2Material(uniforms: Tf2Uniforms, envMap: THREE.CubeTexture): THREE.MeshPhongMaterial {
  const material = new THREE.MeshPhongMaterial({
    color: 0x9a9a9a,
    shininess: 30,
    specular: new THREE.Color(0x333333),
    envMap,
    combine: THREE.AddOperation,
    reflectivity: 1,
  });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    installTf2VertexLit(shader);
  };
  material.customProgramCacheKey = () => `${TF2_VERTEXLIT_CACHE_KEY}-showcase`;
  return material;
}

export function pegboardTexture(): THREE.CanvasTexture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#6b5843';
  ctx.fillRect(0, 0, size, size);
  // Fibre noise keeps large boards from looking flat.
  for (let i = 0; i < 260; i += 1) {
    ctx.fillStyle = `rgba(${Math.random() < 0.5 ? '40,30,20' : '150,125,95'},${0.06 + Math.random() * 0.06})`;
    ctx.fillRect(Math.random() * size, Math.random() * size, 1 + Math.random() * 3, 1);
  }
  const hole = ctx.createRadialGradient(size / 2 - 2, size / 2 - 2, 1, size / 2, size / 2, size * 0.2);
  hole.addColorStop(0, '#1d150e');
  hole.addColorStop(0.75, '#2c2117');
  hole.addColorStop(1, 'rgba(60,45,32,0)');
  ctx.fillStyle = hole;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size * 0.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(180,150,115,0.35)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(size / 2 + 0.5, size / 2 + 0.5, size * 0.19, 0.1 * Math.PI, 0.65 * Math.PI);
  ctx.stroke();
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 8;
  return texture;
}

export function vignetteTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 288;
  const ctx = canvas.getContext('2d')!;
  const gradient = ctx.createRadialGradient(256, 144, 60, 256, 144, 300);
  gradient.addColorStop(0, 'rgba(0,0,0,0)');
  gradient.addColorStop(1, 'rgba(0,0,0,0.55)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 512, 288);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export const FRAME_SIDE = 7;
export function frameTexture(width: number, height: number): THREE.CanvasTexture {
  const scale = 8;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext('2d')!;
  const metal = ctx.createLinearGradient(0, 0, canvas.width * 0.35, canvas.height);
  metal.addColorStop(0, '#4a4d52');
  metal.addColorStop(0.45, '#2b2e32');
  metal.addColorStop(1, '#1f2225');
  ctx.fillStyle = metal;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const lip = (FRAME_SIDE - 0.6) * scale;
  ctx.strokeStyle = '#8d9196';
  ctx.lineWidth = 0.8 * scale;
  ctx.strokeRect(lip, lip, canvas.width - lip * 2, canvas.height - lip * 2);
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.lineWidth = scale * 0.5;
  ctx.strokeRect(scale * 0.4, scale * 0.4, canvas.width - scale * 0.8, canvas.height - scale * 0.8);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

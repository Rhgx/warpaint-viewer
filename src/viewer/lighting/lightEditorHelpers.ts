import * as THREE from 'three';
import type { CustomLight, FrameVector } from './customLighting';

export type LightEditorHandle = 'source' | 'target';

export function createAimHandleTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext('2d');
  if (!context) return new THREE.CanvasTexture(canvas);

  context.strokeStyle = '#ffffff';
  context.fillStyle = '#ffffff';
  context.lineWidth = 6;
  context.beginPath();
  context.arc(32, 32, 21, 0, Math.PI * 2);
  context.stroke();
  context.beginPath();
  context.moveTo(32, 3);
  context.lineTo(32, 16);
  context.moveTo(32, 48);
  context.lineTo(32, 61);
  context.moveTo(3, 32);
  context.lineTo(16, 32);
  context.moveTo(48, 32);
  context.lineTo(61, 32);
  context.stroke();
  context.beginPath();
  context.arc(32, 32, 4, 0, Math.PI * 2);
  context.fill();

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Later fingers of a multi-touch gesture belong to the camera, never to a light. */
export function isSecondaryTouch(event: PointerEvent): boolean {
  return event.pointerType === 'touch' && !event.isPrimary;
}

export function clientToNdc(canvas: HTMLCanvasElement, clientX: number, clientY: number): THREE.Vector2 {
  const bounds = canvas.getBoundingClientRect();
  return new THREE.Vector2(
    ((clientX - bounds.left) / Math.max(1, bounds.width)) * 2 - 1,
    -((clientY - bounds.top) / Math.max(1, bounds.height)) * 2 + 1,
  );
}

export function pointDistanceToClient(
  point: THREE.Vector3,
  camera: THREE.Camera,
  canvas: HTMLCanvasElement,
  clientX: number,
  clientY: number,
): number {
  const projected = point.clone().project(camera);
  const bounds = canvas.getBoundingClientRect();
  const x = bounds.left + (projected.x + 1) * 0.5 * bounds.width;
  const y = bounds.top + (1 - projected.y) * 0.5 * bounds.height;
  return Math.hypot(x - clientX, y - clientY);
}

export function setObjectColor(object: THREE.Object3D, color: number): void {
  object.traverse((child) => {
    const material = (child as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
    if (!material) return;
    if (Array.isArray(material)) {
      for (const item of material) setMaterialColor(item, color);
    } else {
      setMaterialColor(material, color);
    }
  });
}

function setMaterialColor(material: THREE.Material, color: number): void {
  if (
    material instanceof THREE.MeshBasicMaterial
    || material instanceof THREE.LineBasicMaterial
    || material instanceof THREE.MeshPhongMaterial
  ) {
    material.color.setHex(color);
  }
}

export function disposeObjectResources(object: THREE.Object3D, disposeGeometry = true): void {
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (disposeGeometry && mesh.geometry) mesh.geometry.dispose();
    const material = mesh.material;
    if (Array.isArray(material)) material.forEach((item) => item.dispose());
    else if (material) material.dispose();
  });
}

export function updateDefinition(light: CustomLight, handle: LightEditorHandle, value: FrameVector): CustomLight | null {
  if (light.type === 'point') return handle === 'source' ? { ...light, position: value } : null;
  if (light.type === 'spot') return handle === 'source' ? { ...light, position: value } : { ...light, target: value };
  if (handle === 'source') {
    const direction = new THREE.Vector3(...value);
    if (direction.lengthSq() < 1e-5) return light;
    direction.normalize().multiplyScalar(-1);
    return { ...light, direction: [direction.x, direction.y, direction.z] };
  }
  const source = new THREE.Vector3(...light.direction).multiplyScalar(-10);
  const target = new THREE.Vector3(...value);
  const direction = target.sub(source).normalize();
  return { ...light, direction: [direction.x, direction.y, direction.z] };
}

// Particle state and module scratch objects shared by the sim and its initializers.
import * as THREE from 'three';

export const DEG2RAD = Math.PI / 180;

export interface SimParticle {
  alive: boolean;
  age: number;
  lifetime: number;
  systemAgeAtSpawn: number;
  spawnIndex: number;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  baseRadius: number;
  alphaBase: number;
  rotationDeg: number;
  colorInit: THREE.Color;
  // Per-particle randomness frozen at spawn so the fade/lock windows do not
  // reshuffle every tick (the SDK derives these from the particle id).
  rndFadeIn: number;
  rndFadeOut: number;
  rndLockStart: number;
  rndLockEnd: number;
  rndPhase: number;
  // Sprite-sheet UV rect [x0,y0,x1,y1] picked at spawn by Sequence Random, or the full
  // texture when the material has no sheet.
  uvRect: [number, number, number, number];
}

export const tmpV1 = new THREE.Vector3();
export const tmpV2 = new THREE.Vector3();
export const tmpV3 = new THREE.Vector3();
export const tmpC1 = new THREE.Color();

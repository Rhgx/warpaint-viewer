import type { Team } from '../data/types';
import {
  createDefaultCustomLightingRig,
  validateCustomLightingRig,
} from './customLighting';
import type { CustomLightingRig } from './customLighting';

const LIGHTING_STORAGE_KEY = 'warpaint-viewer.custom-lighting';

export function loadCustomLighting(): CustomLightingRig {
  if (typeof window === 'undefined') return createDefaultCustomLightingRig();
  try {
    const raw = window.localStorage.getItem(LIGHTING_STORAGE_KEY);
    return raw ? validateCustomLightingRig(JSON.parse(raw)) : createDefaultCustomLightingRig();
  } catch {
    return createDefaultCustomLightingRig();
  }
}

export function saveCustomLighting(rig: CustomLightingRig): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(LIGHTING_STORAGE_KEY, JSON.stringify(validateCustomLightingRig(rig)));
  } catch {
    // Storage can be unavailable in private browsing or embedded contexts.
  }
}

export interface ControlsState {
  weaponKey: string;
  wearIndex: number;
  team: Team;
  seed: string;
  preset: string;
  sheen: string;
  unusual: string;
  fov: number;
  projection: 'perspective' | 'orthographic';
  screenshotScale: number;
  customLighting: CustomLightingRig;
}

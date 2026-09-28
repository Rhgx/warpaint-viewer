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

/** One inspect-panel revolution: tf_item_inspect_model_spin_rate is 30 deg/s. */
export const TURNTABLE_SECONDS = 12;

export type TurntableFormat = 'gif' | 'webp' | 'apng' | 'mp4';
/** Encoder effort: WebP quality or MP4 bitrate level; GIF and APNG have none. */
export type TurntableQuality = 'standard' | 'high' | 'maximum';

export interface TurntableProfile {
  /** Output long edge in pixels. */
  maxEdge: number;
  fps: number;
  quality: TurntableQuality;
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
  /** Which export the toolbar's Save button produces; the Capture section shows only its settings. */
  captureFormat: 'image' | 'animated';
  screenshotMaxEdge: number;
  /** Animated capture format; see TURNTABLE_FORMATS. */
  turntableFormat: TurntableFormat;
  /** Size, frame rate and quality remembered separately for each format. */
  turntableProfiles: Record<TurntableFormat, TurntableProfile>;
  turntableTransparent: boolean;
  /** '#rrggbb' background for solid animated exports; MP4 always uses it. */
  turntableColor: string;
}

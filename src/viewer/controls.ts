import type { Team } from '../data/types';

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
}

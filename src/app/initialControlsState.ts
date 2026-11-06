import type { ControlsState } from '../viewer/controls';
import { DEFAULT_VIEWER_FOV } from '../viewer/presets';
import { randomSeed } from '../hooks/useBootData';
import { TURNTABLE_FORMATS } from '../export/turntableFormats';

export function createInitialControlsState(): ControlsState {
  return {
    weaponKey: '',
    wearIndex: 0,
    team: 'red',
    seed: randomSeed(),
    preset: 'inspect',
    sheen: 'none',
    unusual: 'none',
    statClocks: {},
    fov: DEFAULT_VIEWER_FOV,
    projection: 'perspective',
    captureFormat: 'image',
    screenshotMaxEdge: 1920,
    turntableFormat: 'gif',
    turntableProfiles: {
      gif: TURNTABLE_FORMATS.gif.defaults,
      webp: TURNTABLE_FORMATS.webp.defaults,
      apng: TURNTABLE_FORMATS.apng.defaults,
      mp4: TURNTABLE_FORMATS.mp4.defaults,
    },
    turntableTransparent: true,
    turntableColor: '#1c1f24',
  };
}

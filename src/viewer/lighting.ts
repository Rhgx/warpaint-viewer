import * as THREE from 'three';

// Lighting presets. The "Inspect" preset approximates the in-game item inspect
// view (tf_item_inspection_panel.cpp / CEmbeddedItemModelPanel): a clean, evenly
// lit studio setup with a strong key, soft fill and a back rim so the weapon
// reads clearly while spinning. The others are ambient + directional (+ rim)
// combos evoking the named maps.

export interface LightingPreset {
  id: string;
  label: string;
  build: () => THREE.Light[];
  background: number; // scene background color for this environment
}

function dir(color: number, intensity: number, x: number, y: number, z: number): THREE.DirectionalLight {
  const l = new THREE.DirectionalLight(color, intensity);
  l.position.set(x, y, z);
  return l;
}

export const LIGHTING_PRESETS: LightingPreset[] = [
  {
    id: 'inspect',
    label: 'Inspect (itemtest)',
    background: 0x1c1f24,
    build: () => [
      new THREE.HemisphereLight(0xffffff, 0x606060, 0.9),
      dir(0xffffff, 1.5, 1.2, 1.6, 1.4), // key, front-upper-right
      dir(0xdfe6ff, 0.55, -1.4, 0.4, 0.8), // cool fill from the left
      dir(0xffffff, 0.7, -0.3, 0.6, -1.6), // back rim
    ],
  },
  {
    id: 'daylight',
    label: 'Daylight (Badlands)',
    background: 0x9fb8d6,
    build: () => [
      new THREE.HemisphereLight(0xbfd4ff, 0x8a6b45, 0.75), // blue sky, warm ground
      dir(0xfff2d6, 2.1, 2.0, 2.4, 1.0), // warm sun, high
      dir(0xffe0b0, 0.4, -1.5, 0.3, -1.0),
    ],
  },
  {
    id: 'overcast',
    label: 'Overcast (Sawmill)',
    background: 0x8f959b,
    build: () => [
      new THREE.HemisphereLight(0xc8ccd0, 0x707478, 1.15), // flat, even
      dir(0xd8dade, 0.5, 0.6, 1.8, 0.5),
    ],
  },
  {
    id: 'indoors',
    label: 'Indoors (2fort intel)',
    background: 0x2b2620,
    build: () => [
      new THREE.HemisphereLight(0x6a6250, 0x201c16, 0.5),
      dir(0xffd9a0, 1.0, 0.8, 1.2, 0.9), // warm ceiling lamp
      dir(0x557a66, 0.25, -1.0, 0.2, -0.8), // faint green bounce
    ],
  },
  {
    id: 'night',
    label: 'Night (Halloween)',
    background: 0x0c0f18,
    build: () => [
      new THREE.HemisphereLight(0x2a3350, 0x0a0c14, 0.4),
      dir(0x9fb4ff, 0.9, -1.0, 1.8, 0.6), // moonlight
      dir(0xff3fae, 0.5, 1.4, 0.3, -1.2), // spooky magenta rim
      dir(0x54ff8a, 0.3, 0.2, -0.6, 1.4), // eerie green underlight
    ],
  },
];

export function getPreset(id: string): LightingPreset {
  return LIGHTING_PRESETS.find((p) => p.id === id) ?? LIGHTING_PRESETS[0];
}

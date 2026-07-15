import type { Manifest, Team } from '../types';
import type { RecipeNode } from '../../compositor/types';

// Handcrafted mock so the whole pipeline (gallery -> composite -> mesh) runs with
// zero pipeline output. Two paintkits, one weapon. Recipes exercise
// texture_lookup + combine_lerp + select (kit 9001) and texture_lookup +
// combine_multiply with seeded adjust ranges (kit 9002).

export const mockManifest: Manifest = {
  generatedAt: new Date(0).toISOString(),
  paintkits: [
    {
      id: 9001,
      name: 'Mock Hazard Warning',
      collection: 'Mock Collection',
      hasTeamTextures: true,
      perWear: true,
      weapons: ['c_mock_smg'],
    },
    {
      id: 9002,
      name: 'Mock Rustbucket',
      collection: 'Mock Collection',
      hasTeamTextures: false,
      perWear: true,
      weapons: ['c_mock_smg'],
    },
  ],
  weapons: [
    {
      key: 'c_mock_smg',
      name: 'Mock SMG',
      model: 'models/__missing__.glb', // intentionally absent -> placeholder mesh
      material: {
        phongExponent: 12,
        phongBoost: 1.4,
        envmapTint: [0.35, 0.35, 0.35],
        normalMap: null,
        phong: true,
        phongExponentFactor: null,
      },
    },
  ],
  wearLevels: [0.2, 0.4, 0.6, 0.8, 1.0],
  wearNames: ['Factory New', 'Minimal Wear', 'Field-Tested', 'Well-Worn', 'Battle Scarred'],
};

// Recipes follow the amended pipeline schema: combines carry the full transform
// set, selects are leaves with raw 0..255 group ids, flips are plain booleans.
function hazardRecipe(team: Team): RecipeNode {
  const baseTex = team === 'red' ? 'mock/camo' : 'mock/rust';
  return {
    type: 'combine_lerp',
    adjustBlack: [0, 0],
    adjustOffset: [1, 1],
    adjustGamma: [1, 1],
    rotation: [0, 0],
    translateU: [0, 0],
    translateV: [0, 0],
    scaleUV: [1, 1],
    flipU: false,
    flipV: false,
    nodes: [
      {
        type: 'texture_lookup',
        texture: baseTex,
        rotation: [0, 360],
        scaleUV: [1, 3],
        translateU: [0, 1],
        translateV: [0, 1],
        flipU: false,
        flipV: false,
      },
      {
        type: 'texture_lookup',
        texture: 'mock/hazard',
        rotation: [0, 90],
        scaleUV: [1, 2],
        flipU: true,
        flipV: false,
      },
      // Selector leaf: white over group id 16 (left half of the groups map).
      { type: 'select', groups: 'mock/groups', select: [16] },
    ],
  };
}

function rustRecipe(): RecipeNode {
  return {
    type: 'combine_multiply',
    // Non-identity combine transform to exercise the output post-pass.
    adjustBlack: [0, 0],
    adjustOffset: [1, 1],
    adjustGamma: [0.8, 1.2],
    rotation: [0, 0],
    translateU: [0, 0],
    translateV: [0, 0],
    scaleUV: [1, 1],
    flipU: false,
    flipV: false,
    nodes: [
      {
        type: 'texture_lookup',
        texture: 'mock/rust',
        adjustBlack: [0, 0.2],
        adjustOffset: [0.8, 1],
        adjustGamma: [1, 1.5],
        rotation: [0, 360],
      },
      {
        type: 'texture_lookup',
        texture: 'mock/checker',
        scaleUV: [2, 2],
      },
      {
        type: 'texture_lookup',
        texture: 'mock/camo',
        scaleUV: [1, 1],
      },
    ],
  };
}

export function mockRecipe(paintkitId: number, _weaponKey: string, team: Team): RecipeNode | null {
  if (paintkitId === 9001) return hazardRecipe(team);
  if (paintkitId === 9002) return rustRecipe();
  return null;
}

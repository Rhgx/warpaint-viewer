import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import * as THREE from 'three';
import { canvasOutputToHex, normaliseColorValue } from '../../../src/viewer/lighting/customLightingModel';

// THREE warns about every input it rejects. The table is meant to produce those warnings, so silence them.
vi.spyOn(console, 'warn').mockImplementation(() => {});

// The colour the rig validator must reproduce, as THREE.Color resolves it.
function threeHex(input: string): string {
  return `#${new THREE.Color(input).getHexString()}`;
}

// Stands in for the browser canvas: resolves a CSS colour the way the browser would.
function stubCanvas(style: string): string {
  return threeHex(style);
}

// Hex never reaches the canvas, so these must resolve without calling the resolver.
const HEX_CASES = ['#abc', '#ABC', '#aabbcc', '#AABBCC', '#0a1B2c', '#fff', '#000000'];

// [input, accepted by THREE.Color]. Accepted entries must reach the resolver; rejected ones must
// stay white without it.
const STYLE_CASES: ReadonlyArray<readonly [string, boolean]> = [
  ['white', true],
  ['red', true],
  ['rebeccapurple', true],
  ['Gold', true],
  ['GOLD', true],
  ['transparent', false],
  ['buttonface', false],
  ['  red ', false],
  ['rgb(255, 0, 0)', true],
  ['rgb(1,2,3)', true],
  ['rgb( 10 , 20 , 30 )', true],
  ['rgb(300, 0, 0)', true],
  ['rgb(100%, 0%, 50%)', true],
  ['rgb(1,2,3) trailing', true],
  ['RGB(1,2,3)', false],
  ['rgb(1.5, 2, 3)', false],
  ['rgb(1, 2)', false],
  ['rgba(255, 0, 0, 0.5)', true],
  ['rgba(0,0,255,0)', true],
  ['rgba(100%,0%,0%,0.5)', true],
  ['rgba(1,2,3,.5)', true],
  ['hsl(120, 50%, 50%)', true],
  ['hsla(0, 100%, 50%, 0.5)', true],
  ['hsl(360, 100%, 50%)', true],
  ['hsl(120deg, 50%, 50%)', false],
  ['hsl(120, 50, 50)', false],
  ['hsl(-30, 50%, 50%)', false],
  ['#abcd', false],
  ['#ffffffff', false],
  ['#12', false],
  ['#gggggg', false],
  ['#ff0000 ', false],
  [' #ff0000', false],
  ['', false],
  ['garbage', false],
  ['fff', false],
];

test('hex colours expand without the canvas, matching THREE.Color', () => {
  const noCanvas = (): string => {
    throw new Error('hex must not reach the canvas');
  };
  for (const input of HEX_CASES) {
    assert.equal(normaliseColorValue(input, noCanvas), threeHex(input), input);
  }
});

test('style strings match THREE.Color, with the canvas consulted only for accepted styles', () => {
  for (const [input, accepted] of STYLE_CASES) {
    let calls = 0;
    const resolver = (style: string): string => {
      calls++;
      return stubCanvas(style);
    };
    const actual = normaliseColorValue(input, resolver);
    assert.equal(actual, threeHex(input), `THREE disagrees with the table for ${JSON.stringify(input)}`);
    // hsl() is computed in code (the canvas rounds it differently), so only other styles reach the canvas.
    const viaCanvas = accepted && !/^hsla?\(/.test(input);
    assert.equal(calls, viaCanvas ? 1 : 0, `canvas calls for ${JSON.stringify(input)}`);
    if (!accepted) assert.equal(actual, '#ffffff', `rejected ${JSON.stringify(input)} must be white`);
  }
});

// Seeded sweep: hsl() must round exactly as THREE does, one unit off would be a visible change.
test('hsl values match THREE.Color across a seeded sweep', () => {
  let seed = 7;
  const next = (limit: number): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % limit;
  };
  for (let i = 0; i < 3000; i++) {
    const input = `hsl(${next(400)}.${next(100)}, ${next(130)}%, ${next(130)}%)`;
    assert.equal(normaliseColorValue(input, () => null), threeHex(input), input);
  }
});

test('non-string values become white without the canvas', () => {
  const noCanvas = (): string => {
    throw new Error('non-string must not reach the canvas');
  };
  assert.equal(normaliseColorValue(undefined, noCanvas), '#ffffff');
  assert.equal(normaliseColorValue(42, noCanvas), '#ffffff');
  assert.equal(normaliseColorValue(null, noCanvas), '#ffffff');
});

test('canvas output converts to hex and drops alpha', () => {
  assert.equal(canvasOutputToHex('#FF0000'), '#ff0000');
  assert.equal(canvasOutputToHex('#0a1b2c'), '#0a1b2c');
  assert.equal(canvasOutputToHex('rgba(255, 0, 0, 0.5)'), '#ff0000');
  assert.equal(canvasOutputToHex('rgba(0, 0, 0, 0)'), '#000000');
  assert.equal(canvasOutputToHex('rgb(1, 2, 3)'), '#010203');
  assert.equal(canvasOutputToHex('transparent'), null);
  assert.equal(canvasOutputToHex('garbage'), null);
});

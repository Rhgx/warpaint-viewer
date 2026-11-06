import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { DEFAULT_KILLS, MAX_KILLS, STAT_CLOCK_DIGITS, isValidKills, parseKills, supportsStatClock } from '../../../src/data/statClock';
import { dialFrame } from '../../../src/viewer/statClock';
import { parseSavedBoard } from '../../../src/showcase/boardStorage';

interface Extracted {
  dial: { frames: number; digits: number };
  placements: Record<string, { pos: number[]; quat: number[]; scale: number }>;
}

const extracted = JSON.parse(readFileSync('public/data/stat-clock/stat-clock.json', 'utf8')) as Extracted;
const manifest = JSON.parse(readFileSync('public/data/manifest.json', 'utf8')) as { weapons: { key: string }[] };
const viewmodels = JSON.parse(readFileSync('public/data/viewmodels/manifest.json', 'utf8')) as { weapons: { weaponKey: string; class: string; model: string }[] };

function glbNodeNames(file: string): string[] {
  const bytes = readFileSync(file);
  const document = JSON.parse(bytes.toString('utf8', 20, 20 + bytes.readUInt32LE(12))) as { nodes: { name?: string }[] };
  return document.nodes.map((node) => node.name ?? '');
}

describe('first person', () => {
  it('has the clock bone and a size on every viewmodel of a weapon that takes a clock', () => {
    for (const view of viewmodels.weapons) {
      const label = `${view.weaponKey}/${view.class}`;
      expect(glbNodeNames(`public/data/viewmodels/${view.model}`).includes('c_weapon_stattrack'), label).toBe(supportsStatClock(view.weaponKey));
      expect(extracted.placements[view.weaponKey]?.scale !== undefined, label).toBe(supportsStatClock(view.weaponKey));
    }
  });
});

describe('kill count', () => {
  it('takes whole numbers the six digits can show', () => {
    expect(STAT_CLOCK_DIGITS).toBe(6);
    expect(parseKills('0')).toBe(0);
    expect(parseKills(' 1337 ')).toBe(1337);
    expect(parseKills('007')).toBe(7);
    expect(parseKills('999999')).toBe(MAX_KILLS);
  });

  it('stops at the most the digits can show', () => {
    expect(parseKills('1000000')).toBe(MAX_KILLS);
    expect(parseKills('99999999999999999999999')).toBe(MAX_KILLS);
  });

  it('turns down anything else', () => {
    for (const text of ['', '   ', '-1', '1.5', '1e3', 'twelve', '12a']) expect(parseKills(text)).toBeNull();
    for (const value of [-1, 1.5, MAX_KILLS + 1, Number.NaN, '12', null]) expect(isValidKills(value)).toBe(false);
    expect(isValidKills(DEFAULT_KILLS)).toBe(true);
  });

  it('reads each digit the way the game does, digit 0 being the ones', () => {
    const digits = (kills: number) => Array.from({ length: STAT_CLOCK_DIGITS }, (_, digit) => dialFrame(kills, digit));
    expect(digits(0)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(digits(1337)).toEqual([7, 3, 3, 1, 0, 0]);
    expect(digits(MAX_KILLS)).toEqual([9, 9, 9, 9, 9, 9]);
    expect(extracted.dial.frames).toBe(10);
    expect(extracted.dial.digits).toBe(STAT_CLOCK_DIGITS);
  });
});

describe('extracted data', () => {
  it('has a placement for every weapon that can have a clock and none for any other', () => {
    for (const { key } of manifest.weapons) {
      expect(key in extracted.placements, key).toBe(supportsStatClock(key));
    }
    expect(supportsStatClock('c_flameball')).toBe(false);
  });

  it('holds sizes and unit rotations that make sense', () => {
    for (const [key, { pos, quat, scale }] of Object.entries(extracted.placements)) {
      expect(pos.length, key).toBe(3);
      expect(Math.hypot(...quat), key).toBeCloseTo(1, 3);
      expect(scale, key).toBeGreaterThan(0);
      expect(scale, key).toBeLessThanOrEqual(2);
    }
    // From items_game: a weapon that names a size, and one that leaves it to the client's default of 1.
    expect(extracted.placements.c_scattergun.scale).toBe(0.608);
    expect(extracted.placements.c_blackbox.scale).toBe(1);
  });
});

describe('saved boards', () => {
  const saved = (extra: Record<string, unknown>) => ({
    version: 1,
    items: [{
      id: 'a', weaponKey: 'c_knife', weaponName: 'Knife', paint: { kitId: 1, kitName: 'x', team: 'red', wearIndex: 0, seed: '1' },
      x: 0, y: 0, roll: 0, tilt: 0, turn: 0, scale: 1, flipped: false, hidden: false, pose: {}, part: null, hiddenParts: [], ...extra,
    }],
  });

  it('reads a save from before the Stat Clock as having none', () => {
    const [item] = parseSavedBoard(saved({})) ?? [];
    expect(item.statClock).toBeUndefined();
    expect(item.killCount).toBeUndefined();
  });

  it('keeps a clock and its count', () => {
    const [item] = parseSavedBoard(saved({ statClock: true, killCount: 12 })) ?? [];
    expect(item.statClock).toBe(true);
    expect(item.killCount).toBe(12);
  });

  it('refuses a count the digits cannot show', () => {
    expect(parseSavedBoard(saved({ statClock: true, killCount: MAX_KILLS + 1 }))).toBeNull();
    expect(parseSavedBoard(saved({ statClock: 'yes' }))).toBeNull();
  });
});

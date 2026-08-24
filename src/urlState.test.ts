import { describe, expect, it } from 'vitest';
import { decodeShareState, encodeShareState } from './urlState';

describe('share-state compression dictionaries', () => {
  it.each([
    ['AX_eAi7SCh_rjKlUqwMIBgY8', 'paintkit_tool', 'hot_rod', 'sparkle', 'inspect-legacy'],
    ['AX_eAh3SCh_rjKlUqwMFBQM8', 'c_rocketlauncher', 'mean_green', 'energy_orb', 'overcast'],
  ])('keeps pinned v1 payload %s compatible', (payload, weaponKey, sheen, unusual, preset) => {
    expect(decodeShareState(payload)).toEqual({
      kitId: 350,
      weaponKey,
      seed: '12345678901234567890',
      wearIndex: 3,
      team: 'blu',
      sheen,
      unusual,
      preset,
      projection: 'orthographic',
      fov: 90,
    });
  });

  it('round-trips future ids without adding them to the codec', () => {
    const payload = encodeShareState({
      kitId: 123,
      weaponKey: 'c_future_weapon',
      seed: '18446744073709551615',
      wearIndex: 2,
      team: 'blu',
      sheen: 'future_sheen',
      unusual: 'future_effect',
      preset: 'future_light',
      projection: 'orthographic',
      fov: 90,
    });

    expect(payload).not.toBeNull();
    expect(decodeShareState(payload!)).toEqual({
      kitId: 123,
      weaponKey: 'c_future_weapon',
      seed: '18446744073709551615',
      wearIndex: 2,
      team: 'blu',
      sheen: 'future_sheen',
      unusual: 'future_effect',
      preset: 'future_light',
      projection: 'orthographic',
      fov: 90,
    });
  });

  it('rejects invalid serializable boundaries without throwing', () => {
    const valid = {
      kitId: 123,
      weaponKey: 'c_knife',
      seed: '42',
      wearIndex: 0,
      team: 'red' as const,
      sheen: 'none',
      unusual: 'none',
      preset: 'inspect',
      projection: 'perspective' as const,
      fov: 75,
    };

    expect(encodeShareState({ ...valid, seed: 'not-a-number' })).toBeNull();
    expect(encodeShareState({ ...valid, kitId: -1 })).toBeNull();
    expect(encodeShareState({ ...valid, kitId: Number.MAX_SAFE_INTEGER + 1 })).toBeNull();
  });
});

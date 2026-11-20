import { describe, expect, it } from 'vitest';

import { pushSeedHistory, stepSeedRedo, stepSeedUndo, type SeedHistoryStacks } from '../../../src/app/useSeedHistory';
import type { OperationTemplateData, PaintkitEntry } from '../../../src/data/types';
import { customKitId } from '../../../src/protodefs/types';
import { stepGridVertical } from '../../../src/ui/catalog/gridNavigation';
import { operationFilterKits } from '../../../src/ui/catalog/operationFilter';
import { matchesSearch } from '../../../src/ui/common/searchText';

describe('search text normalization', () => {
  it('ignores apostrophes, punctuation, and diacritics', () => {
    expect(matchesSearch("High Roller's", 'high rollers')).toBe(true);
    expect(matchesSearch("High Roller's", "high roller's")).toBe(true);
    expect(matchesSearch('Übersaw', 'Uber')).toBe(true);
    expect(matchesSearch('Übersaw', 'ubersaw')).toBe(true);
    expect(matchesSearch('Claidheamh Mòr', 'claidheamh mor')).toBe(true);
    expect(matchesSearch("Dragon's Fury", 'dragons fury')).toBe(true);
    expect(matchesSearch('Loch-n-Load', 'loch n load')).toBe(true);
    expect(matchesSearch('Bovine Blazemaker Mk.II', 'mk ii')).toBe(true);
    expect(matchesSearch('Rocket Launcher', 'scatter')).toBe(false);
  });
});

describe('operation catalog filter', () => {
  const kit = (id: number, name: string): PaintkitEntry => ({ id, name, collection: null, hasTeamTextures: false, weapons: [] });
  const paintkits = [
    kit(400, 'Alpha'),
    kit(401, 'Beta'),
    kit(402, 'Gamma'),
    kit(403, 'Delta'),
    kit(customKitId(402), 'Imported Gamma'),
  ];
  const data: OperationTemplateData = {
    templates: [],
    names: { '10': 'AO', '11': 'AO Glow', '12': 'Blend' },
    // The imported kit's id is offset, so it can only match by its own id.
    usage: { '10': [400, 401], '11': [402, customKitId(402)], '12': [403] },
  };

  it('prefers exact names over substrings, trims case-insensitively, and skips imported kits', () => {
    const ids = (query: string) => operationFilterKits(paintkits, data, query).map((k) => k.id);
    expect(ids('ao')).toEqual([400, 401]);
    expect(ids('  Ao  ')).toEqual([400, 401]);
    expect(ids('glo')).toEqual([402]);
    expect(ids('   ')).toEqual([]);
  });
});

describe('grouped grid vertical navigation', () => {
  const groups = [
    ['Single', [{ id: 1 }]],
    ['Partial', [{ id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }, { id: 6 }]],
    ['Next', [{ id: 7 }, { id: 8 }, { id: 9 }]],
  ] as const;

  it('moves cleanly across groups with partial rows using the grid column count', () => {
    expect(stepGridVertical(groups, 1, 4, 'down')).toBe(2);
    expect(stepGridVertical(groups, 2, 4, 'down')).toBe(6);
    // Column 2 on row 0 drops to the end of the shorter last row in the same group.
    expect(stepGridVertical(groups, 4, 4, 'down')).toBe(6);
    // From the partial last row (col 0), ArrowDown enters the next group at col 0.
    expect(stepGridVertical(groups, 6, 4, 'down')).toBe(7);
    // From col 2 of Next, ArrowUp lands on the last row of Partial (clamped to id 6).
    expect(stepGridVertical(groups, 9, 4, 'up')).toBe(6);
    // From col 0 of Partial row 0, ArrowUp lands on the single item in Single.
    expect(stepGridVertical(groups, 2, 4, 'up')).toBe(1);
    expect(stepGridVertical(groups, 4, 4, 'up')).toBe(1);
  });
});

describe('seed history stacks', () => {
  it('supports undo, redo, branching, and history cap', () => {
    const stacks: SeedHistoryStacks = { past: [], future: [] };
    let seed = '100';

    pushSeedHistory(stacks, seed, 3);
    seed = '200';
    pushSeedHistory(stacks, seed, 3);
    seed = '300';

    const u1 = stepSeedUndo(stacks, seed, 3);
    expect(u1).toBe('200');
    seed = u1!;

    const u2 = stepSeedUndo(stacks, seed, 3);
    expect(u2).toBe('100');
    seed = u2!;

    expect(stepSeedUndo(stacks, seed, 3)).toBeNull();

    const r1 = stepSeedRedo(stacks, seed, 3);
    expect(r1).toBe('200');
    seed = r1!;

    // Pushing a new seed clears redo history.
    pushSeedHistory(stacks, seed, 3);
    seed = '400';
    expect(stepSeedRedo(stacks, seed, 3)).toBeNull();

    // Exceeding the cap drops the oldest past entry.
    pushSeedHistory(stacks, seed, 3);
    seed = '500';
    pushSeedHistory(stacks, seed, 3);
    seed = '600';
    expect(stacks.past).toEqual(['200', '400', '500']);
  });
});

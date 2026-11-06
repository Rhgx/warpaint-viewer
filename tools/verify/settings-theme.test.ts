import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, test, vi } from 'vitest';

import { parseTheme, THEMES } from '../../src/settings';

const STORAGE_KEY = 'warpaint-viewer:settings';
const NOT_THEMES: readonly unknown[] = [undefined, null, '', 'solarized', 'DEFAULT', 'toString', '__proto__', 7, true, {}, ['midnight']];

const indexHtml = readFileSync('index.html', 'utf8');
const tokensCss = readFileSync('src/styles/tokens.css', 'utf8');

const stored = (state: unknown) => JSON.stringify({ state, version: 1 });
// Each of these must leave a reader on Default, whatever else it does.
const BAD_STORAGE: readonly (string | null)[] = [
  null,
  '',
  '{not json',
  'null',
  '7',
  '"midnight"',
  '[]',
  stored(null),
  stored('midnight'),
  stored({}),
  ...NOT_THEMES.filter((value) => value !== undefined).map((theme) => stored({ theme })),
];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

test('parseTheme keeps every known theme and turns anything else into Default', () => {
  for (const { id } of THEMES) assert.equal(parseTheme(id), id);
  for (const value of NOT_THEMES) assert.equal(parseTheme(value), 'default');
});

/** A fresh store, hydrated through zustand's default storage, window.localStorage. */
async function hydratedSettings(getItem: () => string | null) {
  vi.stubGlobal('window', { localStorage: { getItem, setItem: () => undefined, removeItem: () => undefined } });
  vi.resetModules();
  const { useSettings } = await import('../../src/settings');
  return useSettings.getState();
}

test('the store reads a saved theme and keeps the other settings', async () => {
  const state = await hydratedSettings(() => stored({ theme: 'ember', showcaseBoard: true }));
  assert.equal(state.theme, 'ember');
  assert.equal(state.showcaseBoard, true);
});

test('the store stays on Default for anything else in storage', async () => {
  for (const item of BAD_STORAGE) {
    assert.equal((await hydratedSettings(() => item)).theme, 'default', `from ${item}`);
  }
});

test('the store keeps settings saved before themes existed', async () => {
  const state = await hydratedSettings(() => stored({ showPaintkitDetails: true }));
  assert.equal(state.theme, 'default');
  assert.equal(state.showPaintkitDetails, true);
});

test('the store starts on Default when storage cannot be reached', async () => {
  const state = await hydratedSettings(() => {
    throw new Error('blocked');
  });
  assert.equal(state.theme, 'default');
});

/** Runs the real script from index.html against a stand-in page. */
function runBootScript(readItem: () => string | null) {
  const source = indexHtml.match(/<script data-theme-boot>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(source, 'index.html has no theme script');
  const page = { theme: null as string | null, themeColor: null as string | null };
  const document = {
    documentElement: {
      setAttribute: (name: string, value: string) => {
        assert.equal(name, 'data-theme');
        page.theme = value;
      },
    },
    querySelector: () => ({
      setAttribute: (name: string, value: string) => {
        assert.equal(name, 'content');
        page.themeColor = value;
      },
    }),
  };
  const localStorage = {
    getItem: (key: string) => {
      assert.equal(key, STORAGE_KEY);
      return readItem();
    },
  };
  new Function('document', 'localStorage', source)(document, localStorage);
  return page;
}

function tokensOf(theme: string): Map<string, string> {
  const selector = theme === 'default' ? ':root,' : `:root[data-theme='${theme}'],`;
  const start = tokensCss.indexOf(selector);
  assert.notEqual(start, -1, `tokens.css has no ${theme} block`);
  const block = tokensCss.slice(start, tokensCss.indexOf('}', start));
  return new Map([...block.matchAll(/(--[\w-]+):\s*(#[0-9a-f]+);/g)].map((match) => [match[1], match[2]]));
}

const OTHER_THEMES = THEMES.map((theme) => theme.id).filter((id) => id !== 'default');

test('the script in index.html applies a saved theme with its accent', () => {
  for (const id of OTHER_THEMES) {
    const page = runBootScript(() => stored({ theme: id }));
    assert.equal(page.theme, id);
    assert.equal(page.themeColor, tokensOf(id).get('--accent'));
  }
});

test('the script in index.html leaves the page alone for anything else', () => {
  for (const item of [...BAD_STORAGE, stored({ theme: 'default' })]) {
    assert.deepEqual(runBootScript(() => item), { theme: null, themeColor: null }, `from ${item}`);
  }
  assert.deepEqual(runBootScript(() => {
    throw new Error('blocked');
  }), { theme: null, themeColor: null });
});

test('index.html has the same first-paint colours as tokens.css', () => {
  assert.ok(indexHtml.includes(`html {\r\n        background: ${tokensOf('default').get('--bg')};`) || indexHtml.includes(`html {\n        background: ${tokensOf('default').get('--bg')};`));
  assert.ok(indexHtml.includes(`name="theme-color" content="${tokensOf('default').get('--accent')}"`));
  for (const id of OTHER_THEMES) {
    const rule = indexHtml.match(new RegExp(`html\\[data-theme='${id}'\\] \\{\\s*background: (#[0-9a-f]+);`));
    assert.equal(rule?.[1], tokensOf(id).get('--bg'), id);
  }
});

test('every theme sets the same colours', () => {
  const names = [...tokensOf('default').keys()].sort();
  assert.ok(names.includes('--stage-bg') && names.includes('--accent-text'));
  for (const id of OTHER_THEMES) assert.deepEqual([...tokensOf(id).keys()].sort(), names, id);
});

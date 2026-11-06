import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const oxlintBin = join(repoRoot, 'node_modules', 'oxlint', 'bin', 'oxlint');
const pluginPath = join(repoRoot, 'tools', 'lint', 'oxlint-plugin.mjs');

// Built from code points so this file contains no literal dashes for no-dashes to flag.
const EM = String.fromCharCode(0x2014);
const EN = String.fromCharCode(0x2013);

// Runs oxlint with only `rule` enabled over `files` and maps each file name to its messages.
function lintWith(rule, files) {
  const dir = mkdtempSync(join(tmpdir(), 'warpaint-lint-'));
  try {
    for (const [name, source] of Object.entries(files)) {
      writeFileSync(join(dir, name), source);
    }
    const configPath = join(dir, 'oxlintrc.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        plugins: [],
        categories: { correctness: 'off' },
        jsPlugins: [pluginPath],
        rules: { [rule]: 'error' },
      }),
    );
    const run = spawnSync(process.execPath, [oxlintBin, '-c', configPath, '--format=json', dir], {
      cwd: dir,
      encoding: 'utf8',
    });
    // oxlint exits 1 when it reports errors, so the exit status is not the signal here.
    const report = JSON.parse(run.stdout);
    const messages = new Map();
    for (const diagnostic of report.diagnostics) {
      const name = basename(diagnostic.filename);
      messages.set(name, [...(messages.get(name) ?? []), diagnostic.message]);
    }
    return messages;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const commentFixtures = {
  'divider.ts': '// ---- helpers ----\nexport const helper = 1;\n',
  'restated-name.ts': '// Parse config\nexport function parseConfig(input: string) {\n  return input;\n}\n',
  'seven-lines.ts': [
    '// The loader keeps one cache per tab so that switching between two',
    '// models does not reparse the texture set each time the user returns.',
    '// Entries are dropped on tab close, not on a timer, because the timer',
    '// fired during long renders and evicted textures that were still bound.',
    '// Keep this in step with the worker, which reads the same record shape.',
    '// The worker copies buffers, so a change here has to be mirrored there.',
    '// Reviewers should check both sides together when touching either one.',
    'export const cacheTabs = 1;',
    '',
  ].join('\n'),
  'six-lines.ts': [
    '// The loader keeps one cache per tab so that switching between two',
    '// models does not reparse the texture set each time the user returns.',
    '// Entries are dropped on tab close, not on a timer, because the timer',
    '// fired during long renders and evicted textures that were still bound.',
    '// Keep this in step with the worker, which reads the same record shape.',
    '// The worker copies buffers, so a change here has to be mirrored there.',
    'export const cacheTabs = 1;',
    '',
  ].join('\n'),
  'commented-out.ts': 'export function run() {\n  // const value = compute(input);\n  return 1;\n}\n',
  'jsdoc-type.ts': '/**\n * Loads a model.\n * @param {string} path\n */\nexport function loadModel(path: string) {\n  return path;\n}\n',
  'jsdoc-type.mjs': '/**\n * Loads a model.\n * @param {string} path\n */\nexport function loadModel(path) {\n  return path;\n}\n',
  'empty-tag.ts': '/**\n * Builds the pixel buffer.\n * @returns\n */\nexport function build() {\n  return 1;\n}\n',
  'todo-unlinked.ts': '// TODO: handle empty input\nexport const input = 1;\n',
  'todo-linked.ts': '// TODO: remove once #412 lands\nexport const input = 1;\n',
  'test-step.ts': '// Arrange\nexport const input = 1;\n',
  'one-line.ts': '// Keep the cache warm: the loader drops entries after one tick.\nexport const warm = true;\n',
  'directive.ts': '// oxlint-disable-next-line no-explicit-any\nexport const loose: any = 1;\n',
  'public-tag.ts': '/**\n * Lighting constants used by the viewer and the export path.\n * @public\n */\nexport const lighting = 1;\n',
  'license.ts': [
    '/*',
    ' * Sample library',
    ' *',
    ' * Copyright (c) 2026 Example Authors',
    ' *',
    ' * Permission is hereby granted, free of charge, to any person obtaining a copy',
    ' * of this software and associated documentation files (the "Software"), to deal',
    ' * in the Software without restriction, including without limitation the rights',
    ' * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell',
    ' * copies of the Software, and to permit persons to whom the Software is',
    ' * furnished to do so, subject to the following conditions:',
    ' */',
    'export const sample = 1;',
    '',
  ].join('\n'),
};

const dashFixtures = {
  'em-comment.ts': `// Retry later ${EM} the server is busy\nexport const retry = 1;\n`,
  'em-string.ts': `export const label = 'Ready ${EM} waiting';\n`,
  'em-template.ts': `export const message = \`Saved ${EM} ok\`;\n`,
  'en-jsx.tsx': `export function Pages() {\n  return <p>Pages 1 ${EN} 3</p>;\n}\n`,
  'plain-hyphen.ts': "// Pages 1-3, plain hyphen is fine\nexport const range = 'Pages 1-3, see notes (a); done.';\n",
};

const importFixtures = {
  'const-after-imports.ts': "import { a } from './a';\nexport const b = a;\n",
  'comment-after-imports.ts': "import { a } from './a';\n// Keep the order: b reads a at load.\nexport const b = a;\n",
  'blank-after-imports.ts': "import { a } from './a';\n\nexport const b = a;\n",
  'no-imports.ts': 'export const b = 1;\n',
  'imports-only.ts': "import { a } from './a';\n",
};

const packageImports = (count) =>
  Array.from({ length: count }, (_, index) => `import pkg${index} from 'pkg-${index}';`);
const localImports = (count) =>
  Array.from({ length: count }, (_, index) => `import local${index} from './local-${index}';`);
const importGroupFile = (lines) => `${lines.join('\n')}\nexport const b = 1;\n`;

const importGroupFixtures = {
  'ten-imports.ts': importGroupFile([...packageImports(6), '', ...localImports(4)]),
  'nine-imports.ts': importGroupFile([...packageImports(5), ...localImports(4)]),
  'missing-blank.ts': importGroupFile([...packageImports(6), ...localImports(4)]),
  'package-after-local.ts': importGroupFile([
    ...packageImports(5),
    '',
    ...localImports(5),
    "import late from 'late';",
  ]),
  'comment-between.ts': importGroupFile([
    ...packageImports(6),
    '',
    '// Local modules.',
    ...localImports(4),
  ]),
  'comment-no-blank.ts': importGroupFile([
    ...packageImports(6),
    '// Local modules.',
    ...localImports(4),
  ]),
};

const flaggedNames = (messages) => [...messages.keys()].sort();

describe('warpaint/no-low-value-comments', () => {
  test('flags dividers, restated names, long blocks, commented-out code, JSDoc types and empty tags', () => {
    const messages = lintWith('warpaint/no-low-value-comments', commentFixtures);
    assert.deepEqual(flaggedNames(messages), [
      'commented-out.ts',
      'divider.ts',
      'empty-tag.ts',
      'jsdoc-type.ts',
      'restated-name.ts',
      'seven-lines.ts',
      'test-step.ts',
      'todo-unlinked.ts',
    ]);
    assert.match(messages.get('divider.ts')[0], /section divider/u);
    assert.match(messages.get('restated-name.ts')[0], /repeats the name below it/u);
    assert.match(messages.get('seven-lines.ts')[0], /Cut this to 6 lines/u);
    assert.match(messages.get('commented-out.ts')[0], /commented-out code/u);
    assert.match(messages.get('jsdoc-type.ts')[0], /JSDoc type/u);
    assert.match(messages.get('empty-tag.ts')[0], /JSDoc tag that has no description/u);
    assert.match(messages.get('todo-unlinked.ts')[0], /Link the issue/u);
    assert.match(messages.get('test-step.ts')[0], /test step label/u);
  });

  test('keeps why-notes, directives, linked TODOs, license headers and @public tags', () => {
    const messages = lintWith('warpaint/no-low-value-comments', commentFixtures);
    for (const name of [
      'six-lines.ts',
      'one-line.ts',
      'directive.ts',
      'todo-linked.ts',
      'license.ts',
      'public-tag.ts',
      'jsdoc-type.mjs',
    ]) {
      assert.equal(messages.has(name), false, `${name} should not be flagged`);
    }
  });
});

describe('warpaint/no-raw-class-values', () => {
  test('flags raw colours and font sizes in class strings, and leaves theme values and plain data alone', () => {
    // Each raw value is split across two strings, so that this file does not trip the rule it tests.
    const messages = lintWith('warpaint/no-raw-class-values', {
      'hex.ts': "export const a = 'flex bg-" + "[#123456] p-1';\n",
      'rgb.ts': "export const a = 'hover:border-" + "[rgb(0_0_0/30%)]';\n",
      'size.ts': "export const a = 'text-" + "[8px] text-dim';\n",
      'template.ts': "const b = 'x';\nexport const a = `${b} fill-" + "[#fff]`;\n",
      'theme.ts': "export const a = 'bg-panel text-11 border-black/30 w-[310px] shadow-[0_1px_2px_var(--panel)]';\n",
      'data.ts': "export const a = '#1c1f24';\nexport const c = 'rgb(0 0 0)';\n",
    });
    assert.deepEqual(flaggedNames(messages), ['hex.ts', 'rgb.ts', 'size.ts', 'template.ts']);
  });
});

describe('warpaint/no-dashes', () => {
  test('flags em and en dashes in comments, string literals, template text and JSX text', () => {
    const messages = lintWith('warpaint/no-dashes', dashFixtures);
    assert.deepEqual(flaggedNames(messages), [
      'em-comment.ts',
      'em-string.ts',
      'em-template.ts',
      'en-jsx.tsx',
    ]);
    assert.match(messages.get('en-jsx.tsx')[0], /No em or en dashes/u);
  });

  test('leaves hyphens and other punctuation alone', () => {
    const messages = lintWith('warpaint/no-dashes', dashFixtures);
    assert.equal(messages.has('plain-hyphen.ts'), false);
  });
});

describe('warpaint/newline-after-imports', () => {
  test('flags code or a comment that starts on the line directly after the imports', () => {
    const messages = lintWith('warpaint/newline-after-imports', importFixtures);
    assert.deepEqual(flaggedNames(messages), ['comment-after-imports.ts', 'const-after-imports.ts']);
    assert.match(messages.get('const-after-imports.ts')[0], /blank line after the imports/u);
    assert.match(messages.get('comment-after-imports.ts')[0], /blank line after the imports/u);
  });

  test('leaves files with a blank line, no imports, or only imports alone', () => {
    const messages = lintWith('warpaint/newline-after-imports', importFixtures);
    assert.equal(messages.has('blank-after-imports.ts'), false);
    assert.equal(messages.has('no-imports.ts'), false);
    assert.equal(messages.has('imports-only.ts'), false);
  });
});

describe('warpaint/import-groups', () => {
  test('flags a missing blank line and a package import after a local one in files with 10 or more imports', () => {
    const messages = lintWith('warpaint/import-groups', importGroupFixtures);
    assert.deepEqual(flaggedNames(messages), [
      'comment-no-blank.ts',
      'missing-blank.ts',
      'package-after-local.ts',
    ]);
    assert.match(messages.get('missing-blank.ts')[0], /one blank line/u);
    assert.match(messages.get('comment-no-blank.ts')[0], /one blank line/u);
    assert.match(messages.get('package-after-local.ts')[0], /Put package imports before local imports/u);
  });

  test('passes files under 10 imports, one blank line between groups, and a comment with a blank line', () => {
    const messages = lintWith('warpaint/import-groups', importGroupFixtures);
    for (const name of ['ten-imports.ts', 'nine-imports.ts', 'comment-between.ts']) {
      assert.equal(messages.has(name), false, `${name} should not be flagged`);
    }
  });
});

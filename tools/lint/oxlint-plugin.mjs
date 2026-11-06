/*
 * Local oxlint JS plugin, loaded through `jsPlugins` in .oxlintrc.json.
 *
 * no-low-value-comments is adapted from the rule of the same name in T3 Code's
 * oxlint-plugin-t3code (rules/no-low-value-comments.ts), with a six-line cap and
 * without T3-specific checks. no-dashes is derived from T3's no-em-dash-copy rule,
 * widened to en dashes and to comments.
 *
 * MIT License
 *
 * Copyright (c) 2026 T3 Tools Inc.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

const TS_FILE_PATTERN = /\.[cm]?tsx?$/u;
// Tool directives and reference or environment markers must stay as written.
const DIRECTIVE_PATTERN =
  /^\s*\*?\s*(?:(?:oxlint|eslint)-|@ts-|prettier-ignore|biome-ignore|c8 |istanbul |#(?:end)?region|\/\s*<reference\s|@vitest-environment)/u;
const DIVIDER_LINE_PATTERN = /^(?:[-=*#~_/+]{3,}.*|.*[-=*#~_]{3,})$/u;
const TEST_STEP_PATTERN = /^(?:arrange|act|assert|given|when|then)\s*[:.]?$/iu;
const TASK_MARKER_PATTERN = /\b(?:TODO|FIXME|XXX|HACK)\b/u;
const TASK_LINK_PATTERN = /#\d+|https?:\/\//u;
const JSDOC_TYPE_PATTERN = /^@(?:param|returns?|type|typedef)\s+\{/u;
const EMPTY_JSDOC_TAG_PATTERN = /^@(?:param(?:\s+\[?[\w$.]+\]?)?|returns?)$/u;
const COMMENTED_CODE_PATTERN =
  /^(?:(?:(?:const|let|var)\s+[\w${}[\], ]+=.*|import\s.+\sfrom\s+["'].+["']|(?:await\s+|return\s+)?[\w$.]+\(.*\)|[\w$.[\]]+\s*=\s*.+);|(?:if|for|while|switch)\s*\(.*\)\s*\{|\}(?:\s*else\s*\{)?)$/u;
const DECLARATION_PATTERN =
  /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:static\s+)?(?:readonly\s+)?(?:(?:const|let|var|function\*?|class|interface|type|enum)\s+)?([A-Za-z_$][\w$]*)\s*[?!]?\s*[:=(<{]/u;
const FILLER_WORDS = new Set(
  'a an the of for to in on at by with from and or is are be this that it its as get set return create new current value given whether'.split(
    ' ',
  ),
);
// Longer comments are background that should be cut; license blocks are exempt below.
const MAX_COMMENT_LINES = 6;
const LICENSE_PATTERN = /^!|@license|\bcopyright\b|\bSPDX-License-Identifier\b/iu;
// En and em dash code points, built here so this file holds no literal dashes for no-dashes to flag.
const DASH_PATTERN = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`, 'u');
const DASH_MESSAGE = 'No em or en dashes. Use a comma, colon, semicolon, parentheses or a period.';

// A colour written into a class bypasses the theme, and so does a font size outside its pixel-named scale.
const RAW_VALUE_PATTERN = /(?:^|[\s:])-?[a-z][a-z-]*-\[(?:#[0-9a-f]{3,8}|(?:rgb|hsl)a?\()|(?:^|[\s:])text-\[[\d.]+px\]/iu;
const RAW_VALUE_MESSAGE = 'Use a theme colour or text size, not a raw value in a class. Add it to the theme in src/index.css if it is new.';

const stem = (word) => (word.length > 3 ? word.replace(/([^s])s$/u, '$1') : word);
const words = (text) =>
  (text.toLowerCase().match(/[a-z0-9]+/gu) ?? [])
    .filter((word) => !FILLER_WORDS.has(word))
    .map(stem)
    .filter((word) => !FILLER_WORDS.has(word));
const identifierWords = (name) =>
  words(name.replace(/([a-z0-9])([A-Z])/gu, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/gu, '$1 $2'));

const commentLines = (comment) =>
  comment.value
    .split('\n')
    .map((line) => line.replace(/^\s*\*?\s?/u, '').trim())
    .filter((line) => line !== '');

const noLowValueComments = {
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Reject comments that only repeat the code, divide sections, or narrate tests.',
    },
    schema: [],
  },
  create(context) {
    const { sourceCode } = context;
    const isTypeScript = TS_FILE_PATTERN.test(context.filename);

    // Consecutive `//` lines at one indent read as one comment.
    const groups = [];
    for (const comment of sourceCode.getAllComments()) {
      const group = groups.at(-1);
      const previous = group?.comments.at(-1);
      const continues =
        comment.type === 'Line' &&
        previous?.type === 'Line' &&
        previous.loc.end.line === comment.loc.start.line - 1 &&
        previous.loc.start.column === comment.loc.start.column;
      if (continues) {
        group.comments.push(comment);
        group.lines.push(...commentLines(comment));
      } else {
        groups.push({ comments: [comment], lines: commentLines(comment) });
      }
    }

    // A comment whose words are all in the next declaration's name says nothing new.
    const restatesNextName = (nextLine, lines) => {
      if (lines.some((line) => line.startsWith('@'))) return false;
      const name = DECLARATION_PATTERN.exec(sourceCode.lines[nextLine] ?? '')?.[1];
      if (name === undefined) return false;
      const content = words(lines.join(' '));
      if (content.length === 0 || content.length > 6) return false;
      const nameWords = new Set(identifierWords(name));
      return content.every((word) => nameWords.has(word));
    };

    const problem = (comments, lines) => {
      const text = comments.map((comment) => comment.value).join('\n');
      if (lines.length === 0 || comments.some((comment) => DIRECTIVE_PATTERN.test(comment.value))) {
        return undefined;
      }
      const isLine = comments[0].type === 'Line';
      if (lines.some((line) => DIVIDER_LINE_PATTERN.test(line))) {
        return 'Drop the section divider; split the file or let the code\'s structure show the grouping.';
      }
      if (isLine && lines.length === 1 && TEST_STEP_PATTERN.test(lines[0])) {
        return 'Drop the test step label.';
      }
      if (TASK_MARKER_PATTERN.test(text) && !TASK_LINK_PATTERN.test(text)) {
        return 'Link the issue that tracks this, or drop the marker.';
      }
      if (isTypeScript && lines.some((line) => JSDOC_TYPE_PATTERN.test(line))) {
        return 'Drop the JSDoc type; TypeScript already has it.';
      }
      if (lines.some((line) => EMPTY_JSDOC_TAG_PATTERN.test(line))) {
        return 'Drop the JSDoc tag that has no description.';
      }
      if (isLine && lines.every((line) => COMMENTED_CODE_PATTERN.test(line))) {
        return 'Delete commented-out code; git keeps the history.';
      }
      if (restatesNextName(comments.at(-1).loc.end.line, lines)) {
        return 'Drop the comment; it only repeats the name below it. Say why, or say nothing.';
      }
      if (lines.length > MAX_COMMENT_LINES && !LICENSE_PATTERN.test(text)) {
        return `Cut this to ${MAX_COMMENT_LINES} lines or fewer: keep the constraint, drop the background.`;
      }
      return undefined;
    };

    return {
      Program() {
        for (const { comments, lines } of groups) {
          const message = problem(comments, lines);
          if (message === undefined) continue;
          context.report({
            loc: { start: comments[0].loc.start, end: comments.at(-1).loc.end },
            message,
          });
        }
      },
    };
  },
};

// Strings and JSX text are copy that users or agents read; comments are checked too.
const noRawClassValues = {
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Disallow raw colours and font sizes in Tailwind class strings.',
    },
    schema: [],
  },
  create(context) {
    const check = (node, text) => {
      if (typeof text === 'string' && RAW_VALUE_PATTERN.test(text)) {
        context.report({ node, message: RAW_VALUE_MESSAGE });
      }
    };
    return {
      Literal(node) {
        check(node, node.value);
      },
      TemplateElement(node) {
        check(node, node.value.cooked);
      },
    };
  },
};

const noDashes = {
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Disallow en and em dashes in strings, JSX text and comments.',
    },
    schema: [],
  },
  create(context) {
    const check = (node, text) => {
      if (typeof text === 'string' && DASH_PATTERN.test(text)) {
        context.report({ node, message: DASH_MESSAGE });
      }
    };
    return {
      Literal(node) {
        check(node, node.value);
      },
      TemplateElement(node) {
        check(node, node.value.cooked);
      },
      JSXText(node) {
        check(node, node.value);
      },
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          if (DASH_PATTERN.test(comment.value)) {
            context.report({ loc: comment.loc, message: DASH_MESSAGE });
          }
        }
      },
    };
  },
};

// A blank line separates the import block from the code below, so the dependencies read as a block.
const newlineAfterImports = {
  meta: {
    type: 'layout',
    docs: {
      description: 'Require a blank line between the last top-level import and the code after it.',
    },
    schema: [],
  },
  create(context) {
    const { sourceCode } = context;
    return {
      Program(program) {
        const imports = program.body.filter((statement) => statement.type === 'ImportDeclaration');
        const lastImport = imports.at(-1);
        if (lastImport === undefined) return;
        const nextStatement = program.body[program.body.indexOf(lastImport) + 1];
        // A comment on the import's own line is trailing, not the start of the code below it.
        const nextComment = sourceCode
          .getAllComments()
          .find(
            (comment) =>
              comment.range[0] >= lastImport.range[1] &&
              comment.loc.start.line > lastImport.loc.end.line &&
              (nextStatement === undefined || comment.range[0] < nextStatement.range[0]),
          );
        const next = nextComment ?? nextStatement;
        if (next === undefined) return;
        if (next.loc.start.line === lastImport.loc.end.line + 1) {
          context.report({ loc: next.loc, message: 'Add a blank line after the imports.' });
        }
      },
    };
  },
};

// Short import blocks read fine unsorted; long ones need package and local modules kept apart.
const IMPORT_GROUP_MIN_COUNT = 10;
const LOCAL_SPECIFIER_PATTERN = /^\.\.?\//u;
const PACKAGE_SPECIFIER_PATTERN = /^[^./]/u;

const importGroups = {
  meta: {
    type: 'layout',
    docs: {
      description: 'In long import blocks, list package imports before local imports, one blank line apart.',
    },
    schema: [],
  },
  create(context) {
    const { sourceCode } = context;
    // Comments between the groups count as the separator only with a blank line somewhere too.
    const hasBlankLineBetween = (previous, next) => {
      const gap = sourceCode.lines.slice(previous.loc.end.line, next.loc.start.line - 1);
      const hasComment = sourceCode
        .getAllComments()
        .some((comment) => comment.range[0] >= previous.range[1] && comment.range[1] <= next.range[0]);
      if (hasComment) return gap.some((line) => line.trim() === '');
      return gap.length === 1 && gap[0].trim() === '';
    };

    return {
      Program(program) {
        const imports = program.body.filter((statement) => statement.type === 'ImportDeclaration');
        if (imports.length < IMPORT_GROUP_MIN_COUNT) return;
        const isLocal = (node) => LOCAL_SPECIFIER_PATTERN.test(node.source.value);
        const isPackage = (node) => PACKAGE_SPECIFIER_PATTERN.test(node.source.value);
        const firstLocal = imports.find(isLocal);
        if (firstLocal === undefined) return;

        for (const node of imports) {
          if (isPackage(node) && node.range[0] > firstLocal.range[0]) {
            context.report({ node, message: 'Put package imports before local imports.' });
          }
        }

        const lastPackage = imports
          .filter((node) => isPackage(node) && node.range[0] < firstLocal.range[0])
          .at(-1);
        if (lastPackage === undefined || hasBlankLineBetween(lastPackage, firstLocal)) return;
        context.report({
          node: firstLocal,
          message: 'Separate package imports from local imports with one blank line.',
        });
      },
    };
  },
};

export default {
  meta: { name: 'warpaint' },
  rules: {
    'no-low-value-comments': noLowValueComments,
    'no-dashes': noDashes,
    'no-raw-class-values': noRawClassValues,
    'newline-after-imports': newlineAfterImports,
    'import-groups': importGroups,
  },
};

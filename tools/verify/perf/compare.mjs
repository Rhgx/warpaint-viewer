// Prints two measure.mjs results side by side as Markdown, and checks that the final renders match pixel for pixel.
//
//   node tools/verify/perf/compare.mjs baseline after [--full]
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const sharp = createRequire(resolve('package.json'))('sharp');
const [beforeLabel, afterLabel] = process.argv.slice(2);
const FULL = process.argv.includes('--full');
if (!beforeLabel || !afterLabel) {
  console.error('usage: compare.mjs <before-label> <after-label> [--full]');
  process.exit(2);
}
const load = (label) => JSON.parse(readFileSync(join('.tmp/perf', `${label}.json`), 'utf8'));
const before = load(beforeLabel);
const after = load(afterLabel);

const uploads = (step) => (step.upload ? Object.values(step.upload).reduce((sum, entry) => sum + (entry.ms ?? 0), 0) : undefined);
const bytesMiB = (value) => (value === undefined ? undefined : value / (1024 * 1024));

const SUMMARY = [
  ['Weapon on screen', 'ms', (s) => s.weaponMs],
  ['Final paint', 'ms', (s) => s.finalMs],
  ['Blocking (TBT)', 'ms', (s) => s.blockingMs],
  ['Worst frame', 'ms', (s) => s.worstFrameMs],
  ['Long tasks', '', (s) => s.longTasks],
  ['Transferred', 'MiB', (s) => bytesMiB(s.bytes)],
  ['Requests', '', (s) => s.requests],
];
const PHASES = [
  ['Document', 'ms', (s) => s.documentMs],
  ['First contentful paint', 'ms', (s) => s.fcpMs],
  ['App shell and JS done', 'ms', (s) => s.shellEndMs],
  ['Boot data done', 'ms', (s) => s.network?.boot?.endMs],
  ['Recipe done', 'ms', (s) => s.network?.recipes?.endMs],
  ['Environment ready', 'ms', (s) => s.envReadyMs],
  ['Model fetched', 'ms', (s) => s.network?.models?.endMs],
  ['Model parse', 'ms', (s) => s.modelParseMs],
  ['Weapon and material ready', 'ms', (s) => s.assetsReadyMs],
  ['Textures first request', 'ms', (s) => s.network?.textures?.startMs],
  ['Textures fetched', 'ms', (s) => s.network?.textures?.endMs],
  ['Texture bytes', 'MiB', (s) => bytesMiB(s.network?.textures?.bytes)],
  ['Decode (wall)', 'ms', (s) => s.decode?.wallMs],
  ['Decodes', '', (s) => s.decode?.n],
  ['Compose start', 'ms', (s) => s.composeStartMs],
  ['Sources ready', 'ms', (s) => s.sourcesReadyMs],
  ['Composition done', 'ms', (s) => s.composeEndMs],
  ['GPU upload (main thread)', 'ms', uploads],
  ['Worst upload call', 'ms', (s) => (s.upload ? Math.max(...Object.values(s.upload).map((entry) => entry.maxMs ?? 0)) : undefined)],
  ['Geometry upload', 'ms', (s) => s.geometry?.ms],
  ['Shader compile (blocking)', 'ms', (s) => s.compile?.ms],
  ['Shader compile (wait)', 'ms', (s) => s.compileWaitMs],
  ['Previews shown', '', (s) => s.previewCount],
  ['Blocking after paint', 'ms', (s) => s.blockingAfterMs],
];

const format = (value) => {
  if (value === undefined || value === null || Number.isNaN(value)) return '-';
  return value >= 100 ? Math.round(value).toString() : (Math.round(value * 10) / 10).toString();
};
const change = (a, b) => {
  if (a === undefined || b === undefined || a === null || b === null || !a) return '';
  const percent = ((b - a) / a) * 100;
  return `${percent > 0 ? '+' : ''}${percent.toFixed(0)}%`;
};

const table = (rows, a, b) => {
  const lines = [`| Metric | ${beforeLabel} | ${afterLabel} | Change |`, '|---|---:|---:|---:|'];
  for (const [name, unit, read] of rows) {
    const left = read(a);
    const right = read(b);
    if (left === undefined && right === undefined) continue;
    lines.push(`| ${name}${unit ? ` (${unit})` : ''} | ${format(left)} | ${format(right)} | ${change(left, right)} |`);
  }
  return lines.join('\n');
};

for (const profile of Object.keys(after.medians)) {
  for (const scenario of Object.keys(after.medians[profile])) {
    for (const stepName of Object.keys(after.medians[profile][scenario])) {
      const b = after.medians[profile][scenario][stepName];
      const a = before.medians?.[profile]?.[scenario]?.[stepName];
      if (!a) continue;
      console.log(`\n### ${profile} / ${scenario} / ${stepName}\n`);
      console.log(table(FULL ? [...SUMMARY, ...PHASES] : SUMMARY, a, b));
    }
  }
}

const sum = (bundles, name) => bundles.filter((entry) => entry.file.startsWith(name)).reduce((total, entry) => total + entry.gzip, 0);
const allGzip = (bundles) => bundles.reduce((total, entry) => total + entry.gzip, 0);
console.log('\n### JS and CSS (gzip KiB)\n');
console.log(`| Bundle | ${beforeLabel} | ${afterLabel} |\n|---|---:|---:|`);
for (const name of ['index', 'three', 'Viewer', 'compositor', 'ShowcaseMode', 'OperationGraphEditor']) {
  console.log(`| ${name} | ${format(sum(before.bundles, name) / 1024)} | ${format(sum(after.bundles, name) / 1024)} |`);
}
console.log(`| Everything | ${format(allGzip(before.bundles) / 1024)} | ${format(allGzip(after.bundles) / 1024)} |`);

// The render check: exact composite digests, then the whole viewport.
const hashProblems = [];
let hashesCompared = 0;
for (const entry of after.raw) {
  for (const [stepName, step] of Object.entries(entry.steps)) {
    if (!step.compositeHash) continue;
    const reference = before.raw.find((other) => other.profile === entry.profile && other.scenario === entry.scenario && other.steps[stepName]?.compositeHash);
    if (!reference) continue;
    hashesCompared += 1;
    if (reference.steps[stepName].compositeHash !== step.compositeHash) {
      hashProblems.push(`${entry.profile} ${entry.scenario} ${stepName} run ${entry.run}: ${reference.steps[stepName].compositeHash} then ${step.compositeHash}`);
    }
  }
}
console.log(`\n### Render check\n\nComposite digests compared: ${hashesCompared}, different: ${hashProblems.length}`);
for (const problem of hashProblems) console.log(`- ${problem}`);

const beforeDir = join('.tmp/perf/renders', beforeLabel);
const afterDir = join('.tmp/perf/renders', afterLabel);
if (existsSync(beforeDir) && existsSync(afterDir)) {
  let compared = 0;
  const different = [];
  for (const file of readdirSync(afterDir)) {
    if (!file.endsWith('.png') || !existsSync(join(beforeDir, file))) continue;
    const [left, right] = await Promise.all([join(beforeDir, file), join(afterDir, file)].map((path) => sharp(path).raw().toBuffer({ resolveWithObject: true })));
    compared += 1;
    if (left.info.width !== right.info.width || left.info.height !== right.info.height) {
      different.push(`${file}: size changed`);
      continue;
    }
    let pixels = 0;
    let worst = 0;
    const { channels } = left.info;
    for (let i = 0; i < left.data.length; i += channels) {
      let distance = 0;
      for (let c = 0; c < channels; c += 1) distance = Math.max(distance, Math.abs(left.data[i + c] - right.data[i + c]));
      if (distance) pixels += 1;
      worst = Math.max(worst, distance);
    }
    if (pixels) different.push(`${file}: ${pixels} pixels differ, by at most ${worst}/255`);
  }
  console.log(`\nViewport renders compared: ${compared}, different: ${different.length}`);
  for (const line of different) console.log(`- ${line}`);
}

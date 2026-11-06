// Load times of a production build, each case in a fresh browser, as medians. Starts and stops its own server and browser.
//   --label baseline [--runs 5] [--profiles fast,throttled] [--scenarios home,c_minigun,showcase,repeat] [--no-build]
//   --label after --build-only, then --ab before,after: alternates two builds run by run, so that whatever else the
//   machine is doing lands on both. Prefer it for any decision on a machine in use.
// Writes .tmp/perf/<label>.json and renders to .tmp/perf/renders/<label>/ for compare.mjs. Note that --ab rewrites both
// labels' results.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

import { startSite } from './server.mjs';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const APP_PORT = 5341;
const TEXTURE_PORT = 5342;
const VIEWPORT = { width: 1600, height: 1000 };
const SEED = '4242424242';
const STEP_TIMEOUT_MS = 120_000;
const RETRIES = 2;
const QUIET_MS = 1200;
// Speculative warmups may keep working after the paint is up; they count, but only for this long.
const MAX_AFTER_FINAL_MS = 10_000;

const PROFILES = {
  fast: { cpu: 1, network: null },
  // A modest PC on ordinary broadband: 25 Mbit/s down, 5 up, 40 ms round trip.
  throttled: { cpu: 4, network: { offline: false, latency: 40, downloadThroughput: (25e6) / 8, uploadThroughput: (5e6) / 8 } },
};

// Two paints every test weapon has: the most layered one, and a typical one.
const PAINT_A = { id: 300, name: 'Yeti Coated' };
const PAINT_B = { id: 279, name: 'Frozen Aurora' };
const WEAPONS = {
  c_rocketlauncher: { next: 'c_minigun' },
  c_minigun: { next: 'c_rocketlauncher' },
  c_holymackerel: { next: 'c_knife' },
};
const BOARD_WEAPONS = ['c_rocketlauncher', 'c_minigun', 'c_knife', 'c_holymackerel', 'c_scattergun', 'c_wrench'];

const option = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : process.argv[index + 1];
};
const LABEL = option('label', 'run');
const RUNS = Number(option('runs', '5'));
const PROFILE_NAMES = option('profiles', 'fast,throttled').split(',');
const SCENARIOS = option('scenarios', `home,${Object.keys(WEAPONS).join(',')},showcase,repeat`).split(',');
const VARIANTS = option('ab', LABEL).split(',');
const BUILD = VARIANTS.length === 1 && !process.argv.includes('--no-build');
const BUILD_ONLY = process.argv.includes('--build-only');
const CAPTURE_ALL = process.argv.includes('--capture-all');
// Writes a .cpuprofile per step next to the renders. Build with --no-minify for readable function names.
const CPU_PROFILE = process.argv.includes('--cpu-profile');
const MINIFY = !process.argv.includes('--no-minify');

const OUT = resolve('.tmp/perf');
const siteFor = (variant) => join(OUT, 'site', variant);
const rendersFor = (variant) => join(OUT, 'renders', variant);
for (const variant of VARIANTS) mkdirSync(rendersFor(variant), { recursive: true });
let current = VARIANTS[0];

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const manifest = JSON.parse(readFileSync('public/data/manifest.json', 'utf8'));
const weaponName = (key) => manifest.weapons.find((weapon) => weapon.key === key).name;

async function buildSite() {
  process.env.VITE_BASE_PATH = '/warpaint-viewer/';
  process.env.VITE_TEXTURE_URL = `https://localhost:${TEXTURE_PORT}`;
  process.env.VITE_PERF_MARKS = '1';
  const { build } = await import('vite');
  await build({ logLevel: 'warn', build: { outDir: siteFor(LABEL), emptyOutDir: true, copyPublicDir: false, minify: MINIFY } });
}

function bundleSizes(variant) {
  const dir = join(siteFor(variant), 'assets');
  const files = readdirSync(dir).map((file) => {
    const bytes = readFileSync(join(dir, file));
    return { file: file.replace(/-[\w-]{8}(?=\.\w+$)/, ''), bytes: bytes.length, gzip: gzipSync(bytes).length };
  });
  return files.sort((a, b) => b.bytes - a.bytes);
}

async function startBrowser(spkiHash) {
  const profile = mkdtempSync(join(tmpdir(), 'wpv-perf-'));
  const browser = spawn(EDGE, [
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--headless=new', '--disable-extensions',
    '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update', '--disable-sync',
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
    '--disable-features=CalculateNativeWinOcclusion', `--ignore-certificate-errors-spki-list=${spkiHash}`,
    `--window-size=${VIEWPORT.width},${VIEWPORT.height}`, 'about:blank',
  ], { stdio: 'ignore' });
  let exited = false;
  browser.once('exit', () => { exited = true; });

  const portFile = join(profile, 'DevToolsActivePort');
  let endpoint = null;
  for (let i = 0; i < 150 && !endpoint; i += 1) {
    if (existsSync(portFile)) {
      const [port, path] = readFileSync(portFile, 'utf8').split(/\r?\n/);
      if (port && path) endpoint = `ws://127.0.0.1:${port}${path}`;
    }
    if (!endpoint) await sleep(100);
  }
  if (!endpoint) {
    spawnSync('taskkill', ['/PID', String(browser.pid), '/T', '/F'], { stdio: 'ignore' });
    throw new Error('the browser did not open its debugging port');
  }

  const ws = new WebSocket(endpoint);
  await new Promise((done, fail) => {
    ws.addEventListener('open', done, { once: true });
    ws.addEventListener('error', fail, { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  const listeners = [];
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { done, fail, method } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) fail(new Error(`${method}: ${message.error.message}`));
      else done(message.result);
    } else if (message.method) {
      for (const listener of listeners) listener(message);
    }
  });
  const send = (method, params = {}, sessionId) => new Promise((done, fail) => {
    const id = ++nextId;
    pending.set(id, { done, fail, method });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

  const stop = async () => {
    try {
      await Promise.race([send('Browser.close'), sleep(2000)]);
    } catch {
      // Already closing.
    }
    for (let i = 0; i < 30 && !exited; i += 1) await sleep(100);
    if (!exited) spawnSync('taskkill', ['/PID', String(browser.pid), '/T', '/F'], { stdio: 'ignore' });
    try {
      ws.close();
    } catch {
      // Already closed.
    }
    for (let i = 0; i < 10; i += 1) {
      try {
        rmSync(profile, { recursive: true, force: true });
        break;
      } catch {
        await sleep(300);
      }
    }
  };
  return { send, on: (listener) => listeners.push(listener), stop };
}

async function openPage(browser, profileName, initScripts) {
  const { cpu, network } = PROFILES[profileName];
  const errors = [];
  const { targetInfos } = await browser.send('Target.getTargets');
  const page = targetInfos.find((target) => target.type === 'page');
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
  const send = (method, params) => browser.send(method, params, sessionId);

  const throttle = async (session) => {
    await browser.send('Network.enable', {}, session);
    if (network) await browser.send('Network.emulateNetworkConditions', network, session);
    if (cpu > 1) await browser.send('Emulation.setCPUThrottlingRate', { rate: cpu }, session).catch(() => undefined);
  };
  // Workers fetch and run on their own targets, which throttling on the page does not reach.
  browser.on((message) => {
    if (message.method === 'Target.attachedToTarget' && message.params.targetInfo.type === 'worker') {
      throttle(message.params.sessionId).catch(() => undefined);
    }
    if (message.sessionId === sessionId && message.method === 'Runtime.exceptionThrown') {
      errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
    }
  });
  await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  await send('Page.enable');
  await send('Runtime.enable');
  await throttle(sessionId);
  await send('Emulation.setDeviceMetricsOverride', { width: VIEWPORT.width, height: VIEWPORT.height, deviceScaleFactor: 1, mobile: false });
  for (const source of initScripts) await send('Page.addScriptToEvaluateOnNewDocument', { source });

  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(`${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text} in ${expression.slice(0, 200)}`);
    return result.result.value;
  };
  return { send, evaluate, errors };
}

/** Waits for the paint to land on the canvas, then for the page to go quiet. */
async function settle(page, { wantsPaint, doneExpression }) {
  const started = Date.now();
  let resources = -1;
  let quietSince = Date.now();
  let paintedAt = null;
  for (;;) {
    if (Date.now() - started > STEP_TIMEOUT_MS) {
      throw new Error(`step timed out: ${JSON.stringify(await page.evaluate('__perf?.status()'))}`);
    }
    await sleep(100);
    let status;
    try {
      status = await page.evaluate('window.__perf ? __perf.status() : null');
    } catch {
      // The page is navigating.
      continue;
    }
    if (!status) continue;
    if (status.resources !== resources || status.inflight > 0) {
      resources = status.resources;
      quietSince = Date.now();
    }
    let painted = status.complete && !status.booting && !status.composing;
    if (wantsPaint) painted &&= status.onScreen.includes('paint-final') || status.onScreen.includes('paint-cached');
    if (doneExpression) painted &&= await page.evaluate(doneExpression);
    if (!painted) {
      paintedAt = null;
      continue;
    }
    paintedAt ??= Date.now();
    if (Date.now() - quietSince >= QUIET_MS || Date.now() - paintedAt >= MAX_AFTER_FINAL_MS) return;
  }
}

let captureSuffix = '';

async function screenshot(page, base) {
  const name = `${base}${captureSuffix}`;
  const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(rendersFor(current), `${name}.png`), Buffer.from(data, 'base64'));
  writeFileSync(join(rendersFor(current), `${name}.resources.json`), JSON.stringify(await page.evaluate('__perf.resources()'), null, 1));
  return createHash('sha256').update(data).digest('hex').slice(0, 16);
}

async function clickWeapon(page, key) {
  await page.evaluate(`document.querySelector('[data-slot="select-trigger"][aria-label="Weapon" i]').click()`);
  await page.evaluate(`(async () => { const start = performance.now(); while (!document.querySelector('[data-slot="select-item"]') && performance.now() - start < 5000) await new Promise((done) => setTimeout(done, 20)); })()`);
  await page.evaluate(`__perf.begin(); [...document.querySelectorAll('[data-slot="select-item"]')].find((item) => item.textContent.trim() === ${JSON.stringify(weaponName(key))}).click()`);
}

const typeSeed = (page, seed) => page.evaluate(`(() => {
  const input = document.querySelector('input[aria-label="Paint seed" i]');
  input.focus();
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(seed)});
  input.dispatchEvent(new Event('input', { bubbles: true }));
  __perf.begin();
  input.blur();
})()`);

async function pressEndOnWear(page) {
  await page.evaluate(`document.querySelector('[data-slot="wear-slider"] input').focus(); __perf.begin();`);
  await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'End', code: 'End', windowsVirtualKeyCode: 35, nativeVirtualKeyCode: 35 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'End', code: 'End', windowsVirtualKeyCode: 35, nativeVirtualKeyCode: 35 });
}

async function weaponScenario(browser, profile, weapon, url, capture) {
  const page = await openPage(browser, profile, [HOOK]);
  const steps = {};
  const profileStart = async () => {
    if (!CPU_PROFILE) return;
    await page.send('Profiler.enable');
    await page.send('Profiler.setSamplingInterval', { interval: 500 });
    await page.send('Profiler.start');
  };
  await profileStart();
  const finish = async (name, wantsPaint = true) => {
    await settle(page, { wantsPaint });
    const metrics = await page.evaluate(`__perf.read()`);
    if (CPU_PROFILE) {
      const { profile: cpu } = await page.send('Profiler.stop');
      writeFileSync(join(rendersFor(current), `${weapon}-${name}-${profile}.cpuprofile`), JSON.stringify(cpu));
      await profileStart();
    }
    metrics.compositeHash = wantsPaint ? await page.evaluate(`__perf.compositeHash()`) : null;
    if (capture) metrics.screenHash = await screenshot(page, `${weapon}-${name}`);
    steps[name] = metrics;
  };

  await page.send('Page.navigate', { url: `${url}?kit=${PAINT_A.id}&weapon=${weapon}&seed=${SEED}&wear=0` });
  await finish('first-visit');
  const gpu = await page.evaluate(`__perf.gpu()`);

  await pressEndOnWear(page);
  await finish('wear');

  await typeSeed(page, '777777');
  await finish('seed');

  await page.evaluate(`__perf.begin(); document.querySelector('[data-kit-id="${PAINT_B.id}"]').click()`);
  await finish('switch-paint');

  await clickWeapon(page, WEAPONS[weapon].next);
  await finish('switch-weapon');

  await clickWeapon(page, weapon);
  await finish('back-to-weapon');
  return { steps, gpu, errors: page.errors };
}

async function homeScenario(browser, profile, url, capture) {
  const page = await openPage(browser, profile, [HOOK]);
  await page.send('Page.navigate', { url });
  await settle(page, { wantsPaint: false, doneExpression: `!!document.querySelector('[data-slot="catalog"]')` });
  const metrics = await page.evaluate(`__perf.read()`);
  if (capture) metrics.screenHash = await screenshot(page, 'home');
  return { steps: { home: metrics }, errors: page.errors };
}

async function repeatScenario(browser, profile, url, capture) {
  const page = await openPage(browser, profile, [HOOK]);
  const target = `${url}?kit=${PAINT_A.id}&weapon=c_rocketlauncher&seed=${SEED}&wear=0`;
  await page.send('Page.navigate', { url: target });
  await settle(page, { wantsPaint: true });
  await page.send('Page.navigate', { url: target });
  await sleep(50);
  await settle(page, { wantsPaint: true });
  const metrics = await page.evaluate(`__perf.read()`);
  metrics.compositeHash = await page.evaluate(`__perf.compositeHash()`);
  if (capture) metrics.screenHash = await screenshot(page, 'repeat-visit');
  return { steps: { 'repeat-visit': metrics }, errors: page.errors };
}

function boardSeed() {
  const items = BOARD_WEAPONS.map((key, index) => ({
    id: `perf-${index}`,
    weaponKey: key,
    weaponName: weaponName(key),
    paint: { kitId: PAINT_A.id, kitName: PAINT_A.name, team: 'red', wearIndex: 0, seed: SEED },
    x: (index % 3) * 1.4 - 1.4,
    y: Math.floor(index / 3) * 1.0 - 0.5,
    roll: 0,
    tilt: 0,
    turn: 0,
    flipped: false,
    scale: 1,
    hidden: false,
    pose: {},
    part: null,
    hiddenParts: [],
  }));
  return `(() => {
    if (window.top !== window) return;
    localStorage.setItem('warpaint-viewer:settings', JSON.stringify({ state: { showcaseBoard: true }, version: 1 }));
    localStorage.setItem('warpaint-viewer:showcase-board', ${JSON.stringify(JSON.stringify({ version: 1, items }))});
  })();`;
}

async function showcaseScenario(browser, profile, url, capture) {
  const page = await openPage(browser, profile, [HOOK, boardSeed()]);
  await page.send('Page.navigate', { url });
  await settle(page, { wantsPaint: false, doneExpression: `!!document.querySelector('[aria-label="Open showcase board" i]')` });
  await page.evaluate(`__perf.begin(); document.querySelector('[aria-label="Open showcase board" i]').click();
    window.__boardPainted = (async () => {
      while (!window.__showcase || !document.querySelector('[data-slot="slots"]')) await new Promise((done) => setTimeout(done, 20));
      await window.__showcase.whenPainted();
      performance.mark('wpv:board-painted');
      window.__boardDone = true;
    })()`);
  await settle(page, { wantsPaint: false, doneExpression: `window.__boardDone === true` });
  const metrics = await page.evaluate(`__perf.read('board-painted')`);
  if (capture) metrics.screenHash = await screenshot(page, 'showcase-open');
  return { steps: { 'showcase-open': metrics }, errors: page.errors };
}

function median(values) {
  const sorted = values.filter((value) => typeof value === 'number' && !Number.isNaN(value)).sort((a, b) => a - b);
  if (!sorted.length) return undefined;
  const middle = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return Math.round(value * 10) / 10;
}

/** The median of every numeric field across runs, keeping the object's shape; other fields report whether runs agreed. */
function mergeRuns(runs) {
  const present = runs.filter((run) => run !== undefined && run !== null);
  if (!present.length) return undefined;
  if (typeof present[0] === 'number') return median(present);
  if (typeof present[0] !== 'object') {
    const distinct = [...new Set(present)];
    return distinct.length === 1 ? distinct[0] : distinct;
  }
  const merged = {};
  for (const key of new Set(present.flatMap((run) => Object.keys(run)))) {
    merged[key] = mergeRuns(present.map((run) => run[key]));
  }
  return merged;
}

const HOOK = readFileSync(new URL('./pageHook.js', import.meta.url), 'utf8');

if (BUILD) await buildSite();
if (BUILD_ONLY) process.exit(0);
const site = await startSite({ siteDir: () => siteFor(current), publicDir: resolve('public'), appPort: APP_PORT, texturePort: TEXTURE_PORT, certDir: join(OUT, 'cert') });

const raw = [];
let gpu = null;
const failures = [];
const runCase = async (profile, scenario, run, capture) => {
  const browser = await startBrowser(site.spkiHash);
  try {
    if (scenario === 'home') return await homeScenario(browser, profile, site.url, capture);
    if (scenario === 'showcase') return await showcaseScenario(browser, profile, site.url, capture);
    if (scenario === 'repeat') return await repeatScenario(browser, profile, site.url, capture);
    return await weaponScenario(browser, profile, scenario, site.url, capture);
  } finally {
    await browser.stop();
    await sleep(run === undefined ? 0 : 300);
  }
};

let exitCode = 0;
try {
  for (const profile of PROFILE_NAMES) {
    for (const scenario of SCENARIOS) {
      // The server gzips on first request and the OS caches files, so one unreported run warms both.
      for (const variant of VARIANTS) {
        current = variant;
        try {
          await runCase(profile, scenario, undefined, false);
        } catch (cause) {
          console.error(`warm-up ${variant} ${profile} ${scenario} failed: ${cause.message}`);
        }
      }
      for (let run = 0; run < RUNS; run += 1) {
        // Swapping the order each run keeps either build from always following the other.
        for (const variant of run % 2 ? [...VARIANTS].reverse() : VARIANTS) {
          current = variant;
          const started = Date.now();
          for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
            try {
              captureSuffix = CAPTURE_ALL ? `-${profile}-${run}` : '';
              const result = await runCase(profile, scenario, run, CAPTURE_ALL || (profile === PROFILE_NAMES[0] && run === 0));
              gpu ??= result.gpu ?? null;
              raw.push({ variant, profile, scenario, run, ...result });
              const finals = Object.entries(result.steps).map(([name, step]) => `${name} ${step.finalMs}`).join(', ');
              console.log(`${variant} ${profile} ${scenario} #${run}: ${finals} (${((Date.now() - started) / 1000).toFixed(0)}s)${result.errors.length ? ` ERRORS ${result.errors.length}` : ''}`);
              if (result.errors.length) console.log(result.errors.slice(0, 3).join('\n'));
              break;
            } catch (cause) {
              // A stalled run is recorded even when its retry succeeds, so that flakes stay visible.
              failures.push(`${variant} ${profile} ${scenario} #${run} attempt ${attempt}: ${cause.message}`);
              console.error(`FAILED ${variant} ${profile} ${scenario} #${run} attempt ${attempt}: ${cause.message}`);
            }
          }
        }
      }
    }
  }
} finally {
  await site.stop();
}

const head = spawnSync('git', ['log', '-1', '--format=%h %s'], { encoding: 'utf8' }).stdout.trim();
for (const variant of VARIANTS) {
  const variantRaw = raw.filter((entry) => entry.variant === variant);
  const medians = {};
  for (const profile of PROFILE_NAMES) {
    medians[profile] = {};
    for (const scenario of SCENARIOS) {
      const runs = variantRaw.filter((entry) => entry.profile === profile && entry.scenario === scenario);
      if (!runs.length) continue;
      medians[profile][scenario] = {};
      for (const step of Object.keys(runs[0].steps)) medians[profile][scenario][step] = mergeRuns(runs.map((entry) => entry.steps[step]));
    }
  }
  const output = join(OUT, `${variant}.json`);
  writeFileSync(output, JSON.stringify({
    label: variant,
    head,
    date: new Date().toISOString(),
    runs: RUNS,
    profiles: PROFILES,
    environment: gpu,
    bundles: bundleSizes(variant),
    medians,
    failures,
    raw: variantRaw,
  }, null, 1));
  console.log(`wrote ${output}${failures.length ? ` with ${failures.length} failed attempts` : ''}`);
}
const expected = VARIANTS.length * PROFILE_NAMES.length * SCENARIOS.length * RUNS;
if (raw.length < expected) exitCode = 1;
process.exit(exitCode);

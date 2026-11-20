// Self-contained headless runner for /?selftest=1 (compositor pixel math, scheduling, and particle checks).
// Starts its own Vite server (dev by default, or `vite preview` with --preview) and Chromium/Edge,
// waits for SELFTEST PASS / FAIL, prints the table, and stops both processes cleanly.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { browserGpuFlags, findBrowser, spawnManaged, stopProcessTree } from './browser.mjs';

const USE_PREVIEW = process.argv.includes('--preview');
const APP_PORT = 5247 + Math.floor(Math.random() * 100);
const DEBUG_PORT = 9400 + Math.floor(Math.random() * 200);
const TIMEOUT_MS = Number(process.env.SELFTEST_TIMEOUT_MS ?? 90_000);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const browserPath = findBrowser();
const profile = mkdtempSync(join(tmpdir(), 'wpv-selftest-'));
const viteArgs = USE_PREVIEW
  ? ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', String(APP_PORT), '--strictPort']
  : ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(APP_PORT), '--strictPort'];

const vite = spawnManaged(process.execPath, viteArgs);
const browser = spawnManaged(browserPath, [
  `--remote-debugging-port=${DEBUG_PORT}`,
  `--user-data-dir=${profile}`,
  '--headless=new',
  '--disable-extensions',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling',
  ...browserGpuFlags(),
  'about:blank',
]);

let ws = null;
const cleanup = () => {
  try {
    ws?.close();
  } catch {
    // Already closed.
  }
  stopProcessTree(browser);
  stopProcessTree(vite);
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    // Best-effort temp cleanup.
  }
};

process.on('SIGINT', () => { cleanup(); process.exit(130); });
process.on('SIGTERM', () => { cleanup(); process.exit(143); });

try {
  // Wait for both Vite and the browser debugging endpoint.
  const serverUrl = `http://127.0.0.1:${APP_PORT}/`;
  let serverReady = false;
  for (let i = 0; i < 150 && !serverReady; i += 1) {
    try {
      const res = await fetch(serverUrl);
      if (res.ok) serverReady = true;
    } catch {
      await sleep(200);
    }
  }
  if (!serverReady) throw new Error(`Vite server did not start on ${serverUrl}`);

  let target = null;
  for (let i = 0; i < 100 && !target; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
      target = list.find((entry) => entry.type === 'page') ?? null;
    } catch {
      // Still starting.
    }
    if (!target) await sleep(200);
  }
  if (!target) throw new Error('Browser did not expose a CDP page target.');

  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });

  let nextId = 0;
  const pending = new Map();
  const pageErrors = [];
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject, method } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(`${method}: ${message.error.message}`));
      else resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') {
      pageErrors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
    }
  });

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject, method });
    ws.send(JSON.stringify({ id, method, params }));
  });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: `${serverUrl}?selftest=1` });

  const deadline = Date.now() + TIMEOUT_MS;
  let title = '';
  while (Date.now() < deadline) {
    const res = await send('Runtime.evaluate', { expression: 'document.title', returnByValue: true });
    title = res.result?.value ?? '';
    if (title === 'SELFTEST PASS' || title === 'SELFTEST FAIL') break;
    await sleep(250);
  }

  const dump = await send('Runtime.evaluate', {
    expression: `Array.from(document.querySelectorAll('.selftest-table tbody tr')).map((tr) => {
      const tds = tr.querySelectorAll('td');
      return {
        name: tds[0]?.textContent ?? '',
        result: tds[1]?.textContent ?? '',
        got: tds[2]?.textContent ?? '',
        expected: tds[3]?.textContent ?? '',
      };
    })`,
    returnByValue: true,
  });
  const rows = dump.result?.value ?? [];
  for (const row of rows) {
    console.log(`${row.result.padEnd(4)}  ${row.name}${row.result === 'PASS' ? '' : `  got=[${row.got}] expected=[${row.expected}]`}`);
  }
  if (pageErrors.length) {
    console.error('Page exceptions:', pageErrors.join('\n'));
  }

  if (title !== 'SELFTEST PASS' || rows.length === 0 || pageErrors.length > 0) {
    console.error(`Selftest failed (title=${JSON.stringify(title)}, checks=${rows.length}, errors=${pageErrors.length}).`);
    process.exitCode = 1;
  } else {
    console.log(`Selftest passed (${rows.length} checks).`);
  }
} finally {
  cleanup();
}

// End-to-end check of saved layouts, sharing and replaced textures on the board, in real Edge
// against the dev server, with real mouse input. Run from the project root.
// Starts its own Vite and Edge and stops exactly those two.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REVIEW = resolve('.tmp/slots-review');
const FIXTURES = resolve(process.argv[2] ?? '.tmp/e2e-fixtures');
const SKIP_PERF = !!process.env.SKIP_PERF;
mkdirSync(REVIEW, { recursive: true });
mkdirSync(FIXTURES, { recursive: true });
const DOWNLOADS = mkdtempSync(join(tmpdir(), 'wpv-downloads-'));
const APP_PORT = 5231;
const port = 9100 + Math.floor(Math.random() * 200);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const sharp = createRequire(resolve('package.json'))('sharp');
const noise = (size) => { const b = Buffer.alloc(size * size * 3); for (let i = 0; i < b.length; i++) b[i] = Math.random() * 256; return b; };
const gradient = (size) => { const b = Buffer.alloc(size * size * 4); for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) { const i = (y * size + x) * 4; b[i] = x * 255 / size; b[i + 1] = y * 255 / size; b[i + 2] = 120; b[i + 3] = 255; } return b; };
await sharp({ create: { width: 512, height: 512, channels: 3, background: { r: 255, g: 0, b: 255 } } }).png().toFile(join(FIXTURES, 'magenta.png'));
await sharp(gradient(512), { raw: { width: 512, height: 512, channels: 4 } }).png().toFile(join(FIXTURES, 'logo.png'));
await sharp(noise(2048), { raw: { width: 2048, height: 2048, channels: 3 } }).png({ compressionLevel: 1 }).toFile(join(FIXTURES, 'huge.png'));
writeFileSync(join(FIXTURES, 'garbage.pegboard'), 'this is not a layout at all');

const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--port', String(APP_PORT), '--strictPort'], { stdio: 'ignore' });
const profile = mkdtempSync(join(tmpdir(), 'wpv-slots-'));
spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--headless=new', '--disable-extensions', '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--no-first-run', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-features=CalculateNativeWinOcclusion', 'about:blank'], { stdio: 'ignore' });
const stopAll = () => {
  const leaf = profile.split(/[\\/]/).pop();
  spawnSync('powershell.exe', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name = 'msedge.exe'" | Where-Object { $_.CommandLine -like '*${leaf}*' -and $_.CommandLine -notlike '*--type=*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`], { stdio: 'ignore' });
  spawnSync('taskkill', ['/PID', String(vite.pid), '/T', '/F'], { stdio: 'ignore' });
};

let failures = 0;
const started = Date.now();
const check = (name, ok, detail = '') => { console.log(`[${Math.round((Date.now() - started) / 1000)}s] ${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : `: ${detail}`}`); if (!ok) failures += 1; };
const watchdog = setTimeout(() => { console.log('WATCHDOG: gave up after 15 minutes'); stopAll(); process.exit(2); }, 15 * 60 * 1000);

let target;
for (let i = 0; i < 50 && !target; i++) { await sleep(200); try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((e) => e.type === 'page'); } catch { /* still starting */ } }
for (let i = 0; i < 150; i++) { try { await fetch(`http://localhost:${APP_PORT}/`); break; } catch { await sleep(200); } }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0;
const pending = new Map();
const pageErrors = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Runtime.exceptionThrown') pageErrors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') pageErrors.push(m.params.args.map((a) => a.value ?? a.description).join(' ').slice(0, 300));
});
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result))); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expression) => {
  const r = await Promise.race([
    send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }),
    sleep(240000).then(() => { throw new Error(`evaluate timed out: ${expression.slice(0, 200)}`); }),
  ]);
  if (r.exceptionDetails) throw new Error(`${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text} in ${expression.slice(0, 160)}`);
  return r.result.value;
};
/** Real mouse input, at the middle of the element. */
const click = async (selector) => {
  const box = await evaluate(`(() => { const el = ${selector.startsWith('(') ? selector : `document.querySelector(${JSON.stringify(selector)})`}; if (!el) return null; el.scrollIntoView({ block: 'nearest' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  if (!box) throw new Error(`nothing to click: ${selector}`);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  // About as long as a finger holds a mouse button down.
  await sleep(70);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await sleep(120);
};
/** Waits for a condition instead of guessing how long the board's painting holds up a frame. */
const until = (expression, ms = 4000) => evaluate(`(async () => { const start = performance.now(); while (!(${expression}) && performance.now() - start < ${ms}) await new Promise((r) => setTimeout(r, 20)); return !!(${expression}); })()`);
const menuLatencies = [];
/** Clicks a slot's menu button and waits for the menu, recording how long it took. */
const openMenu = async (row) => {
  await click(`[data-slot="slots"] > :nth-child(${row}) [data-slot="slot-more"]`);
  const waited = await evaluate(`(async () => { const start = performance.now(); while (document.querySelectorAll('[role="menuitem"]').length < 4 && performance.now() - start < 3000) await new Promise((r) => setTimeout(r, 10)); return { ms: Math.round(performance.now() - start), open: document.querySelectorAll('[role="menuitem"]').length >= 4, fps: await new Promise((r) => { let n = 0; const t0 = performance.now(); const f = () => { n += 1; if (performance.now() - t0 < 200) requestAnimationFrame(f); else r(Math.round(n * 5)); }; requestAnimationFrame(f); }) }; })()`);
  menuLatencies.push(waited.ms);
  if (!waited.open) console.log('     MENU NEVER OPENED', JSON.stringify(waited), 'focus', await evaluate(`t.focused()`));
  return waited.open;
};
const key = async (name, code = name, vk = 13) => {
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: name, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  await sleep(80);
};
const shot = async (name) => { const { data } = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(REVIEW, `${name}.png`), Buffer.from(data, 'base64')); };
/** The panel section alone, twice the size, with room around it for menus. */
const panelShot = async (name) => {
  await evaluate(`document.querySelector('[data-slot="slots"]').scrollIntoView({ block: 'center' })`);
  await sleep(150);
  const rect = await evaluate(`(() => { const r = document.querySelector('[data-slot="slots"]').closest('[data-slot="board-section"]').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
  const clip = { x: Math.max(0, rect.x - 170), y: Math.max(0, rect.y - 12), width: rect.width + 182, height: Math.min(rect.height + 130, 1000 - Math.max(0, rect.y - 12)), scale: 2 };
  const { data } = await send('Page.captureScreenshot', { format: 'png', clip });
  writeFileSync(join(REVIEW, `${name}.png`), Buffer.from(data, 'base64'));
};
const importFile = async (path) => {
  const { result } = await send('Runtime.evaluate', { expression: `document.querySelector('[aria-label="Board file to open"]')` });
  await send('DOM.setFileInputFiles', { objectId: result.objectId, files: [path] });
};

const HELPERS = `
  window.t = {
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    q: (selector) => document.querySelector(selector),
    btn: (label) => document.querySelector('[aria-label="' + label + '"]'),
    tile: (n) => document.querySelector('[data-slot="slots"] > :nth-child(' + n + ')'),
    settle: async () => { await t.sleep(250); while (document.querySelector('[data-slot="board"][inert]') || document.querySelector('[data-slot="board-layout"]:disabled') || document.querySelector('[data-slot="slot-share"] button:disabled:first-child')) await t.sleep(50); await t.sleep(300); },
    plain: () => window.__showcase.getSnapshot().items.map(({ id, image, ...rest }) => ({ ...rest, aspect: image?.aspect })),
    settings: () => JSON.parse(localStorage.getItem('warpaint-viewer:showcase-settings')),
    slot: (n) => JSON.parse(localStorage.getItem('warpaint-viewer:showcase-slot-' + n)),
    status: () => [...document.querySelectorAll('[data-slot="slot-status"]')].map((region) => region.textContent).join(' ').trim() || null,
    undoStatus: () => document.querySelector('[data-undo]'),
    restoreStatus: () => document.querySelector('[data-restore]'),
    focused: () => { const el = document.activeElement; return el?.getAttribute('aria-label') ?? el?.textContent ?? el?.tagName; },
    imageKeys: () => new Promise((resolve, reject) => { const open = indexedDB.open('warpaint-viewer-board-images', 1); open.onsuccess = () => { const all = open.result.transaction('images').objectStore('images').getAllKeys(); all.onsuccess = () => { open.result.close(); resolve(all.result); }; all.onerror = () => reject(all.error); }; open.onerror = () => reject(open.error); }),
    picture: () => new Promise((resolve) => { const c = document.createElement('canvas'); c.width = 256; c.height = 128; const g = c.getContext('2d'); g.fillStyle = '#c23'; g.fillRect(0, 0, 256, 128); g.fillStyle = '#fff'; g.font = 'bold 60px sans-serif'; g.fillText('LOGO', 40, 85); c.toBlob(resolve, 'image/png'); }),
    segment: (group, label) => [...document.querySelectorAll('[aria-label="' + group + '"] button')].find((b) => b.textContent === label).click(),
    layout: (label) => [...document.querySelectorAll('[data-slot="board-layout"]')].find((b) => b.textContent === label).click(),
    startPump: () => { if (window.pumping) return; window.pumping = true; const f = () => requestAnimationFrame(f); requestAnimationFrame(f); },
    menuItem: (label) => [...document.querySelectorAll('[role="menuitem"]')].find((b) => b.textContent.includes(label)),
    saved: () => !!localStorage.getItem('warpaint-viewer:showcase-board'),
    colors: async () => {
      // Only the weapons' own pixels: shadows are too faint to pass the alpha test below.
      const background = t.settings()?.background ?? 'framed';
      window.__showcase.setBackground('transparent');
      const blob = await window.__showcase.exportPng(800);
      window.__showcase.setBackground(background);
      const bitmap = await createImageBitmap(blob);
      const c = document.createElement('canvas'); c.width = bitmap.width; c.height = bitmap.height;
      const g = c.getContext('2d'); g.drawImage(bitmap, 0, 0);
      const { data } = g.getImageData(0, 0, c.width, c.height);
      let r = 0, gr = 0, b = 0, n = 0;
      for (let i = 0; i < data.length; i += 4) if (data[i + 3] > 200) { r += data[i]; gr += data[i + 1]; b += data[i + 2]; n += 1; }
      return { r: r / n, g: gr / n, b: b / n, n };
    },
  };
`;
const openBoard = async (pump = true) => {
  await evaluate(`(async () => { const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); while (document.readyState !== 'complete' || !document.querySelector('[aria-label="Open showcase board"]')) await sleep(100); await sleep(1500); document.querySelector('[aria-label="Open showcase board"]').click(); while (!window.__showcase || !document.querySelector('[data-slot="slots"]')) await sleep(100); await sleep(400); })()`);
  await evaluate(HELPERS);
  if (pump) await evaluate(`t.startPump()`);
};
const reload = async () => { await send('Page.reload'); await sleep(800); await openBoard(); };
const clearAndWait = () => evaluate(`(async () => { t.btn('Clear board').click(); const start = performance.now(); while (t.saved() && performance.now() - start < 8000) await t.sleep(50); return !t.saved(); })()`);

try {
  await send('Runtime.enable');
  await send('DOM.enable');
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DOWNLOADS });
  await send('Page.navigate', { url: `http://localhost:${APP_PORT}/?kit=102&weapon=c_rocketlauncher` });
  await sleep(1500);
  await evaluate(`(() => { const k = 'warpaint-viewer:settings'; const v = JSON.parse(localStorage.getItem(k) || '{"state":{},"version":1}'); v.state.showcaseBoard = true; localStorage.setItem(k, JSON.stringify(v)); localStorage.setItem('warpaint-viewer:showcase-settings', JSON.stringify({ weaponSize: 80, background: 'pegboard', lightAzimuth: 40, lightElevation: 30, shadow: 20, outputWidth: 2560, grid: 'coarse', rotationSnap: 15, poseHandles: false })); })()`);
  await send('Page.reload');
  await sleep(800);
  await openBoard(false);

  await evaluate(`t.startPump()`);

  // Nothing on the board yet.
  check('three empty slots, none usable yet', await evaluate(`document.querySelectorAll('[data-slot="slot-new"]:disabled').length`) === 3);
  check('an empty board shows its slots as unavailable', await evaluate(`t.tile(1).textContent === 'Empty Slot'`));
  check('export waits for something to export', await evaluate(`[...document.querySelectorAll('[data-slot="slot-share"] button')].find((b) => b.textContent.includes('Share File')).disabled`));
  check('import is available on an empty board', await evaluate(`![...document.querySelectorAll('[data-slot="slot-share"] button')].find((b) => b.textContent.includes('Open File')).disabled`));
  await panelShot('01-empty-board');

  // A board with every kind of edit.
  await evaluate(`t.layout('Stock'); t.settle()`);
  await evaluate(`(async () => {
    const b = window.__showcase;
    await b.addImage(await t.picture(), 'Logo');
    const items = b.getSnapshot().items.filter((item) => !item.image);
    b.update(items[0].id, { roll: 45, tilt: 12, turn: -8, flipped: true, scale: 0.7 }); b.settle(items[0].id);
    b.setPaint(items[1].id, { wearIndex: 3, team: 'blu', seed: '777' });
    b.setHiddenMany([items[2].id], true);
    b.select(null);
    await t.settle();
    await b.whenPainted();
    await t.sleep(600);
  })()`);
  const before = await evaluate(`({ plain: t.plain(), ids: window.__showcase.getSnapshot().items.map((i) => i.id), layout: window.__showcase.appliedLayout, settings: t.settings() })`);
  await panelShot('02-board-not-saved-yet');

  // Save, then take it back from the status line.
  await click('[data-slot="slots"] > :nth-child(1) [data-slot="slot-new"]');
  check('saving says so, and the row names it', (await evaluate(`t.status()`)) === 'Saved in this browser.' && await evaluate(`t.tile(1).querySelector('[data-slot="slot-name"]').textContent`) === 'Wrapped Reviver Mk.II', await evaluate(`t.status()`));
  check('focus lands on the new slot after saving', await until(`t.focused()?.startsWith('Load Wrapped Reviver Mk.II')`), await evaluate(`t.focused()`));
  check('the saved slot shows its count and date', /^\d+ items, /.test(await evaluate(`t.tile(1).querySelector('[data-slot="slot-meta"]').textContent`)));
  check('the date is in the language of the interface', (await evaluate(`t.tile(1).querySelector('[data-slot="slot-meta"]').textContent`)).endsWith(await evaluate(`new Date().toLocaleDateString('en', { month: 'short', day: 'numeric' })`)));
  check('a slot saved while painting ends up with the finished picture', await until(`(async () => { await window.__showcase.whenPainted(); await t.sleep(100); return t.slot(1).thumbnail === window.__showcase.thumbnail(240); })()`, 20000));
  check('the current slot is announced', await evaluate(`t.tile(1).querySelector('[data-slot="slot-load"]').getAttribute('aria-current')`) === 'true');
  const saved = await evaluate(`t.slot(1)`);
  check('a save holds every item', JSON.stringify(saved.items.map(({ id: _id, image, ...rest }) => ({ ...rest, aspect: image?.aspect }))) === JSON.stringify(before.plain));
  check('a save holds the settings', JSON.stringify(saved.settings) === JSON.stringify(before.settings));
  check('a save holds the layout', JSON.stringify(saved.layout) === JSON.stringify(before.layout));
  check('a save has a real thumbnail', /^data:image\/webp;base64,/.test(saved.thumbnail ?? ''), String(saved.thumbnail).slice(0, 40));
  console.log(`     thumbnail ${saved.thumbnail?.length} chars, slot ${JSON.stringify(saved).length} chars`);
  check('the thumbnail shows', await evaluate(`(() => { const img = t.tile(1).querySelector('img'); return !!img && img.complete && img.naturalWidth === 240; })()`));
  check('the saved slot is marked current', await evaluate(`t.tile(1).hasAttribute('data-active')`));
  await panelShot('03-saved-first-slot');
  await shot('03-full-window');
  check('a first save offers no Undo that would delete it', await evaluate(`!t.undoStatus() && !t.restoreStatus()`));
  check('a save without a name goes by its paint', await evaluate(`t.slot(1).name`) === 'Wrapped Reviver Mk.II');
  // A double click saves once, and does not load what it just saved.
  const doubleClickPast = await evaluate(`window.__showcase.getSnapshot().canUndo`);
  await evaluate(`(async () => { const row = t.tile(3); row.querySelector('[data-slot="slot-new"]').click(); await t.sleep(50); row.querySelector('[data-slot="slot-load"]').click(); await t.settle(); })()`);
  check('a double click on an empty slot only saves', (await evaluate(`t.status()`))?.startsWith('Saved in this browser.') && doubleClickPast === await evaluate(`window.__showcase.getSnapshot().canUndo`), await evaluate(`t.status()`));
  await openMenu(3);
  await click(`(t.menuItem('Delete'))`);
  check('deleting offers Restore in the emptied row', (await evaluate(`t.status()`))?.startsWith('Deleted "Wrapped Reviver Mk.II 2"') && await evaluate(`!!t.tile(3).querySelector('[data-restore]') && t.tile(3).textContent.includes('Deleted')`), await evaluate(`t.status()`));

  // Changing the board offers to update the slot.
  check('no update offered while the board matches', await evaluate(`!t.q('[data-slot="slot-update"]')`));
  await evaluate(`(async () => { const b = window.__showcase; const item = b.getSnapshot().items.find((i) => !i.image && !i.hidden); b.setPaint(item.id, { seed: '4242' }); await t.sleep(300); })()`);
  check('a change marks the slot and offers an update', await until(`!!t.q('[data-slot="slot-update"]') && !!t.tile(1).querySelector('[data-slot="slot-modified"]')`));
  check('a changed slot says so to screen readers', (await evaluate(`t.tile(1).querySelector('[data-slot="slot-load"]').getAttribute('aria-label')`)).includes('changed since saved'));
  // Selecting a weapon hides the section; that must not cost the slot's Undo.
  await evaluate(`(async () => { const b = window.__showcase; b.select(b.getSnapshot().items.find((i) => !i.image && !i.hidden).id); await t.sleep(200); b.select(null); })()`);
  check('the section comes back after deselecting', await until(`t.q('[data-slot="slots"]')`));
  check('selecting a weapon keeps the way back for a slot', await evaluate(`!!t.restoreStatus()`));
  check('a board edit keeps it too, as it has nothing to do with the board', await evaluate(`!!t.tile(3).querySelector('[data-restore]')`));
  // A working preference is not a change to the board.
  await evaluate(`(async () => { window.__showcase.setPaint(window.__showcase.getSnapshot().items.find((i) => !i.image && !i.hidden).id, { seed: '0' }); await t.sleep(100); })()`);
  await panelShot('04-board-changed-since-save');
  await click('[data-slot="slot-update"]');
  check('updating leaves the slot current', await until(`t.tile(1).hasAttribute('data-active')`));
  check('updating clears the mark', await evaluate(`!t.q('[data-slot="slot-update"]') && !t.tile(1).querySelector('[data-slot="slot-modified"]')`));
  check('updating says so, and the row and its Undo name it', (await evaluate(`t.status()`))?.startsWith('Updated.') && await evaluate(`t.tile(1).querySelector('[data-slot="slot-name"]').textContent`) === 'Wrapped Reviver Mk.II' && await evaluate(`document.querySelector('[data-slot="slot-line"] [data-restore]').getAttribute('aria-label')`) === 'Undo, restoring the previous save of Wrapped Reviver Mk.II', await evaluate(`t.status()`));
  await click(`(document.querySelector('[data-slot="slot-line"] [data-restore]'))`);
  check('Restore brings the old save back, unlinked from what is now on the board', await until(`!t.q('[data-slot="slot-update"]') && !t.tile(1).hasAttribute('data-active')`));
  await openMenu(1);
  await click(`(t.menuItem('Replace with Current Board'))`);
  check('the status says it was replaced, and the row and its Undo name what', /^(Replaced|Updated)./.test(await evaluate(`t.status()`)) && await evaluate(`t.tile(1).querySelector('[data-slot="slot-name"]').textContent`) === 'Wrapped Reviver Mk.II' && await evaluate(`document.querySelector('[data-slot="slot-line"] [data-restore]').getAttribute('aria-label')`) === 'Undo, restoring the previous save of Wrapped Reviver Mk.II', await evaluate(`t.status()`));
  await openMenu(1);
  check('the menu keeps the way back after the status has gone', await evaluate(`!!t.menuItem('Restore Previous Save')`));
  await key('Escape', 'Escape', 27);

  // The menu and renaming, by mouse and keyboard.
  await openMenu(1);
  check('the menu has no paint to offer when the save already wears it', await evaluate(`!t.menuItem('Load with') && !!t.menuItem('Rename')`));
  check('Delete sits below the separator, and Load comes first', await evaluate(`(() => { const all = [...document.querySelectorAll('[role="menu"] > *')]; const line = all.findIndex((el) => el.getAttribute('data-slot') === 'menu-separator'); return all.findIndex((el) => el.textContent.includes('Delete')) > line && all.findIndex((el) => el.textContent.includes('Rename')) < line && all[0].textContent.trim() === 'Load'; })()`));
  await panelShot('05-slot-menu');
  const rowHeight = await evaluate(`t.tile(1).getBoundingClientRect().height`);
  await click(`(t.menuItem('Rename'))`);
  await sleep(200);
  check('renaming keeps the row\'s height', await evaluate(`t.tile(1).getBoundingClientRect().height`) === rowHeight);
  check('the field shows a default name whole', await evaluate(`(() => { const f = t.q('[data-slot="slot-rename"]'); return f.scrollWidth <= f.clientWidth && f.scrollLeft === 0; })()`));
  check('rename takes the focus and keeps it', await evaluate(`document.activeElement?.getAttribute('data-slot') === 'slot-rename'`), await evaluate(`document.activeElement?.getAttribute('data-slot')`));
  await panelShot('06-renaming');
  await send('Input.insertText', { text: 'Bee board' });
  await key('Enter');
  check('rename saves', await evaluate(`t.slot(1).name`) === 'Bee board', await evaluate(`t.slot(1).name`));
  check('focus returns to the menu button after renaming', await until(`t.focused()?.startsWith('More actions for Bee board')`), await evaluate(`t.focused()`));
  check('renaming can be undone', (await evaluate(`t.status()`))?.startsWith('Renamed to "Bee board"'), await evaluate(`t.status()`));
  check('rename shows', await evaluate(`t.tile(1).querySelector('[data-slot="slot-name"]').textContent`) === 'Bee board');
  await openMenu(1);
  await click(`(t.menuItem('Rename'))`);
  await sleep(200);
  await send('Input.insertText', { text: 'Thrown away' });
  await key('Escape', 'Escape', 27);
  check('Escape keeps the old name', await evaluate(`t.slot(1).name`) === 'Bee board');

  // The menu must open every time, including straight after saving or closing it.
  menuLatencies.length = 0;
  let menuOpens = 0;
  const STRESS = 25;
  for (let attempt = 0; attempt < STRESS; attempt += 1) {
    const open = await openMenu(1);
    if (open) menuOpens += 1;
    else console.log(`     menu did not open on attempt ${attempt}: focus ${await evaluate(`t.focused()`)}`);
    if (open) await key('Escape', 'Escape', 27);
    if (attempt % 5 === 4) { await openMenu(1); await sleep(50); await key('Escape', 'Escape', 27); }
    await sleep(attempt % 3 === 0 ? 0 : 120);
  }
  check(`the menu opens every time (${menuOpens} of ${STRESS})`, menuOpens === STRESS);
  console.log('     LATENCY slot menu ms', JSON.stringify(menuLatencies));


  // Delete, then take it back.
  await click('[data-slot="slots"] > :nth-child(2) [data-slot="slot-new"]');
  await openMenu(2);
  await click(`(t.menuItem('Delete'))`);
  check('delete empties the slot at once', await evaluate(`t.slot(2) === null`));
  check('delete says so', (await evaluate(`t.status()`))?.startsWith('Deleted "Wrapped Reviver Mk.II"'));
  check('focus moves to Restore after deleting', await until(`document.activeElement === t.tile(2).querySelector('[data-restore]')`), await evaluate(`t.focused()`));
  await panelShot('07-deleted-with-undo');
  check('a deleted row shows what it held', await evaluate(`t.tile(2).querySelector('[data-slot="slot-meta"]').textContent === 'Deleted: Wrapped Reviver Mk.II' && t.tile(2).querySelector('[data-slot="slot-name"]').textContent === 'Save Board Here' && t.tile(2).querySelector('[data-slot="slot-new"]').textContent.startsWith('Deleted: ')`));
  // Saving over a deleted row, right beside Restore, must not cost the deleted save; nor may restoring cost what it replaces.
  const deletedAt = (await evaluate(`localStorage.getItem('warpaint-viewer:showcase-slot-2-previous') && JSON.parse(localStorage.getItem('warpaint-viewer:showcase-slot-2-previous')).savedAt`));
  await click('[data-slot="slots"] > :nth-child(2) [data-slot="slot-new"]');
  const overAt = (await evaluate(`t.slot(2)`)).savedAt;
  check('saving into a deleted row offers the deleted save back', await until(`[...document.querySelectorAll('[data-note-action]')].some((b) => b.textContent === 'Restore Deleted')`));
  await openMenu(2);
  check('saving into a deleted row keeps the deleted save', await evaluate(`!!t.menuItem('Restore Previous Save')`));
  await click(`(t.menuItem('Restore Previous Save'))`);
  check('restore brings the deleted save back', (await evaluate(`t.slot(2)`)).savedAt === deletedAt);
  check('restore offers to take it back', await until(`[...document.querySelectorAll('[data-note-action]')].some((b) => b.textContent === 'Undo')`));
  await sleep(11000);
  check('a note does not time out', (await evaluate(`t.status()`))?.includes('Restored'), await evaluate(`t.status()`));
  await click(`([...document.querySelectorAll('[data-note-action]')].find((b) => b.textContent === 'Undo'))`);
  check('undoing a restore brings back what it replaced', (await evaluate(`t.slot(2)`)).savedAt === overAt);
  await evaluate(`(async () => { const b = window.__showcase; const item = b.getSnapshot().items.find((i) => !i.image && !i.hidden); const seed = item.paint.seed; b.setPaint(item.id, { seed: '4243' }); await t.sleep(300); window.seedBack = [item.id, seed]; })()`);
  check('a note goes once the board changes', await until(`!(t.status() ?? '').includes('Restored')`), await evaluate(`t.status()`));
  await evaluate(`(async () => { window.__showcase.setPaint(window.seedBack[0], { seed: window.seedBack[1] }); await t.sleep(300); })()`);
  await openMenu(2);
  await click(`(t.menuItem('Delete'))`);
  await sleep(200);
  const clearButton = `([...t.tile(2).querySelectorAll('[data-slot="slot-deleted-actions"] button')].find((b) => b.textContent.trim() === 'Clear'))`;
  await click(clearButton);
  check('clearing a deleted row empties it', await until(`!t.tile(2).querySelector('[data-restore]') && t.tile(2).textContent === 'Save Board Here' && localStorage.getItem('warpaint-viewer:showcase-slot-2-previous') === null`));
  await click(`([...document.querySelectorAll('[data-note-action]')].find((b) => b.textContent === 'Undo'))`);
  check('clearing can be undone', await until(`document.activeElement === t.tile(2).querySelector('[data-restore]') && !!localStorage.getItem('warpaint-viewer:showcase-slot-2-previous')`), await evaluate(`t.focused()`));
  // Opening another board must not cost the way back for a slot, nor must dismissing an unrelated error.
  await click('[data-slot="slots"] > :nth-child(1) [data-slot="slot-load"]');
  await evaluate(`t.settle()`);
  check('loading another board keeps the way back for a deleted slot', await until(`!!t.tile(2).querySelector('[data-restore]')`));
  check('both ways back are on offer together', await evaluate(`!!t.undoStatus()`));
  await importFile(join(FIXTURES, 'garbage.pegboard'));
  await evaluate(`t.settle()`);
  await click('[data-slot="slot-dismiss"]');
  check('dismissing an error leaves the way back alone', await until(`!t.q('[data-kind="error"]')`) && await evaluate(`!!t.tile(2).querySelector('[data-restore]')`));
  // Each slot keeps its own way back: changing another slot must not cost it.
  await openMenu(1);
  await click(`(t.menuItem('Rename'))`);
  await sleep(200);
  await send('Input.insertText', { text: 'Bee board' });
  await key('Enter');
  check('renaming another slot keeps the way back', await until(`!!t.tile(2).querySelector('[data-restore]')`));
  await click(`(t.tile(2).querySelector('[data-restore]'))`);
  check('Restore brings it back', await until(`t.slot(2)?.name === 'Wrapped Reviver Mk.II'`), JSON.stringify(await evaluate(`t.slot(2)?.name`)));
  await openMenu(2);
  await click(`(t.menuItem('Delete'))`);

  // Load, with settings changed in between.
  const beforeLoad = await evaluate(`({ plain: t.plain(), settings: t.settings(), layout: window.__showcase.appliedLayout, saved: t.slot(1) })`);
  await evaluate(`(async () => { t.segment('Background', 'Framed'); t.btn('Shadows').click(); await t.sleep(200); })()`);
  await clearAndWait();
  check('the board really cleared', await evaluate(`window.__showcase.getSnapshot().items.length`) === 0);
  await click('[data-slot="slots"] > :nth-child(1) [data-slot="slot-load"]');
  await evaluate(`t.settle()`);
  check('loading restores every item', await evaluate(`JSON.stringify(t.plain())`) === JSON.stringify(beforeLoad.plain));
  check('loading restores the settings', await evaluate(`JSON.stringify(t.settings())`) === JSON.stringify(beforeLoad.settings));
  check('loading restores the layout', await evaluate(`JSON.stringify(window.__showcase.appliedLayout)`) === JSON.stringify(beforeLoad.layout));
  check('loading says so, and the row and its Undo name it', (await evaluate(`t.status()`))?.startsWith('Loaded.') && await evaluate(`t.tile(1).querySelector('[data-slot="slot-name"]').textContent`) === 'Bee board' && await evaluate(`t.undoStatus().getAttribute('aria-label')`) === 'Undo loading Bee board', await evaluate(`t.status()`));
  check('a loaded board is not marked changed', await evaluate(`!t.q('[data-slot="slot-update"]')`));
  await sleep(800);
  await shot('08-loaded-full-window');
  await click(`(t.undoStatus())`);
  await evaluate(`t.settle()`);
  check('undoing a load empties the board again', await evaluate(`window.__showcase.getSnapshot().items.length`) === 0);
  check('undoing a load takes the settings back too', await evaluate(`t.settings().background === 'framed' && t.settings().shadows === false`));
  await click('[data-slot="slots"] > :nth-child(1) [data-slot="slot-load"]');
  await evaluate(`t.settle()`);
  await evaluate(`window.__showcase.undo(); t.settle()`);
  check('Ctrl+Z also steps back over a load', await evaluate(`window.__showcase.getSnapshot().items.length`) === 0);
  check('Ctrl+Z takes the settings back with it', await evaluate(`t.settings().background === 'framed' && t.settings().shadows === false`), await evaluate(`JSON.stringify(t.settings())`));
  await evaluate(`window.__showcase.redo(); t.settle()`);
  check('redo brings it back', await evaluate(`JSON.stringify(t.plain())`) === JSON.stringify(beforeLoad.plain));
  check('redo brings the settings back', await evaluate(`JSON.stringify(t.settings())`) === JSON.stringify(beforeLoad.settings));
  // A working preference does not make a board look changed.
  await evaluate(`t.btn('Show Footprints').click()`);
  await sleep(300);
  check('toggling footprints does not mark the board as changed', await evaluate(`!t.q('[data-slot="slot-update"]') && t.tile(1).hasAttribute('data-active')`));
  await evaluate(`t.btn('Show Footprints').click()`);
  // Clearing ends the link to the slot, so the next board cannot overwrite it, and undoing the clear brings it back.
  await clearAndWait();
  check('an empty board offers no update and is not tied to the slot', await until(`!t.q('[data-slot="slot-update"]') && !t.tile(1).hasAttribute('data-active')`));
  await evaluate(`window.__showcase.undo(); t.settle()`);
  check('undoing the clear links the board to the slot again', await until(`t.tile(1).hasAttribute('data-active')`));
  await evaluate(`window.__showcase.reapplyLayout().then(() => t.settle())`);
  check('Fill works on a loaded layout', await evaluate(`window.__showcase.getSnapshot().items.filter((i) => !i.image).length`) === beforeLoad.plain.filter((i) => i.aspect === undefined).length);
  await click('[data-slot="slots"] > :nth-child(1) [data-slot="slot-load"]');
  await evaluate(`t.settle()`);

  // A saved board as a template for another paint.
  const inPaintBefore = await evaluate(`({ slot: JSON.stringify(t.slot(1)), plain: t.plain(), kit: t.plain().find((i) => i.aspect === undefined).paint.kitId })`);
  await click(`([...document.querySelectorAll('[data-slot="catalog-row"]')].find((el) => el.textContent.includes('Bovine Blazemaker Mk.II')))`);
  await sleep(500);
  await openMenu(1);
  check('the menu offers the selected paint', await evaluate(`!!t.menuItem('Load with Bovine Blazemaker Mk.II')`));
  await panelShot('08b-load-with-paint-menu');
  await click(`(t.menuItem('Load with'))`);
  await evaluate(`t.settle()`);
  const repainted = await evaluate(`({ plain: t.plain(), status: t.status(), slot: JSON.stringify(t.slot(1)), active: t.tile(1).hasAttribute('data-active'), update: !!t.q('[data-slot="slot-update"]'), layoutKits: [...new Set(window.__showcase.appliedLayout.rows.flat().map((r) => r.paint.kitId))] })`);
  const weaponsAfter = repainted.plain.filter((i) => i.aspect === undefined);
  const newKit = weaponsAfter[0].paint.kitId;
  check('the board takes the selected paint', newKit !== inPaintBefore.kit && weaponsAfter.every((i) => i.paint.kitId === newKit), JSON.stringify(weaponsAfter.map((i) => i.paint.kitId)));
  check('the arrangement, wear, team and seed stay', JSON.stringify(repainted.plain.map((i) => [i.x, i.y, i.roll, i.scale, i.hidden, i.paint.wearIndex, i.paint.team, i.paint.seed])) === JSON.stringify(inPaintBefore.plain.map((i) => [i.x, i.y, i.roll, i.scale, i.hidden, i.paint.wearIndex, i.paint.team, i.paint.seed])));
  check('Fill keeps the new paint', repainted.layoutKits.length === 1 && repainted.layoutKits[0] === newKit, JSON.stringify(repainted.layoutKits));
  check('the slot itself is untouched', repainted.slot === inPaintBefore.slot);
  check('the result is not tied to the slot, so Update cannot overwrite it', !repainted.active && !repainted.update);
  check('loading with a paint says so', repainted.status?.includes('with Bovine Blazemaker Mk.II'), repainted.status);
  await sleep(1200);
  await shot('08c-loaded-with-paint-full-window');
  await click(`(t.undoStatus())`);
  await evaluate(`t.settle()`);
  check('undo brings the original paint back', await evaluate(`JSON.stringify(t.plain())`) === JSON.stringify(inPaintBefore.plain));
  check('undo restores the link to the slot', await evaluate(`t.tile(1).hasAttribute('data-active')`));
  await click(`([...document.querySelectorAll('[data-slot="catalog-row"]')].find((el) => el.textContent.includes('Wrapped Reviver Mk.II')))`);
  await sleep(300);

  // Export for real, then import that very file.
  const shareButton = (label) => `([...document.querySelectorAll('[data-slot="slot-share"] button')].find((b) => b.textContent.includes('${label}')))`;
  await click(shareButton('Share File'));
  await evaluate(`t.settle()`);
  check('export says what it made', (await evaluate(`t.status()`) ?? '').includes('Downloaded Bee board.pegboard ('), await evaluate(`t.status()`));
  await panelShot('09-exported');
  let exported = null;
  for (let i = 0; i < 40 && !exported; i++) { await sleep(100); exported = readdirSync(DOWNLOADS).find((name) => name.endsWith('.pegboard')) ?? null; }
  check('the file really downloaded', !!exported, readdirSync(DOWNLOADS).join(','));
  const exportedPath = join(DOWNLOADS, exported);
  const fileBytes = readFileSync(exportedPath);
  const pictureSize = await evaluate(`(async () => { const b = await t.picture(); return b.size; })()`);
  console.log(`     ${exported}: ${fileBytes.length} bytes, of which about ${pictureSize} picture; same data as JSON ${JSON.stringify(beforeLoad.saved).length} chars`);
  check('the file starts with its magic', fileBytes.subarray(0, 4).toString() === 'WPLY');
  writeFileSync(join(FIXTURES, 'exported.pegboard'), fileBytes);

  const assetBefore = await evaluate(`window.__showcase.getSnapshot().items.find((i) => i.image).image.assetId`);
  await evaluate(`t.segment('Background', 'Transparent')`);
  await evaluate(`(async () => { t.btn('Show Footprints').click(); t.segment('Rotation Snap', 'Free'); await t.sleep(200); })()`);
  const myPrefs = await evaluate(`(() => { const s = t.settings(); return { showFootprints: s.showFootprints, rotationSnap: s.rotationSnap, snapToGrid: s.snapToGrid, poseHandles: s.poseHandles, outputWidth: s.outputWidth }; })()`);
  await clearAndWait();
  await importFile(exportedPath);
  await evaluate(`t.settle()`);
  const imported = await evaluate(`({ plain: t.plain(), settings: t.settings(), status: t.status(), asset: window.__showcase.getSnapshot().items.find((i) => i.image)?.image?.assetId, layout: window.__showcase.appliedLayout })`);
  check('import restores every item', JSON.stringify(imported.plain) === JSON.stringify(beforeLoad.plain));
  check('import brings the look of the board', imported.settings.background === beforeLoad.settings.background && imported.settings.lightAzimuth === beforeLoad.settings.lightAzimuth && imported.settings.weaponSize === beforeLoad.settings.weaponSize && imported.settings.grid === beforeLoad.settings.grid, JSON.stringify(imported.settings));
  check('import leaves the receiver\'s own preferences alone', Object.entries(myPrefs).every(([key, value]) => imported.settings[key] === value), JSON.stringify(myPrefs));
  check('import restores the layout', JSON.stringify(imported.layout) === JSON.stringify(beforeLoad.layout));
  check('import says so', imported.status?.startsWith('Opened "Bee board"'), imported.status);
  check('an imported picture gets an id of its own', !!imported.asset && imported.asset !== assetBefore);
  check('the imported picture is really stored', (await evaluate(`t.imageKeys()`)).includes(imported.asset));
  await sleep(900);
  await panelShot('10-imported');
  await shot('10-imported-full-window');
  await click(`(t.undoStatus())`);
  await evaluate(`t.settle()`);
  check('undoing an import restores the board and settings', await evaluate(`window.__showcase.getSnapshot().items.length`) === 0 && await evaluate(`t.settings().background`) === 'transparent');
  await evaluate(`(async () => { t.segment('Background', 'Pegboard'); t.btn('Show Footprints').click(); t.segment('Rotation Snap', '15°'); await t.sleep(200); })()`);

  // Dropping a file on the board, as you would from a chat window.
  // Anywhere on the page, not only the board: the panel beside it, here.
  const stage = await evaluate(`(() => { const r = t.q('[data-slot="board-panel"], [data-slot="slots"]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + 10 }; })()`);
  const dragData = { items: [], files: [exportedPath], dragOperationsMask: 1 };
  await send('Input.dispatchDragEvent', { type: 'dragEnter', x: stage.x, y: stage.y, data: dragData });
  await send('Input.dispatchDragEvent', { type: 'dragOver', x: stage.x, y: stage.y, data: dragData });
  await sleep(150);
  check('dragging a file over the board shows where it goes', await evaluate(`!!t.q('[data-slot="board-drop-hint"]')`));
  await shot('10b-dropping-a-file');
  await send('Input.dispatchDragEvent', { type: 'drop', x: stage.x, y: stage.y, data: dragData });
  await sleep(200);
  await evaluate(`t.settle()`);
  check('dropping a file imports it', (await evaluate(`t.status()`))?.startsWith('Opened "Bee board"') && await evaluate(`window.__showcase.getSnapshot().items.length`) === beforeLoad.plain.length, await evaluate(`t.status()`));
  check('focus goes to Undo after a drop', await until(`document.activeElement === t.undoStatus()`), await evaluate(`t.focused()`));
  // An imported board keeps its name when saved to a slot.
  await evaluate(`t.tile(3).querySelector('[data-slot="slot-new"]').click()`);
  check('an imported board keeps its name when saved, numbered as slot 1 already uses it', await until(`t.slot(3)?.name === 'Bee board 2'`), JSON.stringify(await evaluate(`t.slot(3)?.name`)));
  await openMenu(3);
  await click(`(t.menuItem('Delete'))`);
  await evaluate(`window.__showcase.undo(); t.settle()`);
  check('the drop hint goes away', await evaluate(`!t.q('[data-slot="board-drop-hint"]')`));
  await clearAndWait();

  // Files that cannot be used.
  await importFile(join(FIXTURES, 'garbage.pegboard'));
  await evaluate(`t.settle()`);
  check('a foreign file gets a plain error', (await evaluate(`t.q('[data-slot="slot-status"][role="alert"]')?.textContent`))=== 'Not a .pegboard file.', await evaluate(`t.status()`));
  await panelShot('11-import-error');
  writeFileSync(join(FIXTURES, 'cut.pegboard'), fileBytes.subarray(0, 60));
  await importFile(join(FIXTURES, 'cut.pegboard'));
  await evaluate(`t.settle()`);
  check('a cut-off file says it is damaged', (await evaluate(`t.q('[data-slot="slot-status"][role="alert"]')?.textContent`))?.startsWith('This .pegboard file is damaged.'), await evaluate(`t.status()`));
  check('a bad file leaves the board alone', await evaluate(`window.__showcase.getSnapshot().items.length`) === 0);

  // A paint this person does not have.
  const foreign = await evaluate(`(async () => {
    const { writeLayoutFile } = await import('/src/ui/showcase/layoutFile.ts');
    const slot = t.slot(1);
    const items = slot.items.filter((item) => !item.image).slice(0, 3).map((item) => ({ ...item, paint: { ...item.paint, kitId: 987654 } }));
    const { file } = await writeLayoutFile({ ...slot, name: 'From a friend', items, layout: null }, async () => null);
    const buffer = new Uint8Array(await file.arrayBuffer());
    return btoa(String.fromCharCode(...buffer));
  })()`);
  writeFileSync(join(FIXTURES, 'foreign.pegboard'), Buffer.from(foreign, 'base64'));
  await importFile(join(FIXTURES, 'foreign.pegboard'));
  await evaluate(`t.settle()`);
  check('paints this viewer lacks are pointed out', (await evaluate(`t.status()`))?.includes('show unpainted: their paints are not in this viewer'), await evaluate(`t.status()`));
  await sleep(11000);
  check('a partial import\'s warning does not time out', (await evaluate(`t.status()`))?.includes('show unpainted'), await evaluate(`t.status()`));
  await evaluate(`t.btn('Clear board').click(); t.sleep(100)`);

  // A refused write.
  await evaluate(`(async () => { await window.__showcase.addAt('c_pistol', { kitId: 102, kitName: 'x', team: 'red', wearIndex: 0, seed: '0' }, 0, 0); window.__showcase.select(null); await t.settle(); })()`);
  const refused = await evaluate(`(async () => {
    const real = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) { if (key.includes('showcase-slot')) throw new DOMException('full', 'QuotaExceededError'); return real.call(this, key, value); };
    while (t.tile(3).querySelector('[data-slot="slot-new"]').disabled) await t.sleep(20);
    t.tile(3).querySelector('[data-slot="slot-new"]').click();
    await t.sleep(100);
    Storage.prototype.setItem = real;
    return { alert: t.q('[data-slot="slot-status"][role="alert"]')?.textContent ?? null, stored: t.slot(3), stillEmpty: !!t.tile(3).querySelector('[data-slot="slot-new"]') };
  })()`);
  check('a refused save shows an error and changes nothing', !!refused.alert && refused.stored === null && refused.stillEmpty, JSON.stringify(refused));
  await panelShot('12-storage-error');
  await click('[data-slot="slots"] > :nth-child(3) [data-slot="slot-new"]');
  check('a save that works clears the earlier failure', await until(`!t.q('[data-kind="error"]')`), await evaluate(`t.status()`));
  await openMenu(3);
  check('a save cannot be replaced with itself', await evaluate(`!t.menuItem('Replace with Current Board')`));
  check('the menu can load the save', await evaluate(`!!t.menuItem('Load') && [...document.querySelectorAll('[role="menuitem"]')].some((b) => b.textContent.trim() === 'Load')`));
  await click(`(t.menuItem('Load'))`);
  await evaluate(`t.settle()`);
  await openMenu(3);
  await key('Escape', 'Escape', 27);
  check('the menu still hands the focus back after loading from it', await until(`document.activeElement === t.tile(3).querySelector('[data-slot="slot-more"]')`), await evaluate(`t.focused()`));
  await evaluate(`t.btn('Show Footprints').click()`);
  await sleep(200);
  await openMenu(3);
  check('a save can take a changed working preference', await evaluate(`!!t.menuItem('Replace with Current Board')`));
  await key('Escape', 'Escape', 27);
  await evaluate(`t.btn('Show Footprints').click()`);
  await sleep(200);
  await evaluate(`(async () => { const b = window.__showcase; const item = b.getSnapshot().items.find((i) => !i.image && !i.hidden); b.setPaint(item.id, { seed: '4244' }); await t.sleep(300); })()`);
  await openMenu(3);
  await evaluate(`(() => { window.realSetItem = Storage.prototype.setItem; Storage.prototype.setItem = function (key, value) { if (key.endsWith('-previous')) throw new DOMException('full', 'QuotaExceededError'); return window.realSetItem.call(this, key, value); }; })()`);
  await click(`(t.menuItem('Replace with Current Board'))`);
  await evaluate(`Storage.prototype.setItem = window.realSetItem`);
  check('a way back that cannot be stored is said out loud', await until(`t.q('[data-kind="warning"]')?.textContent === 'Previous save kept for this session only: storage is full or blocked.'`), await evaluate(`t.status()`));
  await click('[data-slot="slot-dismiss"]');
  await openMenu(3);
  await click(`(t.menuItem('Delete'))`);
  await sleep(200);
  await clearAndWait();
  // A ready-made layout has nothing to do with the slot the board came from.
  await click('[data-slot="slots"] > :nth-child(1) [data-slot="slot-load"]');
  await evaluate(`t.settle()`);
  check('a loaded slot is current', await evaluate(`t.tile(1).hasAttribute('data-active')`));
  await sleep(200);
  check('the current slot survives in storage', await evaluate(`localStorage.getItem('warpaint-viewer:showcase-active-slot')`) === '0');
  await evaluate(`(async () => { const start = performance.now(); while (!t.saved() && performance.now() - start < 8000) await t.sleep(50); })()`);

  // Restart: slots and their pictures survive, and a cold load blocks the UI while it runs.
  const slotAsset = (await evaluate(`t.slot(1)`)).items.find((i) => i.image).image.assetId;
  await reload();
  await sleep(600);
  check('a picture used only by a slot survives a restart', (await evaluate(`t.imageKeys()`)).includes(slotAsset));
  check('slots and names survive a restart', await evaluate(`t.tile(1).querySelector('[data-slot="slot-name"]').textContent`) === 'Bee board');
  check('the link to the current slot survives a restart', await evaluate(`t.tile(1).hasAttribute('data-active')`));
  check('a deleted board can still be restored after a restart', await evaluate(`!!t.tile(2).querySelector('[data-restore]')`));
  await click(`(t.tile(2).querySelector('[data-restore]'))`);
  await until(`!!t.slot(2)`);
  await openMenu(2);
  await click(`(t.menuItem('Delete'))`);
  await evaluate(`t.layout('Melee'); t.settle()`);
  check('a ready-made layout is not treated as the slot', await until(`!t.tile(1).hasAttribute('data-active') && !t.q('[data-slot="slot-update"]')`));
  await clearAndWait();
  check('a picture left over from an undone import is cleaned up', !(await evaluate(`t.imageKeys()`)).includes(imported.asset));
  await evaluate(`(async () => { await window.__showcase.addAt('c_pistol', { kitId: 102, kitName: 'x', team: 'red', wearIndex: 0, seed: '0' }, 0, 0); window.__showcase.select(null); await t.settle(); })()`);
  const pistolId = await evaluate(`window.__showcase.getSnapshot().items[0].id`);
  const blocked = await evaluate(`(async () => {
    const seen = { board: false, panel: false };
    const observer = new MutationObserver(() => { seen.board ||= !!t.q('[data-slot="board"][inert]'); seen.panel ||= !!t.q('[data-slot="board-panel"][inert]'); });
    observer.observe(document.body, { attributes: true, attributeFilter: ['inert'], subtree: true });
    t.tile(1).querySelector('[data-slot="slot-load"]').click();
    await t.settle();
    await t.sleep(200);
    observer.disconnect();
    return seen;
  })()`);
  check('the board and panel are blocked during a cold load', blocked.board && blocked.panel, JSON.stringify(blocked));
  check('a cold load restores every item as the slot holds it', await evaluate(`JSON.stringify(t.plain()) === JSON.stringify(t.slot(1).items.map(({ id, image, ...rest }) => ({ ...rest, aspect: image?.aspect })))`));
  check('a saved id reused by a new weapon does not get mixed up', !(await evaluate(`window.__showcase.getSnapshot().items.map((i) => i.id)`)).includes(pistolId));
  check('the picture loads after a restart', await evaluate(`(() => { const p = window.__showcase.getSnapshot().items.find((i) => i.image); return !!p && !!window.__showcase.imageUrl(p.image.assetId); })()`));

  await evaluate(`t.layout('Melee'); t.settle()`);
  await evaluate(`window.__showcase.whenPainted().then(() => t.sleep(500))`);
  await click('[data-slot="slots"] > :nth-child(2) [data-slot="slot-new"]');
  await evaluate(`t.layout('RED and BLU'); t.settle()`);
  await evaluate(`window.__showcase.whenPainted().then(() => t.sleep(500))`);
  await click('[data-slot="slots"] > :nth-child(3) [data-slot="slot-new"]');
  await sleep(300);
  await evaluate(`t.layout('Stock'); t.settle()`);
  check('with every slot full and a new board, no slot is current', await until(`document.querySelectorAll('[data-slot="slot-load"]').length === 3 && !t.q('[data-active]')`));
  await panelShot('13-all-three-slots-full');
  await shot('13-full-window');

  const stalls = (label, start) => evaluate(`(async () => {
    const tasks = [];
    const observer = new PerformanceObserver((list) => { for (const entry of list.getEntries()) tasks.push(entry.duration); });
    observer.observe({ entryTypes: ['longtask'] });
    let worstFrame = 0, last = performance.now(), live = true;
    const frame = (now) => { worstFrame = Math.max(worstFrame, now - last); last = now; if (live) requestAnimationFrame(frame); };
    requestAnimationFrame(frame);
    const begin = performance.now();
    ${start};
    await t.settle();
    const ui = performance.now() - begin;
    await window.__showcase.whenPainted();
    const painted = performance.now() - begin;
    await t.sleep(500);
    live = false;
    observer.disconnect();
    return { label: ${JSON.stringify(label)}, uiMs: Math.round(ui), paintedMs: Math.round(painted), worstFrameMs: Math.round(worstFrame), longTasks: tasks.length, longestTaskMs: Math.round(Math.max(0, ...tasks)), totalBlockedMs: Math.round(tasks.reduce((a, b) => a + b, 0)) };
  })()`);
  await clearAndWait();
  console.log('STALLS', JSON.stringify(await stalls('built-in Stock layout', `t.layout('Stock')`)));
  await clearAndWait();
  console.log('STALLS', JSON.stringify(await stalls('slot load, warm', `t.tile(1).querySelector('[data-slot="slot-load"]').click()`)));
  await clearAndWait();
  await importFile(exportedPath);
  console.log('STALLS', JSON.stringify(await stalls('after importing a file', `await t.sleep(0)`)));

  // Undo must not outlive the state it would undo.
  await click('[data-slot="slots"] > :nth-child(1) [data-slot="slot-load"]');
  await evaluate(`t.settle()`);
  check('Undo is offered after a load', await evaluate(`!!t.undoStatus()`));
  await sleep(7000);
  check('Undo waits, however long the board takes to paint', await evaluate(`!!t.undoStatus()`));
  await evaluate(`(async () => { const b = window.__showcase; const item = b.getSnapshot().items.find((i) => !i.image && !i.hidden); b.setPaint(item.id, { seed: '31337' }); await t.sleep(300); })()`);
  check('editing the board withdraws Undo, so it cannot undo the edit by mistake', await until(`!t.undoStatus()`));

  // Thumbnails and every save stay out of the way of the frame rate.
  if (!SKIP_PERF) {
    const bench = await evaluate(`(async () => {
      const { readLayoutFile, writeLayoutFile } = await import('/src/ui/showcase/layoutFile.ts');
      const board = window.__showcase;
      const p = (values, q) => { const sorted = [...values].sort((a, b) => a - b); return +sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)].toFixed(2); };
      const logo = await (await fetch('/@fs/${FIXTURES.replaceAll('\\', '/')}/logo.png')).blob();
      const huge = await (await fetch('/@fs/${FIXTURES.replaceAll('\\', '/')}/huge.png')).blob();
      const stored = new Map([['logo', logo], ['huge', huge]]);
      const readPicture = async (id) => stored.get(id) ?? null;
      const base = t.slot(1);
      const weapon = base.items.find((item) => !item.image);
      const scenario = async (name, items, runs) => {
        const layout = { ...base, items, layout: null };
        const write = [], read = [], full = [];
        let file;
        for (let run = 0; run < runs; run += 1) {
          let start = performance.now();
          ({ file } = await writeLayoutFile(layout, readPicture));
          write.push(performance.now() - start);
          start = performance.now();
          const parsed = await readLayoutFile(file);
          read.push(performance.now() - start);
          start = performance.now();
          await Promise.all(parsed.pictures.map((picture) => board.importImage(picture)));
          full.push(read[read.length - 1] + performance.now() - start);
        }
        return { name, bytes: file.size, runs, writeP50: p(write, 0.5), writeP95: p(write, 0.95), readP50: p(read, 0.5), readP95: p(read, 0.95), readWithPicturesP50: p(full, 0.5), readWithPicturesP95: p(full, 0.95) };
      };
      const many = (count, picture) => [
        ...Array.from({ length: count }, (_, index) => ({ ...weapon, id: 'item-' + index, x: index * 1.25, roll: index, scale: 0.7 + index / 1000 })),
        ...(picture ? [{ ...base.items.find((item) => item.image), id: 'item-pic', image: { assetId: picture, aspect: 1 } }] : []),
      ];
      const results = [];
      results.push(await scenario('15 weapons, no picture', many(15), 200));
      results.push(await scenario('15 weapons, 512 px logo', many(15, 'logo'), 200));
      results.push(await scenario('60 weapons, 2048 px noise picture (worst case)', many(60, 'huge'), 60));
      const saves = [];
      for (let run = 0; run < 60; run += 1) {
        const start = performance.now();
        const thumbnail = board.thumbnail(240);
        localStorage.setItem('warpaint-viewer:bench', JSON.stringify({ ...base, thumbnail }));
        saves.push(performance.now() - start);
      }
      localStorage.removeItem('warpaint-viewer:bench');
      return { results, slotSave: { p50: p(saves, 0.5), p95: p(saves, 0.95) }, hugeBytes: huge.size };
    })()`);
    for (const row of bench.results) console.log('BENCH', JSON.stringify(row));
    console.log('BENCH slot save with thumbnail', JSON.stringify(bench.slotSave), 'huge picture bytes', bench.hugeBytes);
    for (const row of bench.results) {
      check(`p95 write under 250 ms: ${row.name}`, row.writeP95 < 250, String(row.writeP95));
      check(`p95 read under 250 ms: ${row.name}`, row.readWithPicturesP95 < 250, String(row.readWithPicturesP95));
    }
  }

  // Several files at once, on the board.
  const twoFiles = { items: [], files: [exportedPath, join(FIXTURES, 'logo.png')], dragOperationsMask: 1 };
  await send('Input.dispatchDragEvent', { type: 'dragEnter', x: stage.x, y: stage.y, data: twoFiles });
  await send('Input.dispatchDragEvent', { type: 'dragOver', x: stage.x, y: stage.y, data: twoFiles });
  await send('Input.dispatchDragEvent', { type: 'drop', x: stage.x, y: stage.y, data: twoFiles });
  check('dropping several files says to drop one', await until(`document.body.innerText.includes('Drop one file at a time.')`));

  // Whoever was sent a file has no board open, and the setting that shows it is off by default.
  await evaluate(`(() => { const k = 'warpaint-viewer:settings'; const v = JSON.parse(localStorage.getItem(k)); v.state.showcaseBoard = false; localStorage.setItem(k, JSON.stringify(v)); })()`);
  await send('Page.reload');
  await sleep(1500);
  await evaluate(`(async () => { const start = performance.now(); while ((document.readyState !== 'complete' || !document.querySelector('[data-slot="catalog-row"]')) && performance.now() - start < 30000) await new Promise((r) => setTimeout(r, 100)); await new Promise((r) => setTimeout(r, 1000)); })()`);
  check('the board is off to begin with', await evaluate(`!document.querySelector('[data-slot="slots"]') && !document.querySelector('[aria-label="Open showcase board"]')`));
  const pageAddress = await evaluate(`location.href`);
  const dropOnViewer = async (data) => {
    await send('Input.dispatchDragEvent', { type: 'dragEnter', x: stage.x, y: stage.y, data });
    await send('Input.dispatchDragEvent', { type: 'dragOver', x: stage.x, y: stage.y, data });
    await sleep(150);
    const hint = await evaluate(`!!document.querySelector('[data-slot="viewer-drop-hint"]')`);
    await send('Input.dispatchDragEvent', { type: 'drop', x: stage.x, y: stage.y, data });
    return hint;
  };
  check('dragging a file over the viewer says what it takes', await dropOnViewer({ items: [], files: [join(FIXTURES, 'logo.png')], dragOperationsMask: 1 }));
  check('any other file gets an answer and does not leave the page', await until(`document.body.innerText.includes('file can be dropped here')`) && await evaluate(`location.href`) === pageAddress);
  await dropOnViewer(twoFiles);
  check('several files on the viewer get an answer', await until(`document.body.innerText.includes('file at a time')`) && await evaluate(`location.href`) === pageAddress);
  const shoutedPath = join(FIXTURES, 'SHOUTED.PEGBOARD');
  writeFileSync(shoutedPath, readFileSync(exportedPath));
  await dropOnViewer({ items: [], files: [shoutedPath], dragOperationsMask: 1 });
  await evaluate(`(async () => { const start = performance.now(); while (!document.querySelector('[data-slot="slots"]') && performance.now() - start < 30000) await new Promise((r) => setTimeout(r, 100)); })()`);
  await evaluate(HELPERS);
  await evaluate(`t.startPump()`);
  check('a file dropped on the viewer opens the board with it', await until(`(t.status() ?? '').includes('Opened "Bee board"')`, 30000), await evaluate(`t.status()`));
  check('and the setting stays on', await evaluate(`JSON.parse(localStorage.getItem('warpaint-viewer:settings')).state.showcaseBoard === true`));
  await evaluate(`t.settle()`);

  // Replaced textures: the bug from the report, through the real Files panel.
  await evaluate(`(async () => { t.btn('Clear board').click(); const start = performance.now(); while (t.saved() && performance.now() - start < 8000) await t.sleep(50); })()`);
  await send('Page.navigate', { url: `http://localhost:${APP_PORT}/?kit=297&weapon=c_scattergun` });
  await sleep(1500);
  await openBoard();
  await evaluate(`(async () => { await window.__showcase.addAt('c_scattergun', { kitId: 297, kitName: 'Necromanced', team: 'red', wearIndex: 0, seed: '0' }, 0, 0); window.__showcase.select(null); await t.settle(); await window.__showcase.whenPainted(); })()`);
  const stockColors = await evaluate(`t.colors()`);
  await evaluate(`(async () => { const start = performance.now(); while (!t.saved() && performance.now() - start < 8000) await t.sleep(50); })()`);
  await click('[aria-label="Close showcase board"]');
  await sleep(500);
  await evaluate(`(async () => { const b = document.querySelector('[aria-label="Open custom warpaint files"]'); if (b) b.click(); const start = performance.now(); while (!document.querySelector('input[aria-label^="Import a texture for"]') && performance.now() - start < 30000) await new Promise((r) => setTimeout(r, 100)); })()`);
  const labels = await evaluate(`[...document.querySelectorAll('input[aria-label^="Import a texture for"]')].map((i) => i.getAttribute('aria-label'))`);
  console.log('     texture slots:', labels.slice(0, 6).join(' | '));
  const targets = labels.filter((label) => /albedo|paper|metal base|metal_base/i.test(label));
  for (const label of targets) {
    const { result } = await send('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(`input[aria-label="${label}"]`)})` });
    await send('DOM.setFileInputFiles', { objectId: result.objectId, files: [join(FIXTURES, 'magenta.png')] });
    await sleep(700);
  }
  await sleep(1500);
  const replacements = await evaluate(`document.body.innerText.match(/\\d+ replacements?/)?.[0] ?? null`);
  check('the Files panel took the replacements', !!replacements, String(targets.length));
  console.log('     ', replacements);
  await shot('14-viewer-with-replacement');
  await evaluate(`(async () => { document.querySelector('[aria-label="Open showcase board"]').click(); const start = performance.now(); while ((!document.querySelector('[data-slot="slots"]') || !window.__showcase.getSnapshot().items.length) && performance.now() - start < 30000) await new Promise((r) => setTimeout(r, 100)); await new Promise((r) => setTimeout(r, 400)); await window.__showcase.whenPainted(); })()`);
  await evaluate(HELPERS);
  const replacedColors = await evaluate(`t.colors()`);
  console.log('     colors stock', JSON.stringify(stockColors), 'replaced', JSON.stringify(replacedColors));
  const magentaOf = ({ r, g, b }) => (r + b) / 2 - g;
  check('a replaced texture shows on the board', magentaOf(replacedColors) > magentaOf(stockColors) + 8, `${magentaOf(stockColors).toFixed(1)} to ${magentaOf(replacedColors).toFixed(1)}`);
  await sleep(300);
  await shot('15-board-with-replacement');
  await click(`([...document.querySelectorAll('[data-slot="slot-share"] button')].find((b) => b.textContent.includes('Share File')))`);
  check('sharing a board with replaced textures says they stay behind', await until(`t.q('[data-kind="warning"]')?.textContent.includes('Replaced textures are not included')`), await evaluate(`t.status()`));
  await panelShot('16-shared-with-replacement');
  await openMenu(3);
  await click(`(t.menuItem('Replace with Current Board'))`);
  check('saving a board with replaced textures says they are not part of it', await until(`(t.status() ?? '').includes('Replaced textures are not kept')`), await evaluate(`t.status()`));

  const realErrors = pageErrors.filter((entry) => !/Failed to load resource/.test(entry));
  check('no page errors', realErrors.length === 0, realErrors.join(' | '));
} catch (cause) {
  failures += 1;
  console.log('ABORTED', cause);
  console.log('page errors:', pageErrors);
  await shot('aborted').catch(() => undefined);
} finally {
  clearTimeout(watchdog);
  ws.close();
  stopAll();
  await sleep(800);
  for (const dir of [profile, DOWNLOADS]) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* Edge may hold it for a moment */ } }
}
console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
console.log(`shots: ${existsSync(REVIEW) ? readdirSync(REVIEW).filter((n) => statSync(join(REVIEW, n)).isFile()).length : 0}`);
process.exit(failures ? 1 : 0);

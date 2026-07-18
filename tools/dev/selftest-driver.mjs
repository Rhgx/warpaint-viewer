// Raw CDP driver for the selftest page. Avoids Playwright/CDP clients that
// enable event domains (they OOM this app); uses Node's built-in WebSocket
// and only Runtime.evaluate / Page.captureScreenshot over the browser-level
// endpoint, polling document.title instead of listening for events.
// Usage: start the dev server, launch `msedge --headless=new --remote-debugging-port=9334`
// pointed at http://localhost:5173/?selftest=1, then run this script with node.
const PORT = 9334;

async function getTargets() {
  const res = await fetch(`http://localhost:${PORT}/json/list`);
  return res.json();
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.addEventListener('open', () => resolve(ws));
    ws.addEventListener('error', (e) => reject(e));
  });
}

let msgId = 1;
function send(ws, method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = msgId++;
    const listener = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id === id) {
        ws.removeEventListener('message', listener);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    };
    ws.addEventListener('message', listener);
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    ws.send(JSON.stringify(payload));
  });
}

async function main() {
  const targets = await getTargets();
  // The profile has forced-installed extensions that open their own tabs
  // (VeePN, AdGuard, etc.) - pick the target that is actually our app.
  const page = targets.find((t) => t.type === 'page' && t.url.includes('localhost:5173'));
  if (!page) throw new Error('no page target found');
  console.log('page target:', page.url);
  const ws = await connect(page.webSocketDebuggerUrl);

  // Poll document.title until it becomes SELFTEST PASS/FAIL, or timeout.
  const deadline = Date.now() + 30000;
  let title = '';
  while (Date.now() < deadline) {
    const r = await send(ws, 'Runtime.evaluate', { expression: 'document.title', returnByValue: true });
    title = r.result.value;
    if (title === 'SELFTEST PASS' || title === 'SELFTEST FAIL') break;
    await new Promise((res) => setTimeout(res, 500));
  }
  console.log('final title:', title);

  // Dump the results table as JSON for inspection.
  const dump = await send(ws, 'Runtime.evaluate', {
    expression: `
      Array.from(document.querySelectorAll('.selftest-table tbody tr')).map(tr => {
        const tds = tr.querySelectorAll('td');
        return {
          name: tds[0]?.textContent,
          result: tds[1]?.textContent,
          got: tds[2]?.textContent,
          expected: tds[3]?.textContent,
        };
      })
    `,
    returnByValue: true,
  });
  console.log(JSON.stringify(dump.result.value, null, 2));

  ws.close();
}

main().catch((err) => {
  console.error('driver failed:', err);
  process.exit(1);
});

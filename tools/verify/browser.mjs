// Cross-platform Chromium/Edge discovery and process cleanup for headless verification scripts.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

function which(command) {
  const tool = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(tool, [command], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  if (result.status !== 0) return null;
  const line = result.stdout.split(/\r?\n/).find((entry) => entry.trim().length > 0);
  return line ? line.trim() : null;
}

/** Resolves a Chromium-based browser binary via BROWSER_PATH or platform defaults. */
export function findBrowser() {
  const override = process.env.BROWSER_PATH?.trim();
  if (override) {
    if (existsSync(override)) return override;
    const found = which(override);
    if (found) return found;
    throw new Error(`BROWSER_PATH points to a missing browser executable: ${override}`);
  }

  const candidates = [];
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA ?? '';
    candidates.push(
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
      ...(localAppData ? [join(localAppData, 'Google/Chrome/Application/chrome.exe')] : []),
    );
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    );
  } else {
    for (const command of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'microsoft-edge-stable']) {
      const found = which(command);
      if (found) return found;
    }
    candidates.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/microsoft-edge',
    );
  }

  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  throw new Error('No Chromium, Chrome, or Edge browser found. Set BROWSER_PATH to the browser executable.');
}

/** WebGL-capable GPU/SwiftShader flags appropriate for the current platform and environment. */
export function browserGpuFlags() {
  if (process.platform === 'win32') {
    return ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'];
  }
  if (process.platform === 'darwin') {
    return ['--enable-gpu', '--ignore-gpu-blocklist'];
  }
  // Headless Linux / CI runners rarely expose a hardware GPU; SwiftShader provides WebGL 2.
  return [
    '--enable-webgl',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--no-sandbox',
    '--disable-dev-shm-usage',
  ];
}

/** Spawns a child process in its own process group on POSIX so teardown cleans up grandchildren. */
export function spawnManaged(command, args, options = {}) {
  return spawn(command, args, {
    stdio: 'ignore',
    detached: process.platform !== 'win32',
    ...options,
  });
}

/** Terminates a process and its descendants cross-platform. */
export function stopProcessTree(child) {
  if (!child || child.pid == null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    try {
      child.kill('SIGTERM');
    } catch {
      // Already exited.
    }
  }
}

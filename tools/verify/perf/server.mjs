// A static server that behaves like production: HTTP/2, gzip, the same cache headers, and textures on a
// second origin. GitHub Pages serves the app and Cloudflare Pages the textures (src/data/loader.ts).
import { execFileSync } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createSecureServer } from 'node:http2';
import { extname, join, normalize, resolve } from 'node:path';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';

const gzipAsync = promisify(gzip);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.glb': 'model/gltf-binary',
  '.bin': 'application/octet-stream',
};
// What GitHub Pages compresses. Images and fonts are already compressed.
const COMPRESSED = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.glb', '.bin']);

const OPENSSL_CANDIDATES = ['openssl', 'C:/Program Files/Git/usr/bin/openssl.exe'];

function certificate(dir) {
  mkdirSync(dir, { recursive: true });
  const keyPath = join(dir, 'localhost.key');
  const certPath = join(dir, 'localhost.crt');
  if (!existsSync(certPath)) {
    let made = false;
    for (const openssl of OPENSSL_CANDIDATES) {
      try {
        execFileSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '365', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { stdio: 'ignore' });
        made = true;
        break;
      } catch {
        // Try the next candidate; a machine without any is reported below.
      }
    }
    if (!made) throw new Error('openssl is needed once, to make the local certificate that HTTP/2 requires');
  }
  const key = readFileSync(keyPath);
  const cert = readFileSync(certPath);
  // Trusting the certificate by its key keeps the browser's HTTP cache on, which a certificate error turns off.
  const spki = new X509Certificate(cert).publicKey.export({ type: 'spki', format: 'der' });
  return { key, cert, spkiHash: createHash('sha256').update(spki).digest('base64') };
}

function listen(server, port) {
  return new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(port, 'localhost', () => {
      server.off('error', fail);
      done();
    });
  });
}

/**
 * Serves the build at /warpaint-viewer/ with public/ behind it, and public/data/textures from the texture origin.
 * The build leaves out public/ so that a new build takes seconds instead of copying 1.2 GB.
 */
export async function startSite({ siteDir, publicDir, appPort, texturePort, certDir }) {
  const { key, cert, spkiHash } = certificate(certDir);
  const gzipped = new Map();

  const respond = async (req, res, roots, cacheControl) => {
    const path = decodeURIComponent(new URL(req.url, 'https://localhost').pathname);
    let file = null;
    let info = null;
    for (const root of roots) {
      const candidate = join(root, normalize(path));
      if (!resolve(candidate).startsWith(resolve(root))) continue;
      try {
        const found = await stat(candidate);
        if (found.isFile()) {
          file = candidate;
          info = found;
          break;
        }
      } catch {
        // Not under this root.
      }
    }
    const headers = {
      'access-control-allow-origin': '*',
      'timing-allow-origin': '*',
      'cache-control': cacheControl,
    };
    if (!file) {
      res.writeHead(404, headers);
      res.end();
      return;
    }
    const extension = extname(file).toLowerCase();
    const etag = `"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
    headers.etag = etag;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    headers['content-type'] = TYPES[extension] ?? 'application/octet-stream';
    let body;
    if (COMPRESSED.has(extension) && String(req.headers['accept-encoding'] ?? '').includes('gzip')) {
      const cacheKey = `${file}|${etag}`;
      body = gzipped.get(cacheKey);
      if (!body) {
        body = await gzipAsync(await readFile(file));
        gzipped.set(cacheKey, body);
      }
      headers['content-encoding'] = 'gzip';
      headers.vary = 'Accept-Encoding';
    } else {
      body = await readFile(file);
    }
    headers['content-length'] = body.length;
    res.writeHead(200, headers);
    res.end(body);
  };

  const failure = (res, cause) => {
    console.error('[perf server]', cause);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  };

  const app = createSecureServer({ key, cert, allowHTTP1: true }, (req, res) => {
    const url = new URL(req.url, 'https://localhost');
    if (url.pathname === '/warpaint-viewer') {
      res.writeHead(301, { location: '/warpaint-viewer/' });
      res.end();
      return;
    }
    if (url.pathname === '/warpaint-viewer/') req.url = '/warpaint-viewer/index.html';
    req.url = req.url.replace(/^\/warpaint-viewer/, '');
    respond(req, res, [siteDir(), publicDir], 'max-age=600').catch((cause) => failure(res, cause));
  });
  const textures = createSecureServer({ key, cert, allowHTTP1: true }, (req, res) => {
    req.url = `/data${req.url}`;
    respond(req, res, [publicDir], 'public, max-age=14400, must-revalidate').catch((cause) => failure(res, cause));
  });
  await listen(app, appPort);
  await listen(textures, texturePort);

  return {
    spkiHash,
    url: `https://localhost:${appPort}/warpaint-viewer/`,
    stop: () => new Promise((done) => {
      app.close();
      textures.close();
      done();
    }),
  };
}

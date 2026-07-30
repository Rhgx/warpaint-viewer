import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { MISC_VPK, TEXTURES_VPK } from '../lib/vpk.mjs';

export function computeVpkFingerprint() {
  const fingerprint = {};
  for (const sourcePath of [TEXTURES_VPK, MISC_VPK]) {
    const stat = fs.statSync(sourcePath);
    fingerprint[sourcePath] = { size: stat.size, mtimeMs: stat.mtimeMs };
  }
  return fingerprint;
}

export function vpkFingerprintMatches(previous, current) {
  if (!previous) return false;
  for (const sourcePath of Object.keys(current)) {
    const a = previous[sourcePath];
    const b = current[sourcePath];
    if (!a || a.size !== b.size || a.mtimeMs !== b.mtimeMs) return false;
  }
  return true;
}

export function loadExtractState(statePath) {
  if (!fs.existsSync(statePath)) return emptyState();
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    return {
      vpkFingerprint: parsed.vpkFingerprint || null,
      textureHashes: parsed.textureHashes || {},
      iconHashes: parsed.iconHashes || {},
    };
  } catch {
    return emptyState();
  }
}

export function saveExtractState(statePath, state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state));
}

export function sha1(buffer) {
  return crypto.createHash('sha1').update(buffer).digest('hex');
}

function emptyState() {
  return { vpkFingerprint: null, textureHashes: {}, iconHashes: {} };
}

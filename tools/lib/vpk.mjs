// Helpers around Valve's vpk.exe: list contents and extract files (vpk.exe writes relative to cwd
// and does NOT create parent directories, so callers must pre-create them).

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const TF_DIR = 'C:/Program Files (x86)/Steam/steamapps/common/Team Fortress 2';
export const VPK_EXE = `${TF_DIR}/bin/vpk.exe`;
export const TEXTURES_VPK = `${TF_DIR}/tf/tf2_textures_dir.vpk`;
export const MISC_VPK = `${TF_DIR}/tf/tf2_misc_dir.vpk`;

// List all file paths (lowercased) inside a vpk.
export function listVPK(vpkPath) {
  const out = execFileSync(VPK_EXE, ['l', vpkPath], { maxBuffer: 1 << 30, encoding: 'utf8' });
  const set = new Set();
  for (const line of out.split(/\r?\n/)) {
    const t = line.trim();
    if (t) set.add(t.replace(/\\/g, '/').toLowerCase());
  }
  return set;
}

// Extract a batch of relative paths from a vpk into cwdDir. Pre-creates parent dirs.
export function extractBatch(vpkPath, relPaths, cwdDir) {
  for (const rel of relPaths) {
    const dir = path.join(cwdDir, path.dirname(rel));
    fs.mkdirSync(dir, { recursive: true });
  }
  // vpk.exe x <vpk> <rel...> ; run in batches to avoid command-line length limits.
  const BATCH = 40;
  for (let i = 0; i < relPaths.length; i += BATCH) {
    const chunk = relPaths.slice(i, i + BATCH);
    try {
      execFileSync(VPK_EXE, ['x', vpkPath, ...chunk], { cwd: cwdDir, stdio: 'ignore' });
    } catch {
      // vpk.exe returns nonzero if any single file is missing; retry individually so the rest survive.
      for (const one of chunk) {
        try { execFileSync(VPK_EXE, ['x', vpkPath, one], { cwd: cwdDir, stdio: 'ignore' }); } catch { /* missing */ }
      }
    }
  }
}

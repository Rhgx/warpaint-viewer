// Parse Valve localization files (UTF-16 LE with BOM) into a flat token -> string map.
// These are KeyValues with a "lang" { "Tokens" { "TokenName" "Value" ... } } structure,
// but a simple pair scan is more robust against the odd characters they contain.

import fs from 'node:fs';

export function loadLocalization(filePath) {
  const buf = fs.readFileSync(filePath);
  let text;
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    text = buf.subarray(2).toString('utf16le');
  } else if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    // UTF-16 BE: swap bytes
    const swapped = Buffer.alloc(buf.length - 2);
    for (let j = 2; j + 1 < buf.length; j += 2) {
      swapped[j - 2] = buf[j + 1];
      swapped[j - 1] = buf[j];
    }
    text = swapped.toString('utf16le');
  } else {
    text = buf.toString('utf8');
  }

  const map = new Map();
  // Match "key" "value" pairs. Values may contain escaped quotes; keys are simple tokens.
  const re = /"((?:[^"\\]|\\.)*)"\s*"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const key = m[1];
    const val = m[2];
    if (key === 'lang' || key === 'Language' || key === 'Tokens') continue;
    // store case-insensitively (localization lookups are case-insensitive)
    map.set(key.toLowerCase(), val);
  }
  return map;
}

export function locLookup(map, token) {
  if (!token) return null;
  let t = token;
  if (t[0] === '#') t = t.slice(1);
  const v = map.get(t.toLowerCase());
  return v == null ? null : v;
}

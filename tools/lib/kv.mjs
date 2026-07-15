// Minimal, fast Valve KeyValues (text) parser.
// Handles quoted/unquoted tokens, nested { } blocks, // line comments, and #base (ignored).
// Duplicate keys within a block collapse into an array of values (order preserved).

export function parseKV(text) {
  let i = 0;
  const n = text.length;

  function skipWs() {
    while (i < n) {
      const c = text[i];
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { i++; continue; }
      if (c === '/' && text[i + 1] === '/') {
        while (i < n && text[i] !== '\n') i++;
        continue;
      }
      break;
    }
  }

  function readToken() {
    skipWs();
    if (i >= n) return null;
    const c = text[i];
    if (c === '{' || c === '}') { i++; return c; }
    if (c === '"') {
      i++;
      let s = '';
      while (i < n && text[i] !== '"') {
        if (text[i] === '\\' && i + 1 < n) {
          const nx = text[i + 1];
          if (nx === '"' || nx === '\\') { s += nx; i += 2; continue; }
        }
        s += text[i++];
      }
      i++; // closing quote
      return { str: s };
    }
    // unquoted token
    let s = '';
    while (i < n) {
      const ch = text[i];
      if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n' || ch === '{' || ch === '}' || ch === '"') break;
      if (ch === '/' && text[i + 1] === '/') break;
      s += ch;
      i++;
    }
    return { str: s };
  }

  function addKey(obj, key, value) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      const existing = obj[key];
      if (Array.isArray(existing)) existing.push(value);
      else obj[key] = [existing, value];
    } else {
      obj[key] = value;
    }
  }

  function parseBlock() {
    const obj = {};
    while (true) {
      const tok = readToken();
      if (tok === null) break;
      if (tok === '}') break;
      if (tok === '{') continue; // stray, skip
      // tok is a key
      let key = tok.str;
      // #base / #include directives: consume their value token and ignore
      const val = readToken();
      if (val === null) break;
      if (val === '{') {
        addKey(obj, key, parseBlock());
      } else if (val === '}') {
        // key with no value at block end
        addKey(obj, key, '');
        break;
      } else {
        if (key[0] === '#') continue; // ignore #base "file"
        addKey(obj, key, val.str);
      }
    }
    return obj;
  }

  skipWs();
  // Top level: usually a single root key then a block.
  const root = {};
  while (i < n) {
    const tok = readToken();
    if (tok === null) break;
    if (tok === '}' || tok === '{') continue;
    const key = tok.str;
    const val = readToken();
    if (val === null) { addKey(root, key, ''); break; }
    if (val === '{') addKey(root, key, parseBlock());
    else if (key[0] !== '#') addKey(root, key, val.str);
    skipWs();
  }
  return root;
}

// Case-insensitive lookup helper (KeyValues keys are case-insensitive in Source).
export function kvGet(obj, key) {
  if (obj == null || typeof obj !== 'object') return undefined;
  if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
  const lk = key.toLowerCase();
  for (const k of Object.keys(obj)) {
    if (k.toLowerCase() === lk) return obj[k];
  }
  return undefined;
}

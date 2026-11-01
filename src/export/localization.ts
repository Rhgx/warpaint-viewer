/**
 * Names a spliced war paint. The definition's loc_desctoken resolves through
 * resource/tf_proto_obj_defs_<language>.txt, a UTF-16LE KeyValues file with a BOM.
 * Without an entry the paint shows its raw token.
 *
 * The engine reads one proto_defs file and does not merge them, so a copy in
 * tf/custom/ must be complete or it blanks every other paint name. The edit is
 * textual, so the rest of Valve's file stays byte for byte.
 */

const BOM = 0xfeff;

export interface LocalizationFile {
  /** Decoded text, without the byte order mark. */
  text: string;
  /** True when the source carried a UTF-16LE BOM, as Valve's files do. */
  hadBom: boolean;
}

/**
 * Decodes a localization file. Valve ships UTF-16LE with a BOM; a community
 * file that has been through an editor may come back as UTF-8, so both are
 * accepted and the original encoding is remembered for the write side.
 */
export function decodeLocalization(bytes: Uint8Array): LocalizationFile {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), hadBom: true };
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    throw new Error('This localization file is UTF-16 big endian, which Team Fortress 2 does not read.');
  }
  return { text: new TextDecoder('utf-8').decode(bytes), hadBom: false };
}

export function encodeLocalization(file: LocalizationFile): Uint8Array {
  if (!file.hadBom) return new TextEncoder().encode(file.text);
  const units = new Uint16Array(file.text.length + 1);
  units[0] = BOM;
  for (let index = 0; index < file.text.length; index += 1) units[index + 1] = file.text.charCodeAt(index);
  return new Uint8Array(units.buffer);
}

/** The token a paint kit definition's loc_desctoken points at. */
/** @public Used by tools/verify/protodefs/protodefs-write.test.mjs. */
export function paintkitNameToken(defindex: number): string {
  return `9_${defindex}_field { field_number: 2 }`;
}

function escapeValue(value: string): string {
  // Only the quote needs escaping for a KeyValues string. Newlines would end
  // the entry, so they are folded to spaces rather than escaped.
  return value.replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ');
}

/**
 * Adds or replaces one paint kit's name. Everything else in the file stays byte for
 * byte as the game shipped it.
 */
export function setPaintkitName(file: LocalizationFile, defindex: number, name: string): LocalizationFile {
  const token = paintkitNameToken(defindex);
  const escapedToken = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const newline = file.text.includes('\r\n') ? '\r\n' : '\n';
  const entry = `"${token}"\t\t"${escapeValue(name)}"`;

  // An existing entry for this defindex wins: overwriting a kit takes over its name too.
  const existing = new RegExp(`^[ \\t]*"${escapedToken}"[ \\t]*"(?:[^"\\\\]|\\\\.)*"[ \\t]*$`, 'm');
  if (existing.test(file.text)) {
    return { ...file, text: file.text.replace(existing, entry) };
  }

  // Otherwise append inside the Tokens block, which is the second-to-last brace
  // (the last one closes "lang").
  const lastBrace = file.text.lastIndexOf('}');
  const tokensBrace = lastBrace < 0 ? -1 : file.text.lastIndexOf('}', lastBrace - 1);
  if (tokensBrace < 0) {
    throw new Error('This does not look like a localization file: it has no "Tokens" block to add a name to.');
  }
  return {
    ...file,
    text: `${file.text.slice(0, tokensBrace)}${entry}${newline}${file.text.slice(tokensBrace)}`,
  };
}

/** Where the pack has to put it for the game to read it. */
export function localizationPackPath(language: string): string {
  return `resource/tf_proto_obj_defs_${language}.txt`;
}

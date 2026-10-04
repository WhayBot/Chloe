// src/template.js — komentar ">" dan placeholder {{...}} untuk persona.md / examples.md / relationship_note

export const PLACEHOLDER_RE = /\{\{\s*([^{}]*?)\s*\}\}/g;

/** Buang baris komentar berawalan ">" (SPEC §7). */
export function stripCommentLines(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .filter((l) => !/^\s*>/.test(l))
    .join('\n');
}

/** Daftar nama placeholder yang dipakai teks. */
export function listPlaceholders(text) {
  return [...String(text ?? '').matchAll(PLACEHOLDER_RE)].map((m) => m[1]);
}

/**
 * Lempar galat kalau ada placeholder di luar `allowed`.
 * @param {string} text
 * @param {string[]} allowed
 * @param {string} source - label untuk pesan galat
 */
export function assertKnownPlaceholders(text, allowed, source) {
  const unknown = [...new Set(listPlaceholders(text).filter((p) => !allowed.includes(p)))];
  if (unknown.length) {
    throw new Error(`${source}: placeholder tidak dikenal ${unknown.map((u) => `{{${u}}}`).join(', ')} ` +
      `(yang dikenal: ${allowed.map((a) => `{{${a}}}`).join(', ')})`);
  }
}

const replaceAll = (text, key, value) =>
  text.replace(new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g'), () => value);

/**
 * Substitusi dua tahap (SPEC §7): {{relationship_note}} dulu (karena isinya memuat {{callname}}),
 * baru {{callname}} dan {{name}}. Sisa placeholder setelahnya → galat.
 * @param {string} text
 * @param {{ name: string, callname: string, relationship_note?: string }} vars
 */
export function fillPlaceholders(text, vars, source = 'template') {
  let out = replaceAll(String(text ?? ''), 'relationship_note', vars.relationship_note ?? '');
  out = replaceAll(out, 'callname', vars.callname ?? '');
  out = replaceAll(out, 'name', vars.name ?? '');
  const left = listPlaceholders(out);
  if (left.length) throw new Error(`${source}: placeholder tersisa setelah substitusi: ${left.map((l) => `{{${l}}}`).join(', ')}`);
  return out;
}

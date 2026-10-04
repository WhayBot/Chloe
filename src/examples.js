// src/examples.js — parser examples.md, pemilih contoh dialog, dan pesan sistem
import { readFileSync, statSync } from 'node:fs';
import config from '../config.js';
import { getRng } from './rng.js';
import { stripCommentLines, assertKnownPlaceholders, fillPlaceholders } from './template.js';

const ALLOWED_PLACEHOLDERS = Object.freeze(['name', 'callname']);

// situasi khusus pesan sistem (tanpa input user; tidak masuk contoh dialog)
export const SYSTEM_SITUATIONS = Object.freeze(new Set([
  'media_tidak_bisa',
  'sistem_batas_harian',
  'sistem_gagal',
  'reminder_terkirim',
]));

// situasi tidur/bangun dikecualikan sementara sampai Tahap 6-7 selesai (SPEC revisi Tahap 3)
export const TEMPORARY_EXCLUDED_SITUATIONS = Object.freeze(new Set([
  'tegur_tidur',
  'ironi_tidur',
  'baru_bangun',
  'kebangun_karena_pesan',
  'pamit_tidur',
]));

// TODO(Tahap 5): hapus pengecualian ini setelah add_reminder dan save_note aktif
export const TEMPORARY_EXCLUDED_UNTIL_TOOLS = Object.freeze(new Set([
  'fungsional',
  'reminder_terkirim',
  'males',
  'dongkol',
]));

/**
 * Parse satu blok contoh (di antara '---').
 * Mendukung beberapa U: beruntun, beberapa A: beruntun, dan contoh tanpa U:.
 * @param {string} block
 * @returns {{ lines: Array<{ role: 'U'|'A', text: string }>, assistantTexts: string[], text: string } | null}
 */
export function parseExampleBlock(block) {
  const clean = stripCommentLines(block).trim();
  if (!clean) return null;

  const lines = [];
  const assistantTexts = [];
  let currentRole = null;
  let currentBuf = [];

  function flush() {
    if (currentRole && currentBuf.length) {
      const text = currentBuf.join('\n').trim();
      if (text) {
        lines.push({ role: currentRole, text });
        if (currentRole === 'A') assistantTexts.push(text);
      }
    }
    currentBuf = [];
  }

  for (const rawLine of clean.split(/\r?\n/)) {
    const uMatch = /^U:\s*(.*)$/.exec(rawLine);
    const aMatch = /^A:\s*(.*)$/.exec(rawLine);
    if (uMatch) {
      flush();
      currentRole = 'U';
      currentBuf.push(uMatch[1]);
    } else if (aMatch) {
      flush();
      currentRole = 'A';
      currentBuf.push(aMatch[1]);
    } else if (currentRole) {
      // baris lanjutan multi-baris
      currentBuf.push(rawLine);
    }
  }
  flush();

  if (!lines.length || !assistantTexts.length) return null;
  return { lines, assistantTexts, text: clean };
}

/**
 * Parse seluruh isi examples.md.
 * Mengabaikan bagian "## jangan begini".
 * @param {string} rawText
 * @param {string} [source='examples.md']
 * @returns {Map<string, Array<{ lines: Array<{ role: 'U'|'A', text: string }>, assistantTexts: string[], text: string }>>}
 */
export function parseExamples(rawText, source = 'examples.md') {
  // buang bagian "## jangan begini" dan seterusnya
  const mainPart = String(rawText ?? '').split(/(?:^|\n)##\s*jangan\s+begini\b/i)[0];
  assertKnownPlaceholders(mainPart, ALLOWED_PLACEHOLDERS, source);

  const clean = stripCommentLines(mainPart);
  const sections = clean.split(/(?:^|\n)##\s*situasi:\s*/);
  const bySituation = new Map();

  for (const sec of sections) {
    if (!sec.trim()) continue;
    const nlIdx = sec.indexOf('\n');
    const situationName = (nlIdx >= 0 ? sec.slice(0, nlIdx) : sec).trim();
    const body = nlIdx >= 0 ? sec.slice(nlIdx + 1) : '';
    if (!situationName) continue;

    const rawBlocks = body.split(/(?:^|\n)\s*---\s*(?:\n|$)/);
    const parsedBlocks = [];
    for (const b of rawBlocks) {
      const p = parseExampleBlock(b);
      if (p) parsedBlocks.push(p);
    }
    if (parsedBlocks.length) {
      bySituation.set(situationName, parsedBlocks);
    }
  }

  return bySituation;
}

// --- cache & auto-reload jika file berubah (mtimeMs) ---
let cachedPath = null;
let cachedMtime = -1;
let cachedMap = null;

export function loadExamples(filePath = config.EXAMPLES_FILE) {
  try {
    const st = statSync(filePath);
    if (cachedPath === filePath && cachedMtime === st.mtimeMs && cachedMap) {
      return cachedMap;
    }
    const content = readFileSync(filePath, 'utf8');
    cachedMap = parseExamples(content, filePath);
    cachedPath = filePath;
    cachedMtime = st.mtimeMs;
    return cachedMap;
  } catch (e) {
    if (cachedMap && cachedPath === filePath) return cachedMap;
    throw e;
  }
}

/** Khusus tes: setel contoh langsung ke memori cache */
export function _setCachedExamples(map) {
  cachedMap = map;
  cachedMtime = Date.now();
}

/**
 * Ambil balasan pesan sistem acak (media_tidak_bisa, sistem_batas_harian, sistem_gagal).
 * Memilih satu contoh dan mengembalikan array pesan balasan assistant dengan placeholder terisi.
 * @param {string} situation
 * @param {{ name?: string, callname?: string, rng?: object, examplesMap?: Map }} [opts]
 * @returns {string[]}
 */
export function getSystemReply(situation, opts = {}) {
  const map = opts.examplesMap ?? loadExamples();
  const list = map.get(situation) ?? [];
  if (!list.length) return ['(pesan sistem)'];
  const rng = opts.rng ?? getRng();
  const item = list[rng.int(0, list.length - 1)];
  const name = opts.name ?? config.CHARACTER_NAME;
  const callname = opts.callname ?? 'kamu';
  return item.assistantTexts.map((t) => fillPlaceholders(t, { name, callname }, `examples.md [${situation}]`));
}

/**
 * Pilih 3-5 contoh dialog acak dari situasi non-sistem.
 * @param {object} p
 * @param {string} [p.name]
 * @param {string} [p.callname]
 * @param {string} [p.mood] - stub untuk relevansi mood (diperluas Tahap 7)
 * @param {string} [p.phase] - stub untuk relevansi fase
 * @param {object} [p.rng]
 * @param {Map} [p.examplesMap]
 * @param {number} [p.min]
 * @param {number} [p.max]
 * @returns {{ text: string, count: number }}
 */
export function selectDialogExamples({
  name = config.CHARACTER_NAME,
  callname = 'kamu',
  mood = null,
  phase = null,
  rng = getRng(),
  examplesMap = null,
  min = config.EXAMPLES_MIN,
  max = config.EXAMPLES_MAX,
} = {}) {
  const map = examplesMap ?? loadExamples();

  // kumpulkan semua contoh dialog yang bukan situasi sistem dan bukan situasi tidur sementara
  const candidates = [];
  for (const [sit, items] of map.entries()) {
    if (
      SYSTEM_SITUATIONS.has(sit) ||
      TEMPORARY_EXCLUDED_SITUATIONS.has(sit) ||
      TEMPORARY_EXCLUDED_UNTIL_TOOLS.has(sit)
    ) continue;
    for (const it of items) {
      candidates.push({ situation: sit, item: it });
    }
  }

  if (!candidates.length) return { text: '', count: 0 };

  const targetCount = Math.min(candidates.length, rng.int(min, max));

  // stub pemilihan situasi: utamakan kandidat yang cocok dengan mood / fase kalau ada
  const scored = candidates.map((c) => {
    let score = 1;
    if (mood && c.situation.includes(mood)) score += 3;
    if (phase && c.situation.includes(phase)) score += 3;
    return { ...c, score };
  });

  // shuffle dengan sedikit bobot
  const shuffled = [...scored].sort((a, b) => (b.score + rng.float()) - (a.score + rng.float()));
  const chosen = shuffled.slice(0, targetCount).map((c) => c.item);

  const formattedBlocks = chosen.map((c) => {
    const formattedLines = c.lines.map((l) => `${l.role}: ${l.text}`).join('\n');
    return fillPlaceholders(formattedLines, { name, callname }, 'examples.md');
  });

  const header = 'Contoh hanya menunjukkan nada dan ritme. Jangan menyalin kalimatnya. Buat kalimat baru.';
  const body = formattedBlocks.join('\n\n---\n\n');
  return {
    text: `${header}\n\n${body}`,
    count: chosen.length,
  };
}

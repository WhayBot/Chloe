// src/memory.js — riwayat percakapan, fakta user (save_fact), ringkasan latar belakang, dan anggaran token
import config from '../config.js';
import { log, shortJid } from './log.js';
import { formatHHMM } from './time.js';
import { buildSystemPrompt } from './prompt.js';

// kata kunci frasa sensitif yang dicocokkan sebagai substring pada teks huruf kecil
const SENSITIVE_KEYWORDS_PHRASE = [
  // kredensial & keuangan
  'password', 'kata sandi', 'pin atm', 'pin rekening',
  'nomor rekening', 'rekening bank', 'kartu kredit', 'kartu debit', 'nomor kartu',
  // kesehatan
  'diagnosa dokter', 'obat resep', 'riwayat medis', 'kondisi medis',
  'gejala sakit', 'rawat inap', 'operasi bedah', 'rekam medis', 'hasil lab',
  'terapi kejiwaan', 'psikiater', 'resep dokter', 'tes darah',
  'penyakit',
  // alamat
  'alamat rumah', 'alamat tinggal', 'alamat kantor', 'nomor rumah',
  'tempat tinggal', 'lokasi rumah', 'blok rumah', 'komplek perumahan', 'patokan rumah',
  // rahasia negara / dokumen rahasia
  'rahasia negara', 'bocoran dokumen',
];

// Kata-kata pendek yang WAJIB dicocokkan sebagai kata utuh (\b...\b), bukan potongan kata (mis. archive)
const SENSITIVE_WORDS_EXACT = [
  'hiv', 'cvv', 'pin', 'kanker', 'depresi',
];

// Pola alamat khusus:
// 1. "jl." atau "jl " diikuti kata (case-insensitive)
// 2. "jalan" + kata berhuruf kapital pada teks asli (mis. Jalan Melati / jalan Melati)
// 3. "jalan" + kata + nomor (mis. jalan sudirman 45, jalan melati no. 5)
// 4. RT/RW, kode pos, nomor blok
const SENSITIVE_PATTERNS = [
  /\bjl\.\s*[a-z0-9]+/i,
  /\bjl\s+[a-z0-9]+/i,
  /\b[Jj]alan\s+[A-Z][a-zA-Z0-9]*/,
  /\b[Jj]alan\s+(?:[a-zA-Z0-9]+\s+)?(?:no\.?\s*)?\d+/i,
  /\brt\s*\d+\s*\/\s*rw\s*\d+/i,
  /\bkode\s*pos\s*\d{5}/i,
  /\bno(?:mor)?\s*\d+\s*(?:rt|rw|blok)/i,
];

/** Cek apakah teks memuat informasi sensitif yang tidak boleh disimpan otomatis. */
export function isSensitiveFact(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return false;
  const lower = raw.toLowerCase();

  // 1. Cek frasa sensitif
  if (SENSITIVE_KEYWORDS_PHRASE.some((kw) => lower.includes(kw))) return true;

  // 2. Cek kata pendek sebagai kata utuh
  for (const w of SENSITIVE_WORDS_EXACT) {
    const re = new RegExp(`\\b${w}\\b`, 'i');
    if (re.test(lower)) return true;
  }

  // 3. Cek pola regex
  for (const pat of SENSITIVE_PATTERNS) {
    if (pat.test(raw)) return true;
  }

  return false;
}

/** Hitung kemiripan kata Jaccard antara dua kalimat. */
export function textSimilarity(a, b) {
  const words = (s) => new Set(String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w.length > 2));
  const setA = words(a);
  const setB = words(b);
  if (!setA.size || !setB.size) return 0;
  let inter = 0;
  for (const w of setA) if (setB.has(w)) inter++;
  const union = setA.size + setB.size - inter;
  return union > 0 ? inter / union : 0;
}

/**
 * Simpan fakta user dari aksi save_fact (SPEC §7).
 * - Cek informasi sensitif (ditolak)
 * - Cek kemiripan teks dengan fakta lama (jika mirip >= 0.6, fakta lama diganti)
 * - Batas maksimal fakta per user (default 100; jika penuh, fakta terlama dibuang)
 * Log hanya metadata (shortJid, panjang teks, hasil), TANPA teks fakta.
 * @returns {{ ok: boolean, reason?: string, id?: number }}
 */
export function saveFact(db, jid, factText, ts = Date.now(), cfg = config) {
  const clean = String(factText ?? '').trim().slice(0, cfg.FACT_MAX_CHARS);
  if (!clean || clean.length < 3) return { ok: false, reason: 'fakta terlalu pendek' };

  if (isSensitiveFact(clean)) {
    log('warn', 'memory', 'fakta ditolak karena memuat info sensitif', {
      jid: shortJid(jid),
      len: clean.length,
      result: 'rejected',
    });
    return { ok: false, reason: 'sensitive_data' };
  }

  const existing = db.getFactsByJid(jid);

  // cek duplikat / fakta mirip untuk diperbarui
  for (const f of existing) {
    if (textSimilarity(f.text, clean) >= cfg.FACT_SIMILARITY_REPLACE) {
      db.deleteFact(f.id);
      db.insertFact(jid, clean, ts);
      log('info', 'memory', 'fakta lama diganti dengan versi baru', {
        jid: shortJid(jid),
        len: clean.length,
        result: 'replaced',
      });
      return { ok: true, reason: 'replaced' };
    }
  }

  // batas maksimal per user
  if (existing.length >= cfg.FACTS_MAX_PER_USER) {
    const oldest = existing[existing.length - 1];
    db.deleteFact(oldest.id);
  }

  db.insertFact(jid, clean, ts);
  log('info', 'memory', 'fakta baru disimpan', {
    jid: shortJid(jid),
    len: clean.length,
    result: 'inserted',
  });
  return { ok: true, reason: 'inserted' };
}

/** Ambil daftar fakta terbaru untuk dimasukkan ke system prompt. */
export function getFactsForPrompt(db, jid, limit = config.FACTS_IN_PROMPT) {
  const rows = db.getFactsByJid(jid);
  return rows.slice(0, limit).map((r) => r.text);
}

/** Ambil ringkasan lama untuk JID. */
export function getSummaryForPrompt(db, jid) {
  return db.getSummary(jid)?.text ?? '';
}

// State internal ringkasan latar belakang
const activeSummaries = new Set();
const summaryFailedCooldown = new Map(); // jid -> timestamp

/** Reset state ringkasan (khusus pengujian). */
export function _resetSummaryState() {
  activeSummaries.clear();
  summaryFailedCooldown.clear();
}

/**
 * Pemicu pembuatan ringkasan di latar belakang jika pesan belum diringkas > SUMMARY_TRIGGER_MSGS (40).
 * Mengambil 20 pesan tertua (SUMMARY_BATCH_MSGS).
 * Tidak memblokir alur balasan WhatsApp.
 * Menghormati anggaran model harian dan cadangan minimum (SUMMARY_MIN_BUDGET_RESERVE).
 * Menjaga concurrency per JID dan cooldown setelah gagal (SUMMARY_RETRY_COOLDOWN_MS).
 * @param {object} p
 * @param {object} p.db
 * @param {string} p.jid
 * @param {Function} p.callModelFn
 * @param {object} [p.budget]
 * @param {number} [p.now]
 * @param {object} [p.cfg]
 * @returns {Promise<{ triggered: boolean, count?: number, error?: string, reason?: string, summary?: string }>}
 */
export async function triggerBackgroundSummarize({
  db,
  jid,
  callModelFn,
  budget = null,
  now = Date.now(),
  cfg = config,
}) {
  // (a) Penjaga per JID supaya tidak ada dua ringkasan berjalan bersamaan
  if (activeSummaries.has(jid)) {
    return { triggered: false, reason: 'already_running' };
  }

  // (b) Jeda ulang setelah gagal (SUMMARY_RETRY_COOLDOWN_MS default 1800000)
  const cooldownMs = process.env.SUMMARY_RETRY_COOLDOWN_MS
    ? Number(process.env.SUMMARY_RETRY_COOLDOWN_MS)
    : (cfg.SUMMARY_RETRY_COOLDOWN_MS ?? 1800000);
  const lastFailed = summaryFailedCooldown.get(jid);
  if (lastFailed && (now - lastFailed) < cooldownMs) {
    return { triggered: false, reason: 'cooldown' };
  }

  // (d) SUMMARY_TRIGGER_MSGS dan SUMMARY_BATCH_MSGS bisa dioverride lewat .env
  const triggerMsgs = process.env.SUMMARY_TRIGGER_MSGS
    ? Number(process.env.SUMMARY_TRIGGER_MSGS)
    : (cfg.SUMMARY_TRIGGER_MSGS ?? cfg.SUMMARY_THRESHOLD ?? 40);
  const batchMsgs = process.env.SUMMARY_BATCH_MSGS
    ? Number(process.env.SUMMARY_BATCH_MSGS)
    : (cfg.SUMMARY_BATCH_MSGS ?? cfg.SUMMARY_BATCH ?? 20);

  const existingSummary = db.getSummary(jid);
  const uptoId = existingSummary?.upto_msg_id ?? 0;
  const unsummarizedCount = db.countMessagesAfterId(jid, uptoId);

  if (unsummarizedCount < triggerMsgs) {
    return { triggered: false, reason: 'below_threshold', count: unsummarizedCount };
  }

  // (c) Ringkasan hanya dijalankan kalau sisa anggaran harian >= SUMMARY_MIN_BUDGET_RESERVE (default 10)
  if (budget) {
    const minReserve = process.env.SUMMARY_MIN_BUDGET_RESERVE
      ? Number(process.env.SUMMARY_MIN_BUDGET_RESERVE)
      : (cfg.SUMMARY_MIN_BUDGET_RESERVE ?? 10);
    const rem = typeof budget.remaining === 'function' ? budget.remaining() : null;
    if (rem != null && rem < minReserve) {
      return { triggered: false, reason: 'budget_exhausted' };
    }
    if (typeof budget.isExhausted === 'function' && budget.isExhausted()) {
      return { triggered: false, reason: 'budget_exhausted' };
    }
  }

  const batch = db.getMessagesAfterId(jid, uptoId, batchMsgs);
  if (!batch || !batch.length) {
    return { triggered: false, reason: 'no_messages' };
  }

  const lastMsg = batch[batch.length - 1];

  activeSummaries.add(jid);
  try {
    const name = cfg.CHARACTER_NAME ?? 'Chloe';
    const transcript = batch.map((m) => `${m.dir === 'in' ? 'User' : name}: ${m.text}`).join('\n');
    const prevText = existingSummary?.text ? `Ringkasan sebelumnya:\n${existingSummary.text}\n\n` : '';
    const messages = [
      {
        role: 'system',
        content: `Kamu adalah asisten pencatat ringkasan percakapan untuk ${name}. Buat ringkasan padat fakta, topik, dan dinamika percakapan dalam 1-3 paragraf teks biasa tanpa format JSON.`
      },
      {
        role: 'user',
        content: `${prevText}Percakapan baru untuk diringkas:\n${transcript}\n\nBuat ringkasan padat:`
      }
    ];

    const res = await callModelFn(messages);
    const content = typeof res === 'string'
      ? res
      : (res?.content ?? (Array.isArray(res?.messages) ? res.messages.join(' ') : ''));
    const summaryText = String(content ?? '').trim();
    if (!summaryText) {
      throw new Error('ringkasan kosong dari model');
    }

    db.upsertSummary(jid, summaryText, lastMsg.id, now);
    if (budget && typeof budget.record === 'function') {
      budget.record();
    }
    summaryFailedCooldown.delete(jid);
    log('info', 'memory', 'ringkasan berhasil diperbarui', {
      jid: shortJid(jid),
      count: batch.length,
      uptoId: lastMsg.id,
    });
    return { triggered: true, count: batch.length, summary: summaryText };
  } catch (e) {
    summaryFailedCooldown.set(jid, now);
    log('warn', 'memory', `pembuatan ringkasan gagal: ${e.message}`, { jid: shortJid(jid) });
    return { triggered: false, reason: 'error', error: e.message };
  } finally {
    activeSummaries.delete(jid);
  }
}

/** Perkiraan jumlah token: 2 token per kata (SPEC Tahap 3 revisi). */
export function estimateTokens(text, tokensPerWord = config.TOKENS_PER_WORD ?? 2) {
  const str = String(text ?? '').trim();
  if (!str) return 0;
  const words = str.split(/\s+/).filter(Boolean).length;
  return words * tokensPerWord;
}

/**
 * Format riwayat pesan untuk dikirim ke chat completions model.
 * Mengambil pesan terakhir sebelum `beforeId` jika diberikan, disusun kronologis (ASC).
 */
export function formatRecentHistory(db, jid, limit = config.HISTORY_LIMIT, beforeId = null) {
  const recent = (beforeId != null && typeof db.getRecentBeforeId === 'function')
    ? db.getRecentBeforeId(jid, beforeId, limit)
    : db.getRecentMessagesByJid(jid, limit);
  // getRecentMessagesByJid / getRecentBeforeId mengembalikan DESC (terbaru dulu) → balik jadi ASC
  const chronological = [...recent].reverse();

  const formatted = [];
  for (const m of chronological) {
    if (!m.text) continue;
    const timeTag = m.ts ? `[${formatHHMM(m.ts)}] ` : '';
    const content = m.dir === 'in' ? `${timeTag}${m.text}` : m.text;
    formatted.push({
      role: m.dir === 'in' ? 'user' : 'assistant',
      content,
      id: m.id,
    });
  }
  return formatted;
}

/**
 * Rakit seluruh array pesan yang siap dikirim ke OpenRouter:
 * [ { role: 'system', content }, ...history, { role: 'user', content: newMsg } ]
 *
 * Menerapkan batas anggaran token (PROMPT_TOKEN_BUDGET):
 * Pemangkasan bertahap HANYA memotong:
 * 1. Riwayat terlama dipangkas dulu (minimal 10 pesan dipertahankan).
 * 2. Contoh dialog dikurangi (dari 5 ke bawah, minimal 3 contoh).
 * 3. Fakta terlama dikurangi (boleh sampai 0).
 * 4. Bagian Persona, KONDISI SAAT INI, dan Aturan output TIDAK PERNAH dipotong.
 * 5. Jika bagian inti saja melebihi anggaran, jangan potong persona; catat log peringatan.
 */
export function assemblePromptMessages({
  db,
  user,
  incomingText,
  incomingTs = Date.now(),
  beforeMessageId = null,
  now = Date.now(),
  cfg = config,
  rng,
  deps = {},
}) {
  const jid = user.jid;
  let facts = getFactsForPrompt(db, jid, cfg.FACTS_IN_PROMPT);
  const summary = getSummaryForPrompt(db, jid);
  let history = formatRecentHistory(db, jid, cfg.HISTORY_LIMIT, beforeMessageId);

  // Pastikan pesan yang baru disimpan tidak ganda jika beforeMessageId tidak dilewatkan
  if (beforeMessageId == null && history.length > 0) {
    const last = history[history.length - 1];
    if (last.role === 'user' && (last.content === incomingText || last.content.endsWith(incomingText))) {
      history.pop();
    }
  }

  const timePrefix = incomingTs ? `[${formatHHMM(incomingTs)}] ` : '';
  const newMsg = { role: 'user', content: `${timePrefix}${incomingText}` };

  // Biarkan buildSystemPrompt memilih acak 3-5 contoh di awal (jangan paksakan 5)
  let currentExamplesCount = null;
  let systemPrompt = buildSystemPrompt({
    user,
    facts,
    summary,
    now,
    cfg,
    rng,
    deps,
    exampleCount: currentExamplesCount,
  });

  const budget = cfg.PROMPT_TOKEN_BUDGET ?? 10000;

  const calcTotalTokens = (sys, hist, next) => {
    let tok = estimateTokens(sys, cfg.TOKENS_PER_WORD) + estimateTokens(next.content, cfg.TOKENS_PER_WORD);
    for (const h of hist) tok += estimateTokens(h.content, cfg.TOKENS_PER_WORD);
    return tok;
  };

  // 1. Pangkas riwayat terlama jika melebihi anggaran token (minimal 10 pesan dipertahankan)
  const minHistory = cfg.HISTORY_MIN_KEEP ?? 10;
  while (history.length > minHistory && calcTotalTokens(systemPrompt, history, newMsg) > budget) {
    history.shift();
  }

  // 2. Jika masih melebihi, kurangi contoh dialog (minimal 3 contoh dipertahankan)
  const minExamples = cfg.EXAMPLES_MIN ?? 3;
  let targetExamples = (cfg.EXAMPLES_MAX ?? 5) - 1;
  while (targetExamples >= minExamples && calcTotalTokens(systemPrompt, history, newMsg) > budget) {
    currentExamplesCount = targetExamples;
    systemPrompt = buildSystemPrompt({
      user,
      facts,
      summary,
      now,
      cfg,
      rng,
      deps,
      exampleCount: currentExamplesCount,
    });
    targetExamples--;
  }

  // 3. Jika masih melebihi, kurangi fakta terlama (boleh sampai 0)
  while (facts.length > 0 && calcTotalTokens(systemPrompt, history, newMsg) > budget) {
    facts.pop();
    systemPrompt = buildSystemPrompt({
      user,
      facts,
      summary,
      now,
      cfg,
      rng,
      deps,
      exampleCount: currentExamplesCount,
    });
  }

  // 4. Verifikasi apakah bagian inti prompt (persona + kondisi saat ini + aturan output) melebihi anggaran
  // Persona, KONDISI SAAT INI, dan aturan output tidak boleh dipotong sama sekali.
  const essentialPrompt = buildSystemPrompt({
    user,
    facts: [],
    summary: '',
    now,
    cfg,
    rng,
    deps,
    skipExamples: true,
  });
  if (estimateTokens(essentialPrompt, cfg.TOKENS_PER_WORD) > budget) {
    log('warn', 'memory', 'bagian inti prompt (persona + kondisi + aturan) melebihi anggaran token', {
      estimatedTokens: estimateTokens(essentialPrompt, cfg.TOKENS_PER_WORD),
      budget,
    });
  }

  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.map(({ role, content }) => ({ role, content })),
    newMsg,
  ];

function countExamplesInPrompt(systemPrompt) {
  const idx = systemPrompt.indexOf('## Contoh dialog');
  if (idx === -1) return 0;
  const after = systemPrompt.slice(idx);
  const nextSectionIdx = after.indexOf('\n## ', 3);
  const sectionText = nextSectionIdx === -1 ? after : after.slice(0, nextSectionIdx);
  if (sectionText.includes('(tidak ada contoh)')) return 0;
  const blocks = sectionText.split(/\n\s*---\s*\n/);
  return blocks.length;
}

  return {
    messages,
    systemPrompt,
    historyCount: history.length,
    factsCount: facts.length,
    exampleCount: currentExamplesCount ?? countExamplesInPrompt(systemPrompt),
  };
}

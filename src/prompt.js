// src/prompt.js — rakit system prompt sesuai SPEC §7
import { readFileSync, statSync } from 'node:fs';
import config from '../config.js';
import { getNow, formatWibLong } from './time.js';
import { getPhase, getAwareness, getEnergy, getSleepPlan, getActivity, awarenessInstruction } from './life.js';
import { getMood, getNagLevel, VALID_MOODS } from './mood.js';
import { stripCommentLines, assertKnownPlaceholders, fillPlaceholders } from './template.js';
import { loadExamples, selectDialogExamples } from './examples.js';

const PERSONA_ALLOWED_PLACEHOLDERS = Object.freeze(['name', 'callname', 'relationship_note']);

// --- cache & auto-reload persona.md jika mtime berubah ---
let cachedPersonaPath = null;
let cachedPersonaMtime = -1;
let cachedPersonaRaw = null;

export function loadPersona(filePath = config.PERSONA_FILE) {
  try {
    const st = statSync(filePath);
    if (cachedPersonaPath === filePath && cachedPersonaMtime === st.mtimeMs && cachedPersonaRaw != null) {
      return cachedPersonaRaw;
    }
    const content = readFileSync(filePath, 'utf8');
    assertKnownPlaceholders(content, PERSONA_ALLOWED_PLACEHOLDERS, filePath);
    cachedPersonaRaw = content;
    cachedPersonaPath = filePath;
    cachedPersonaMtime = st.mtimeMs;
    return cachedPersonaRaw;
  } catch (e) {
    if (cachedPersonaRaw != null && cachedPersonaPath === filePath) return cachedPersonaRaw;
    throw e;
  }
}

/** Khusus tes: setel persona langsung ke memori */
export function _setCachedPersona(raw) {
  cachedPersonaRaw = raw;
  cachedPersonaMtime = Date.now();
}

/**
 * Validasi aset prompt saat startup (persona.md dan examples.md).
 * Melempar galat jika file tidak ada atau ada placeholder yang tidak dikenal.
 */
export function validatePromptAssets(cfg = config) {
  loadPersona(cfg.PERSONA_FILE);
  loadExamples(cfg.EXAMPLES_FILE);
}

/** Aturan output final sesuai SPEC §7 (harus menyebut 10 nama mood yang valid). */
export function formatOutputRules() {
  const moodList = VALID_MOODS.join(', ');
  return [
    '## Aturan output (KONTRAK KETAT)',
    'Keluarkan HANYA satu objek JSON valid, tanpa teks lain di luar JSON dan tanpa pagar kode (```json).',
    'Bentuk persis:',
    '{',
    '  "messages": ["pesan 1", "pesan 2"],',
    '  "reaction": null,',
    '  "mood": { "name": "santai", "delta": 0, "reason": "alasan singkat" },',
    '  "serious": false,',
    '  "actions": [],',
    '  "query": null',
    '}',
    '- "messages": array berisi 1 sampai 4 pesan pendek. TIDAK BOLEH KOSONG.',
    '- "reaction": string satu emoji yang cocok, atau null jika tidak perlu reaksi.',
    `- "mood": usulan perubahan mood dengan "name" salah satu dari 10 mood: [${moodList}], "delta" (-1, 0, atau 1), dan "reason" string singkat. Atau null jika tidak ada usulan.`,
    '- "serious": boolean true HANYA jika lawan bicara sedih, panik, sakit, atau butuh bantuan serius (matikan ngambek/bercanda). Selain itu false.',
    '- "actions": array aksi, misal [{"type": "save_fact", "text": "..."}] jika user membagikan fakta baru yang penting. Kosongkan [] jika tidak ada.',
    '- "query": selalu null (fitur tools di tahap berikutnya).',
    // TODO(Tahap 5): hapus poin ini setelah tools aktif
    '- Saat ini aksi yang tersedia HANYA save_fact. Pengingat dan catatan BELUM aktif: jangan menjanjikan, menawarkan, atau mengaku bisa melakukannya, termasuk saat ditanya apa saja yang bisa kamu lakukan. Kalau ditanya kemampuanmu, sebutkan ngobrol dan mengingat hal tentang pengguna.',
  ].join('\n');
}

/**
 * Rakit system prompt utuh sesuai SPEC §7.
 * Urutan:
 * 1. persona.md (substitusi 2 tahap: relationship_note dulu, baru callname dan name)
 * 2. KONDISI SAAT INI
 * 3. Fakta tentang user
 * 4. Ringkasan percakapan lama
 * 5. Contoh dialog (3-5 dipilih acak)
 * 6. Aturan output
 *
 * @param {object} p
 * @param {object} p.user - entri user (name, callname, relationship_note, jid)
 * @param {string[]} [p.facts] - daftar fakta tentang user
 * @param {string} [p.summary] - ringkasan percakapan lama
 * @param {number} [p.now] - epoch ms (default getNow())
 * @param {object} [p.cfg]
 * @param {object} [p.rng]
 * @param {object} [p.deps] - injeksi getPhase, getMood, dll.
 * @returns {string}
 */
export function buildSystemPrompt({
  user,
  facts = [],
  summary = '',
  now = getNow(),
  cfg = config,
  rng,
  deps = {},
  exampleCount = null,
  skipExamples = false,
} = {}) {
  const name = cfg.CHARACTER_NAME;
  const callname = user?.callname || user?.name || 'kamu';
  const relationshipNote = user?.relationship_note || '';

  // --- 1. Persona ---
  const personaRaw = deps.personaRaw ?? loadPersona(cfg.PERSONA_FILE);
  const personaClean = stripCommentLines(personaRaw);
  const personaText = personaClean.replace(/# PERSONA:\s*Chloe\b/g, `# PERSONA: ${name}`);
  const personaFilled = fillPlaceholders(
    personaText,
    { name, callname, relationship_note: relationshipNote },
    'persona.md'
  );

  // --- 2. KONDISI SAAT INI ---
  const phase = (deps.getPhase ?? getPhase)(now, deps);
  const awareness = (deps.getAwareness ?? getAwareness)(now, deps);
  const energy = (deps.getEnergy ?? getEnergy)(now, deps);
  const sleepPlan = (deps.getSleepPlan ?? getSleepPlan)(now, deps);
  const activity = (deps.getActivity ?? getActivity)(now, deps);
  const moodState = (deps.getMood ?? getMood)(user?.jid, now, deps);
  const nagLevel = (deps.getNagLevel ?? getNagLevel)(user?.jid, now, deps);

  const nagExplanation = [
    '0 (jangan menegur soal tidur)',
    '1 (menegur lembut)',
    '2 (ngomel lebih tegas)',
    '3 (menyerah dengan drama)',
  ][nagLevel] ?? `${nagLevel}`;

  const sleepDesc = sleepPlan
    ? `tipe ${sleepPlan.type}, perkiraan tidur ${formatWibLong(sleepPlan.sleep_at)}, bangun ${formatWibLong(sleepPlan.wake_at)}`
    : 'belum ada rencana khusus';

  const activityDesc = activity?.state
    ? `${activity.state} sampai ${formatWibLong(activity.until)}`
    : 'tidak ada aktivitas khusus';

  const kondisiLines = [
    '## KONDISI SAAT INI',
    `- Waktu: ${formatWibLong(now)}`,
    `- Fase hidup: ${phase}`,
    `- Tingkat kesadaran: ${awareness} (${awarenessInstruction(awareness)})`,
    `- Mood ${name} saat ini: ${moodState.mood} (intensitas ${moodState.intensity}/5${moodState.reason ? `, alasan: ${moodState.reason}` : ''})`,
    `- Rencana tidur ${name} hari ini: ${sleepDesc}`,
    `- Aktivitas terakhir: ${activityDesc}`,
    `- Energi: ${energy.toFixed(2)}`,
    `- Tingkat teguran jam tidur ${callname}: ${nagExplanation}`,
  ];

  // --- 3. Fakta tentang user ---
  const factsLines = [`## Fakta tentang ${callname}`];
  if (facts && facts.length) {
    for (const f of facts) factsLines.push(`- ${f}`);
  } else {
    factsLines.push('(belum ada catatan fakta khusus)');
  }

  // --- 4. Ringkasan percakapan lama ---
  const summaryLines = ['## Ringkasan percakapan lama'];
  if (summary && summary.trim()) {
    summaryLines.push(summary.trim());
  } else {
    summaryLines.push('(belum ada ringkasan percakapan lama)');
  }

  // --- 5. Contoh dialog ---
  let examplesSection = '';
  if (!skipExamples) {
    const minEx = exampleCount != null ? exampleCount : (cfg.EXAMPLES_MIN ?? 3);
    const maxEx = exampleCount != null ? exampleCount : (cfg.EXAMPLES_MAX ?? 5);
    const examplesSelection = selectDialogExamples({
      name,
      callname,
      mood: moodState.mood,
      phase,
      rng,
      examplesMap: deps.examplesMap,
      min: minEx,
      max: maxEx,
    });

    examplesSection = [
      '## Contoh dialog',
      examplesSelection.text || '(tidak ada contoh)',
    ].join('\n');
  }

  // --- 6. Aturan output ---
  const outputRules = formatOutputRules();

  // Gabungkan semua seksi dengan pemisah ganda (persona, kondisi, dan aturan output selalu utuh)
  const sections = [
    personaFilled.trim(),
    kondisiLines.join('\n'),
    factsLines.join('\n'),
    summaryLines.join('\n'),
  ];
  if (examplesSection) sections.push(examplesSection);
  sections.push(outputRules);

  return sections.join('\n\n');
}

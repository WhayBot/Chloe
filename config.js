// config.js — baca .env, default, semua angka dari SPEC dikumpulkan di sini
import 'dotenv/config';
import { readFileSync } from 'node:fs';

const env = process.env;

// --- helper ---
const int = (v, d) => { const n = parseInt(v, 10); return Number.isNaN(n) ? d : n; };
const float = (v, d) => { const n = parseFloat(v); return Number.isNaN(n) ? d : n; };
const str = (v, d) => (v != null && v !== '' ? v : d);

// --- users.json ---
// Tidak melempar galat: galat dikumpulkan di `error` supaya index.js bisa keluar dengan EXIT_CONFIG (7),
// bukan crash dengan kode 1 (yang boleh di-restart otomatis).
export function loadUsers(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') {
      console.warn(`[config] ${path} tidak ditemukan, pakai daftar kosong`);
      return { users: [], error: null };
    }
    return { users: [], error: `${path} tidak bisa dibaca: ${e.message}` };
  }
  let arr;
  try {
    arr = JSON.parse(raw);
  } catch (e) {
    return { users: [], error: `${path} bukan JSON valid: ${e.message}` };
  }
  if (!Array.isArray(arr)) return { users: [], error: `${path} harus berupa array` };

  const users = [];
  for (const [i, u] of arr.entries()) {
    const number = String(u?.number ?? '').replace(/\D/g, '');
    if (!number) return { users: [], error: `${path} entri ke-${i + 1}: field "number" kosong/tidak valid` };
    users.push({
      number,
      name: u.name ?? '',
      callname: u.callname ?? '',
      is_owner: !!u.is_owner,
      relationship_note: u.relationship_note ?? '',
      // opsional: pengikatan manual JID @lid ke nomor ini
      jid: u.jid ? String(u.jid).trim() : '',
    });
  }
  return { users, error: null };
}

const USERS_FILE = str(env.USERS_FILE, './users.json');
const usersResult = loadUsers(USERS_FILE);

// level pino untuk logger internal Baileys; nilai tak dikenal → silent
const PINO_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'];
function baileysLogLevel(v) {
  const lvl = str(v, 'silent').toLowerCase();
  if (PINO_LEVELS.includes(lvl)) return lvl;
  console.warn(`[config] BAILEYS_LOG_LEVEL="${v}" tidak valid, pakai silent`);
  return 'silent';
}

const config = Object.freeze({
  // galat konfigurasi yang terdeteksi saat load (dicek index.js → EXIT_CONFIG)
  configErrors: Object.freeze([
    usersResult.error,
    env.FAKE_NOW && Number.isNaN(Date.parse(env.FAKE_NOW))
      ? `FAKE_NOW="${env.FAKE_NOW}" bukan waktu ISO valid (contoh: 2026-10-04T02:30:00+07:00)` : null,
  ].filter(Boolean)),

  // --- API & model ---
  OPENROUTER_API_KEY: str(env.OPENROUTER_API_KEY, ''),
  MODEL_PRIMARY: str(env.MODEL_PRIMARY, '').trim(),
  MODEL_FALLBACKS: str(env.MODEL_FALLBACKS, '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean),
  CHARACTER_NAME: str(env.CHARACTER_NAME, 'Chloe'),

  // --- panggilan OpenRouter (Tahap 2) ---
  OPENROUTER_URL: 'https://openrouter.ai/api/v1/chat/completions',
  OPENROUTER_APP_TITLE: 'Chloe-Assist',  // header X-Title (atribusi opsional OpenRouter)
  MODEL_TIMEOUT_MS: 60_000,              // per request (minimal 60 detik untuk model reasoning)
  MODEL_TRANSIENT_RETRIES: 1,            // retry per model untuk galat sementara (429/5xx/timeout/jaringan)
  MODEL_EMPTY_RETRIES: int(env.MODEL_EMPTY_RETRIES, 1), // retry per model untuk konten kosong
  MODEL_RETRY_DELAY_MS: 2000,            // jeda sebelum retry di model yang sama
  MODEL_RETRY_AFTER_MAX_MS: 10_000,      // Retry-After lebih lama dari ini → langsung pindah model
  MODEL_MAX_TOKENS: int(env.MODEL_MAX_TOKENS, 1200),
  MODEL_REASONING: str(env.MODEL_REASONING, ''),
  MODEL_DATA_COLLECTION: str(env.MODEL_DATA_COLLECTION, '').trim(),
  MODEL_ZDR: str(env.MODEL_ZDR, '').trim() || '0',

  // --- anggaran harian global panggilan model (Tahap 3 bagian A) ---
  // dihitung per "hari anggaran": hari UTC yang dimulai pada jam MODEL_BUDGET_RESET_HOUR_UTC
  // (kuota harian model gratis OpenRouter direset 00:00 UTC)
  MODEL_DAILY_BUDGET: int(env.MODEL_DAILY_BUDGET, 40),
  MODEL_BUDGET_RESET_HOUR_UTC: 0,
  OPENROUTER_KEY_URL: 'https://openrouter.ai/api/v1/auth/key',
  BUDGET_SYNC_TIMEOUT_MS: 5000,

  // --- WhatsApp / Baileys ---
  BOT_NUMBER: str(env.BOT_NUMBER, ''),
  AUTH_DIR: str(env.AUTH_DIR, './auth'),
  // disconnect non-fatal: coba terus tanpa batas; berhenti hanya kalau loggedOut
  RECONNECT_BASE_MS: 2000,
  RECONNECT_MAX_DELAY_MS: 60_000,
  PAIRING_MAX_ATTEMPTS: 3,          // percobaan koneksi selama belum terdaftar
  BAD_SESSION_MAX_RETRIES: 8,       // badSession (500) berturut-turut sebelum berhenti (exit 6)
  VERSION_FETCH_TIMEOUT_MS: 10_000,
  BAILEYS_LOG_LEVEL: baileysLogLevel(env.BAILEYS_LOG_LEVEL),

  // --- users ---
  USERS_FILE,
  users: usersResult.users,
  DAILY_LIMIT_PER_USER: int(env.DAILY_LIMIT_PER_USER, 15),

  // --- zona waktu ---
  TZ: str(env.TZ, 'Asia/Jakarta'),

  // --- debug ---
  DELAY_SCALE: float(env.DELAY_SCALE, 1),
  FORCE_PHASE: str(env.FORCE_PHASE, ''),
  FORCE_MOOD: str(env.FORCE_MOOD, ''),
  FAKE_NOW: str(env.FAKE_NOW, ''),
  RNG_SEED: str(env.RNG_SEED, ''),
  DRY_RUN: str(env.DRY_RUN, '0') === '1',

  // --- worker ---
  WORKER_TICK_MS: 3000,

  // --- delay lognormal (SPEC §5) ---
  delay: Object.freeze({
    normal:         { median: 20,  sigma: 0.9, min: 3,   max: 480  },
    bangun:         { median: 180, sigma: 0.7, min: 60,  max: 900  },
    ngantuk_siang:  { median: 70,  sigma: 0.8, min: 15,  max: 720  },
    larut:          { median: 240, sigma: 0.8, min: 40,  max: 1200 },
  }),

  // --- modifier delay ---
  DELAY_URGENT_DIVISOR: 5,
  DELAY_MOOD_NGAMBEK_MULT: 1.5,
  DELAY_MOOD_FAST_MULT: 0.7,       // manja / ceria
  DELAY_READ_ONLY_CHANCE: 0.08,    // dibaca doang, balas belakangan
  DELAY_REACT_ONLY_CHANCE: 0.05,   // hanya reaksi emoji

  // --- typing simulation (SPEC §5) ---
  TYPING_PRE_DELAY_MIN: 500,       // ms
  TYPING_PRE_DELAY_MAX: 3000,
  TYPING_MS_PER_CHAR_MIN: 40,
  TYPING_MS_PER_CHAR_MAX: 80,
  TYPING_MULTI_MSG_GAP_MIN: 800,   // ms
  TYPING_MULTI_MSG_GAP_MAX: 4000,

  // --- sleep plan (SPEC §4.1) ---
  sleepTypes: Object.freeze({
    normal:      { sleepHour: 0.5,  wakeHour: 6,  baseProb: 0.50 },
    sehat:       { sleepHour: 21,   wakeHour: 5,  baseProb: 0.20 },
    berantakan:  { sleepHour: 3,    wakeHour: 9,  baseProb: 0.30 },
  }),
  SLEEP_JITTER_MIN: 20,            // menit
  SLEEP_JITTER_MAX: 30,
  GROGGY_MIN: 10,                  // menit
  GROGGY_MAX: 15,
  GROGGY_EXTRA_BERANTAKAN: 5,
  ENERGY_MIN: 0.3,
  ENERGY_MAX: 1.0,

  // --- Markov transition (SPEC §4.1) ---
  markov: Object.freeze({
    afterBerantakan_sehatBoost: 0.40,
    afterNormal3plus_berantakanBoost: 0.40,
    lateChat_sleepShiftMin: 15,     // menit
    lateChat_sleepShiftMax: 45,
  }),

  // --- fase (SPEC §4.2) ---
  LARUT_BEFORE_SLEEP_MIN: 90,      // menit sebelum sleep_at
  NGANTUK_SIANG_START: 13,         // jam WIB
  NGANTUK_SIANG_END: 15,
  AWARENESS_LARUT: 0.8,

  // --- kebangun (SPEC §4.4) ---
  WAKE_BASE_P: 0.04,
  WAKE_PER_MSG_P: 0.03,
  WAKE_MAX_P: 0.35,
  WAKE_REPLY_DELAY_MIN: 1,         // menit
  WAKE_REPLY_DELAY_MAX: 6,
  WAKE_MORNING_REPLY_MIN: 1,       // menit
  WAKE_MORNING_REPLY_MAX: 20,

  // --- aktivitas (SPEC §4.3) ---
  activities: Object.freeze({
    mandi:        { min: 10, max: 25 },
    makan:        { min: 15, max: 30 },
    nonton:       { min: 30, max: 120 },
    tidur_siang:  { min: 30, max: 90 },
  }),

  // --- nag (SPEC §4.5) ---
  NAG_WINDOW_START: '23:30',
  NAG_WINDOW_END: '05:00',
  NAG_MAX_LEVEL: 3,
  NAG_RESET_SILENT_HOURS: 2,
  NAG_LEVEL3_DELAY_MIN: 30,        // menit
  NAG_LEVEL3_DELAY_MAX: 90,

  // --- typo (SPEC §4.2) ---
  TYPO_FACTOR: 0.15,               // peluang typo per kata = (1 - awareness) × TYPO_FACTOR

  // --- mood (SPEC §6) ---
  VALID_MOODS: Object.freeze([
    'santai', 'ceria', 'manja', 'ngambek', 'males',
    'dongkol', 'lembut', 'salting', 'murung', 'ngantuk',
  ]),
  MOOD_DECAY_MIN: 20,              // menit
  MOOD_DECAY_MAX: 40,
  MOOD_MAX_NGAMBEK_JEDA: 3,        // batas intensitas ngambek dari jeda
  MOOD_NGAMBEK_REDA_MIN: 30,       // menit setelah user balas
  MOOD_DAILY_RANDOM_CHANCE: 0.15,
  MOOD_IDLE_TRIGGER_HOURS: 6,      // jeda > jam ini → ngambek ringan / murung

  // --- balasan (SPEC §7) ---
  MULTI_MSG_WEIGHTS: Object.freeze([
    { count: 1, weight: 0.55 },
    { count: 2, weight: 0.30 },
    { count: 3, weight: 0.15 },
  ]),
  MAX_MESSAGES_PER_REPLY: 4,
  MODEL_TEMPERATURE: 0.7,
  MODEL_MAX_RETRIES: 3,
  MODEL_BACKOFF: Object.freeze([30, 120, 600]),  // detik
  MODEL_BACKOFF_MAX: 3600,
  QUERY_MAX_ROUNDS: 2,

  // --- memori (SPEC §7) ---
  SUMMARY_TRIGGER_MSGS: int(env.SUMMARY_TRIGGER_MSGS, 40),
  SUMMARY_BATCH_MSGS: int(env.SUMMARY_BATCH_MSGS, 20),
  SUMMARY_THRESHOLD: int(env.SUMMARY_TRIGGER_MSGS, 40), // alias backward compatibility
  SUMMARY_BATCH: int(env.SUMMARY_BATCH_MSGS, 20),       // alias backward compatibility
  SUMMARY_MAX_WORDS: 300,
  SUMMARY_MAX_TOKENS: 600,
  FACTS_MAX_PER_USER: 100,
  FACTS_IN_PROMPT: 20,             // fakta terbaru yang masuk prompt
  FACT_MAX_CHARS: 200,
  FACT_SIMILARITY_REPLACE: 0.6,    // kemiripan kata (Jaccard) ≥ ini → fakta lama diganti yang baru
  HISTORY_LIMIT: 24,               // pesan terakhir sebagai riwayat (SPEC: 20-30)
  HISTORY_MIN_KEEP: 10,            // riwayat minimum yang dipertahankan saat memangkas anggaran token (minimal 10)
  PROMPT_TOKEN_BUDGET: int(env.PROMPT_TOKEN_BUDGET, 10000), // dinaikkan ke 10000
  TOKENS_PER_WORD: 2,              // 2 token per kata untuk estimasi token prompt (SPEC Tahap 3 revisi)
  CHARS_PER_TOKEN: 4,              // fallback jika teks tanpa spasi

  // --- prompt (SPEC §7) ---
  PERSONA_FILE: str(env.PERSONA_FILE, './persona.md'),
  EXAMPLES_FILE: str(env.EXAMPLES_FILE, './examples.md'),
  EXAMPLES_MIN: 3,
  EXAMPLES_MAX: 5,

  // --- anti-pola (SPEC §7) ---
  ANTI_PATTERN_WINDOW: 8,          // balasan terakhir yang diperiksa

  // --- scheduler (SPEC §8) ---
  SCHEDULER_TICK_MS: 30_000,
  REMINDER_MISSED_WINDOW_HOURS: 24,

  // --- debounce (SPEC §3) ---
  DEBOUNCE_MIN: 2,                 // detik
  DEBOUNCE_MAX: 6,

  // --- pesan lama diabaikan (SPEC §3) ---
  MSG_MAX_AGE_HOURS: 24,


  // --- DB ---
  DB_PATH: str(env.DB_PATH, './data/chloe.db'),
});

export default config;

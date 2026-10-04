// src/whatsapp.js — Baileys: koneksi, terima, kirim, filter pesan
// Tahap 1: pairing code, reconnect, filter, allowlist, balas "halo", DRY_RUN

import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  DEFAULT_CONNECTION_CONFIG,
  fetchLatestBaileysVersion,
  getContentType,
  normalizeMessageContent,
  jidDecode,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import config from '../config.js';
import { log, shortJid } from './log.js';
import { generateReply, generateText } from './agent.js';
import { getNow, wibDayKey } from './time.js';
import { createBudget } from './budget.js';
import { getSystemReply } from './examples.js';
import { assemblePromptMessages, saveFact, triggerBackgroundSummarize } from './memory.js';
import { getRng } from './rng.js';
import {
  EXIT_CRASH,
  EXIT_BOT_NUMBER_MISSING,
  EXIT_LOGGED_OUT,
  EXIT_PAIRING_FAILED,
  EXIT_CONNECTION_REPLACED,
  EXIT_FORBIDDEN,
  EXIT_BAD_SESSION,
  EXIT_CONFIG,
  exitProcess,
} from './exit.js';

// exit code dipusatkan di exit.js; diekspor ulang supaya tes/pemanggil lama tetap jalan
export {
  EXIT_CRASH,
  EXIT_BOT_NUMBER_MISSING,
  EXIT_LOGGED_OUT,
  EXIT_PAIRING_FAILED,
  EXIT_CONNECTION_REPLACED,
  EXIT_FORBIDDEN,
  EXIT_BAD_SESSION,
  EXIT_CONFIG,
};

// TODO(Tahap 3/4): ganti dengan kalimat acak dari examples.md situasi media_tidak_bisa (SPEC §3)
export const TEMP_NON_TEXT_REPLY = 'maaf, aku belum bisa buka pesan selain teks. ketik aja ya';

// --- Normalisasi nomor: buang +, spasi, strip, kurung → hanya digit ---
export function normalizeNumber(num) {
  return String(num).replace(/\D/g, '');
}

// --- Bangun allowlist lookup dari config.users ---
export function buildAllowlist(users) {
  const map = new Map();
  for (const u of users) {
    const num = normalizeNumber(u.number);
    if (num) map.set(num, u);
  }
  return map;
}

// =====================================================================
// Pemetaan LID → nomor
// =====================================================================
// lid user part → { number, source }. source: 'sender_pn' | 'users_json'.
// Isi awal dimuat dari tabel jid_map + users.json (loadJidMappings), lalu bertambah saat runtime.
const lidMap = new Map();

/**
 * Daftarkan pemetaan LID → nomor.
 * Pengikatan manual (users_json) selalu menang atas hasil belajar (sender_pn).
 * @returns {'added'|'updated'|'unchanged'|'conflict'}
 */
export function registerLidMapping(lidUser, number, source = 'sender_pn') {
  const num = normalizeNumber(number);
  const prev = lidMap.get(lidUser);
  if (prev && prev.number === num && (prev.source === source || source === 'sender_pn')) {
    return 'unchanged';
  }
  if (prev && prev.source === 'users_json' && source !== 'users_json') {
    return 'conflict'; // jangan timpa pengikatan manual
  }
  lidMap.set(lidUser, { number: num, source });
  return prev ? 'updated' : 'added';
}

export function getLidMapping(lidUser) {
  return lidMap.get(lidUser) ?? null;
}

// khusus tes: kosongkan pemetaan
export function _resetLidMap() {
  lidMap.clear();
}

export function resolveJidToNumber(jid) {
  const decoded = jidDecode(jid);
  if (!decoded) return null;
  if (decoded.server === 's.whatsapp.net') {
    return normalizeNumber(decoded.user);
  }
  if (decoded.server === 'lid') {
    return lidMap.get(decoded.user)?.number ?? null;
  }
  return null;
}

/**
 * Ambil bagian user dari JID @lid yang ditulis di users.json. null kalau bukan @lid valid.
 */
export function parseLidJid(jid) {
  if (typeof jid !== 'string' || !jid.endsWith('@lid')) return null;
  const user = jidDecode(jid)?.user;
  return user && /^\d+$/.test(user) ? user : null;
}

/**
 * Muat pemetaan saat start: tabel jid_map lalu field opsional "jid" di users.json.
 * Baris users_json di DB yang sudah tidak ada di users.json dihapus (supaya tidak mengunci LID selamanya).
 * @returns {{ fromDb: number, fromUsers: number, removed: number, invalid: number }}
 */
export function loadJidMappings(db, users) {
  const stats = { fromDb: 0, fromUsers: 0, removed: 0, invalid: 0 };

  // pengikatan manual yang berlaku sekarang
  const manual = new Map(); // lid → number
  for (const u of users) {
    if (!u.jid) continue;
    const lid = parseLidJid(u.jid);
    if (!lid) {
      stats.invalid++;
      log('warn', 'wa', `users.json: field jid diabaikan (hanya format <angka>@lid yang didukung)`, {
        user: u.name || shortJid(u.number),
      });
      continue;
    }
    manual.set(lid, normalizeNumber(u.number));
  }

  for (const row of db.getAllJidMap()) {
    if (row.source === 'users_json' && !manual.has(row.lid)) {
      db.deleteJidMap(row.lid);
      stats.removed++;
      continue;
    }
    registerLidMapping(row.lid, row.number, row.source);
    stats.fromDb++;
  }

  for (const [lid, number] of manual) {
    registerLidMapping(lid, number, 'users_json');
    db.upsertJidMap(lid, number, 'users_json');
    stats.fromUsers++;
  }

  return stats;
}

/**
 * Tentukan nomor pengirim dari key pesan.
 * Urutan untuk @lid: pengikatan manual → key.senderPn → jid_map → tidak diketahui.
 * @returns {{ number: string|null, via: string|null }}
 */
export function resolveSender(key) {
  const jid = key.remoteJid;
  const decoded = jidDecode(jid);
  if (!decoded) return { number: null, via: null };

  if (decoded.server === 's.whatsapp.net') {
    return { number: normalizeNumber(decoded.user), via: 'pn' };
  }
  if (decoded.server !== 'lid') return { number: null, via: null };

  const known = lidMap.get(decoded.user);
  if (known?.source === 'users_json') return { number: known.number, via: 'users_json' };

  // Baileys 6.7.24: key.senderPn diisi dari atribut stanza `sender_pn` (Utils/decode-wa-message.js)
  const pn = key.senderPn ? resolveJidToNumber(key.senderPn) : null;
  if (pn) return { number: pn, via: 'sender_pn' };

  if (known) return { number: known.number, via: 'jid_map' };
  return { number: null, via: null };
}

/**
 * Cek apakah JID termasuk allowlist.
 * @returns {{ user: object, number: string } | null}
 */
export function checkAllowlist(jid, allowlist) {
  const num = resolveJidToNumber(jid);
  if (!num) return null;
  const user = allowlist.get(num);
  return user ? { user, number: num } : null;
}

// --- Filter pesan masuk (SPEC §3 poin 1) ---

/**
 * Tentukan apakah pesan harus diproses.
 * Efek samping: pemetaan LID baru (dari senderPn, hanya untuk nomor allowlist) didaftarkan di memori;
 * pemanggil menyimpannya ke DB lewat field `learnedLid`.
 * @returns {{ pass: boolean, reason?: string, msgType?: string, text?: string }}
 */
export function filterMessage(msg, allowlist) {
  const key = msg.key;
  if (!key) return { pass: false, reason: 'no_key' };

  // abaikan pesan dari diri sendiri
  if (key.fromMe) return { pass: false, reason: 'fromMe' };

  const jid = key.remoteJid;
  if (!jid) return { pass: false, reason: 'no_jid' };

  // abaikan grup (@g.us)
  if (jid.endsWith('@g.us')) return { pass: false, reason: 'group' };

  // abaikan broadcast / status
  if (jid === 'status@broadcast' || jid.endsWith('@broadcast'))
    return { pass: false, reason: 'broadcast' };

  // cek allowlist
  const { number, via } = resolveSender(key);
  if (!number) {
    return { pass: false, reason: jid.endsWith('@lid') ? 'lid_unmapped' : 'not_allowed' };
  }
  const user = allowlist.get(number);
  if (!user) return { pass: false, reason: 'not_allowed' };

  // pelajari LID → nomor dari senderPn (hanya nomor allowlist; nomor asing tidak disimpan)
  let learnedLid = null;
  if (via === 'sender_pn') {
    const lid = jidDecode(jid).user;
    const r = registerLidMapping(lid, number, 'sender_pn');
    if (r === 'added' || r === 'updated') learnedLid = { lid, number };
  }

  // cek timestamp: abaikan pesan > 24 jam
  const ts = msg.messageTimestamp;
  const tsMs = typeof ts === 'number'
    ? (ts > 1e12 ? ts : ts * 1000) // bisa epoch detik atau ms
    : (typeof ts === 'object' && ts?.low != null)
      ? ts.low * 1000 // protobuf Long
      : 0;

  const ageMs = Date.now() - tsMs;
  const maxAge = config.MSG_MAX_AGE_HOURS * 3600 * 1000;
  if (ageMs > maxAge || tsMs === 0) {
    return { pass: false, reason: 'too_old', learnedLid };
  }

  // tentukan tipe pesan; buka wrapper ephemeral/viewOnce/documentWithCaption
  const content = normalizeMessageContent(msg.message);
  if (!content) return { pass: false, reason: 'no_content', learnedLid };

  const contentType = getContentType(content);

  // bukan pesan baru dari user: hapus/edit (protocolMessage), reaksi, update polling
  if (IGNORED_CONTENT_TYPES.has(contentType)) {
    return { pass: false, reason: 'non_message', learnedLid };
  }

  const { msgType, text } = classifyMessage(content, contentType);

  return {
    pass: true,
    jid,
    // JID kanonik berbasis nomor → konsisten dengan tabel users walau pesan datang via @lid
    canonicalJid: `${number}@s.whatsapp.net`,
    number,
    via,
    user,
    msgType,
    text,
    tsMs,
    waId: key.id,
    waKey: key,
    learnedLid,
  };
}

const IGNORED_CONTENT_TYPES = new Set([
  'protocolMessage',
  'reactionMessage',
  'pollUpdateMessage',
  'keepInChatMessage',
  'encReactionMessage',
]);

// alasan penolakan yang berasal dari allowlist → selalu dicatat
export const ALLOWLIST_REJECT_REASONS = new Set(['not_allowed', 'lid_unmapped']);

/**
 * Bentuk entri log untuk pesan yang ditolak. Hanya metadata: JID dipendekkan + alasan, tanpa isi pesan.
 * @returns {{ level: string, text: string, extra: object } | null} null = tidak perlu dicatat
 */
export function describeRejection(msg, reason) {
  if (reason === 'fromMe') return null;
  const extra = { reason, jid: shortJid(msg.key?.remoteJid) };
  if (ALLOWLIST_REJECT_REASONS.has(reason)) {
    // LID bukan nomor telepon: dicetak lengkap (tanpa device) supaya bisa disalin ke field "jid" di users.json
    if (reason === 'lid_unmapped') {
      extra.jid = jidNormalizedUser(msg.key?.remoteJid);
      extra.hint = 'tidak ada senderPn/pemetaan; salin jid ini ke field "jid" user yang benar di users.json';
    }
    return { level: 'info', text: 'pesan ditolak allowlist', extra };
  }
  return { level: 'debug', text: 'pesan ditolak', extra };
}

/**
 * Klasifikasi tipe pesan dan ekstrak teks.
 * Non-teks disimpan dengan type terkait, caption tetap dibaca.
 */
export function classifyMessage(content, contentType) {
  if (!contentType) return { msgType: 'unknown', text: '' };

  // teks biasa
  if (contentType === 'conversation') {
    return { msgType: 'text', text: content.conversation || '' };
  }
  if (contentType === 'extendedTextMessage') {
    return { msgType: 'text', text: content.extendedTextMessage?.text || '' };
  }

  // gambar — caption dibaca sebagai teks
  if (contentType === 'imageMessage') {
    const caption = content.imageMessage?.caption || '';
    return { msgType: 'image', text: caption };
  }

  // video
  if (contentType === 'videoMessage') {
    const caption = content.videoMessage?.caption || '';
    return { msgType: 'video', text: caption };
  }

  // voice note / audio
  if (contentType === 'audioMessage') {
    return { msgType: 'audio', text: '' };
  }

  // stiker
  if (contentType === 'stickerMessage') {
    return { msgType: 'sticker', text: '' };
  }

  // dokumen
  if (contentType === 'documentMessage') {
    const caption = content.documentMessage?.caption || '';
    return { msgType: 'document', text: caption };
  }

  // contact
  if (contentType === 'contactMessage' || contentType === 'contactsArrayMessage') {
    return { msgType: 'contact', text: '' };
  }

  // location
  if (contentType === 'locationMessage' || contentType === 'liveLocationMessage') {
    return { msgType: 'location', text: '' };
  }

  // viewOnce wrapper — buka satu lapis
  if (contentType === 'viewOnceMessage' || contentType === 'viewOnceMessageV2') {
    const inner = content[contentType]?.message;
    if (inner) {
      const innerType = getContentType(inner);
      return classifyMessage(inner, innerType);
    }
  }

  // fallback
  return { msgType: contentType, text: '' };
}

// =====================================================================
// Reconnect
// =====================================================================

export function backoffMs(attempt, cfg = config) {
  return Math.min(cfg.RECONNECT_BASE_MS * Math.pow(2, Math.max(0, attempt - 1)), cfg.RECONNECT_MAX_DELAY_MS);
}

/**
 * Keputusan saat koneksi tertutup. Murni, tanpa efek samping.
 * - loggedOut (401) → keluar (EXIT_LOGGED_OUT)
 * - connectionReplaced (440) → keluar (EXIT_CONNECTION_REPLACED)
 * - forbidden (403) / multideviceMismatch (411) → keluar (EXIT_FORBIDDEN)
 * - badSession (500) → retry maksimal cfg.BAD_SESSION_MAX_RETRIES kali berturut-turut, lalu keluar (EXIT_BAD_SESSION)
 * - belum terdaftar → maksimal cfg.PAIRING_MAX_ATTEMPTS percobaan, lalu keluar (EXIT_PAIRING_FAILED)
 * - lainnya → coba lagi tanpa batas, backoff naik sampai RECONNECT_MAX_DELAY_MS
 * @param {{ statusCode?: number, registered: boolean, counters: { attempt: number, pairingAttempts: number, badSession?: number } }} p
 */
export function decideOnClose({ statusCode, registered, counters }, cfg = config) {
  if (statusCode === DisconnectReason.loggedOut) {
    return { action: 'exit', exitCode: EXIT_LOGGED_OUT, reason: 'logged_out', counters };
  }
  if (statusCode === DisconnectReason.connectionReplaced) {
    return { action: 'exit', exitCode: EXIT_CONNECTION_REPLACED, reason: 'connection_replaced', counters };
  }
  if (statusCode === DisconnectReason.forbidden || statusCode === DisconnectReason.multideviceMismatch) {
    return { action: 'exit', exitCode: EXIT_FORBIDDEN, reason: 'forbidden', counters };
  }

  const attempt = counters.attempt + 1;
  // badSession dihitung berturut-turut; kode lain memutus rentetan
  const badSession = statusCode === DisconnectReason.badSession ? (counters.badSession ?? 0) + 1 : 0;
  if (badSession > cfg.BAD_SESSION_MAX_RETRIES) {
    return {
      action: 'exit', exitCode: EXIT_BAD_SESSION, reason: 'bad_session',
      counters: { attempt, pairingAttempts: counters.pairingAttempts, badSession },
    };
  }

  if (!registered) {
    const pairingAttempts = counters.pairingAttempts + 1;
    if (pairingAttempts >= cfg.PAIRING_MAX_ATTEMPTS) {
      return {
        action: 'exit', exitCode: EXIT_PAIRING_FAILED, reason: 'pairing_failed',
        counters: { attempt, pairingAttempts, badSession },
      };
    }
    return {
      action: 'retry', delay: backoffMs(attempt, cfg), reason: 'unregistered',
      counters: { attempt, pairingAttempts, badSession },
    };
  }

  return {
    action: 'retry', delay: backoffMs(attempt, cfg), reason: badSession ? 'bad_session_retry' : 'transient',
    counters: { attempt, pairingAttempts: counters.pairingAttempts, badSession },
  };
}

export const RESET_COUNTERS = Object.freeze({ attempt: 0, pairingAttempts: 0, badSession: 0 });

// pesan galat per alasan berhenti (exit code: lihat SPEC §9 Tahap 8)
export const EXIT_MESSAGES = Object.freeze({
  logged_out: 'Logged out dari WhatsApp — berhenti. Hapus folder auth/ lalu pairing ulang.',
  pairing_failed: `Pairing gagal setelah ${config.PAIRING_MAX_ATTEMPTS} percobaan — berhenti. ` +
    'Cek BOT_NUMBER, lalu jalankan ulang dan masukkan kode dalam ~1 menit.',
  connection_replaced: 'Sesi dipakai instance lain (connectionReplaced) — berhenti. ' +
    'Jangan jalankan dua instance dengan folder auth/ yang sama (misal laptop dan Termux bersamaan).',
  forbidden: 'Akses ditolak WhatsApp (forbidden/multideviceMismatch) — berhenti. ' +
    'Cek nomor bot di HP (mungkin dibatasi/diblokir atau perangkat tertaut bermasalah) sebelum menjalankan ulang.',
  bad_session: `Sesi rusak (badSession) ${config.BAD_SESSION_MAX_RETRIES + 1}x berturut-turut — berhenti. ` +
    'Periksa folder auth/ (file creds.json rusak/terpotong?). Folder TIDAK dihapus otomatis; ' +
    'kalau perlu, cadangkan lalu hapus sendiri dan pairing ulang.',
});

// =====================================================================
// Versi WhatsApp Web
// =====================================================================

/**
 * Ambil versi WA terbaru (fetchLatestBaileysVersion), fallback ke versi bawaan Baileys terpasang.
 * @param {Function} fetchFn - injeksi untuk tes
 * @returns {Promise<{ version: number[], source: 'latest'|'bawaan', error?: string }>}
 */
export async function resolveWaVersion(fetchFn = fetchLatestBaileysVersion, cfg = config) {
  const fallback = DEFAULT_CONNECTION_CONFIG.version;
  try {
    const r = await fetchFn({ timeout: cfg.VERSION_FETCH_TIMEOUT_MS });
    const ok = r?.isLatest && Array.isArray(r.version) && r.version.length === 3
      && r.version.every(n => Number.isInteger(n) && n >= 0);
    if (ok) return { version: r.version, source: 'latest' };
    return { version: fallback, source: 'bawaan', error: r?.error?.message ?? 'respons tidak valid' };
  } catch (e) {
    return { version: fallback, source: 'bawaan', error: e.message };
  }
}

// =====================================================================
// Koneksi Baileys
// =====================================================================

/**
 * @param {object} deps - { db, exit? } — exit(code) bisa diganti saat tes
 * @returns {Promise<{ getSock, isStopped }>}
 */
export async function startWhatsApp({ db, exit = defaultExit }) {
  const allowlist = buildAllowlist(config.users);
  const logger = pino({ level: config.BAILEYS_LOG_LEVEL });

  const { state, saveCreds } = await useMultiFileAuthState(config.AUTH_DIR);

  // BOT_NUMBER hanya wajib kalau belum pernah pairing
  if (!state.creds.registered && !normalizeNumber(config.BOT_NUMBER)) {
    log('error', 'wa', 'BOT_NUMBER tidak diset di .env — tidak bisa pairing');
    return exit(EXIT_BOT_NUMBER_MISSING);
  }

  // pemetaan LID permanen
  const jm = loadJidMappings(db, config.users);
  log('info', 'wa', `jid_map dimuat`, jm);

  // sinkronkan status allowed di tabel users (hanya nomor di users.json yang allowed=1)
  const allowedJids = config.users.map((u) => `${normalizeNumber(u.number)}@s.whatsapp.net`);
  db.syncAllowed(allowedJids);

  // anggaran harian model
  const budget = createBudget({ db });
  budget.syncRemote().catch(() => {});

  // versi WA Web: sekali saat start
  const ver = await resolveWaVersion();
  log('info', 'wa', `Versi WA Web: ${ver.version.join('.')} (${ver.source}${ver.error ? `, alasan fallback: ${ver.error}` : ''})`);

  let counters = { ...RESET_COUNTERS };
  let sock = null;
  let stopped = false;

  function handleClose(statusCode, errorMsg) {
    const d = decideOnClose({ statusCode, registered: !!state.creds.registered, counters });
    counters = d.counters;

    if (d.action === 'exit') {
      stopped = true;
      log('error', 'wa', `${EXIT_MESSAGES[d.reason] ?? 'Berhenti.'} [exit ${d.exitCode}; terakhir ${statusCode}: ${errorMsg}]`);
      exit(d.exitCode);
      return;
    }

    const tag = d.reason === 'unregistered' ? ` (pairing ${counters.pairingAttempts}/${config.PAIRING_MAX_ATTEMPTS})`
      : d.reason === 'bad_session_retry' ? ` (badSession ${counters.badSession}/${config.BAD_SESSION_MAX_RETRIES})` : '';
    log('warn', 'wa', `Koneksi terputus (${statusCode}: ${errorMsg}), reconnect ke-${counters.attempt} dalam ${d.delay}ms${tag}`);
    setTimeout(() => {
      // connect async: tangkap error supaya tidak jadi unhandled rejection
      connect().catch((e) => handleClose(undefined, `connect gagal: ${e.message}`));
    }, d.delay);
  }

  async function connect() {
    sock = makeWASocket({
      version: ver.version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      logger,
      printQRInTerminal: false,
      markOnlineOnConnect: false, // supaya HP tetap terima notifikasi
      syncFullHistory: false,     // jangan sync history lama
    });
    const thisSock = sock;
    let pairingRequested = false; // satu kode per socket; jumlah socket dibatasi decideOnClose

    // --- event: connection update ---
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      // pairing code: minta saat event `qr` (WS sudah terbuka). Memanggil requestPairingCode
      // langsung setelah makeWASocket gagal 'Connection Closed' karena ws.isOpen masih false.
      if (qr && !pairingRequested && !thisSock.authState.creds.registered) {
        pairingRequested = true;
        const num = normalizeNumber(config.BOT_NUMBER);
        log('info', 'wa', `Meminta pairing code untuk ${shortJid(num + '@s.whatsapp.net')} ` +
          `(percobaan ${counters.pairingAttempts + 1}/${config.PAIRING_MAX_ATTEMPTS})...`);
        try {
          const code = await thisSock.requestPairingCode(num);
          log('info', 'wa', `══════════════════════════════`);
          log('info', 'wa', `  PAIRING CODE: ${code}`);
          log('info', 'wa', `══════════════════════════════`);
          log('info', 'wa', `Masukkan kode di WhatsApp → Settings → Linked Devices → Link with phone number`);
        } catch (e) {
          log('error', 'wa', `Gagal minta pairing code: ${e.message}`);
        }
      }

      if (connection === 'open') {
        counters = { ...RESET_COUNTERS };
        log('info', 'wa', 'Terhubung ke WhatsApp');
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const errorMsg = lastDisconnect?.error?.message || 'unknown';
        handleClose(statusCode, errorMsg);
      }
    });

    // --- event: simpan credentials ---
    sock.ev.on('creds.update', saveCreds);

    // --- event: pesan masuk ---
    sock.ev.on('messages.upsert', async (event) => {
      // hanya proses tipe 'notify' (SPEC §3 poin 1)
      if (event.type !== 'notify') return;

      for (const msg of event.messages) {
        try {
          await handleIncomingMessage(msg, allowlist, db, thisSock, log, { budget });
        } catch (e) {
          log('error', 'wa', `Error handle pesan: ${e.message}`);
        }
      }
    });
  }

  await connect();

  return {
    getSock: () => sock,
    isStopped: () => stopped,
  };
}

// beri jeda singkat supaya log dan penulisan file sempat selesai
function defaultExit(code) {
  exitProcess(code);
}

/**
 * Kirim beberapa pesan teks berurutan. Berhenti di kegagalan pertama.
 * @returns {Promise<Array<{ text: string, key: object|null, ts: number }>>} pesan yang benar-benar terkirim
 */
async function sendTexts(sock, jid, texts, { dryRun, logFn }) {
  const sent = [];
  for (const [i, text] of texts.entries()) {
    if (dryRun) {
      // DRY_RUN: cetak teks balasan bot ke konsol (AGENT.md "Debug"); isi pesan user tetap tidak dicetak
      logFn('info', 'wa', `[DRY_RUN] pesan ${i + 1}/${texts.length} ke ${shortJid(jid)}: ${text}`);
      sent.push({ text, key: null, ts: Date.now() });
      continue;
    }
    try {
      const res = await sock.sendMessage(jid, { text });
      sent.push({ text, key: res?.key ?? null, ts: Date.now() });
    } catch (e) {
      logFn('error', 'wa', `gagal kirim pesan ${i + 1}/${texts.length}: ${e.message}`);
      break;
    }
  }
  if (!dryRun && sent.length) logFn('info', 'wa', `terkirim ${sent.length}/${texts.length} pesan ke ${shortJid(jid)}`);
  return sent;
}

// --- Handle satu pesan masuk ---
// logFn dan opts bisa diganti saat tes.
// opts bisa berupa boolean (kompatibilitas signature Tahap 1: dryRun) atau objek { replyFn, dryRun, budget, clock }
export async function handleIncomingMessage(msg, allowlist, db, sock, logFn = log, opts = {}) {
  const isBool = typeof opts === 'boolean';
  const dryRun = isBool ? opts : (opts.dryRun ?? config.DRY_RUN);
  const customReplyFn = (!isBool && opts.replyFn) ? opts.replyFn : null;
  const budget = (!isBool && opts.budget) ? opts.budget : createBudget({ db });
  const clock = opts.clock ?? getNow;
  const rng = opts.rng ?? getRng();

  const result = filterMessage(msg, allowlist);

  // simpan pemetaan LID baru walau pesannya sendiri ditolak (misal terlalu tua)
  if (result.learnedLid) {
    db.upsertJidMap(result.learnedLid.lid, result.learnedLid.number, 'sender_pn');
    logFn('info', 'wa', 'jid_map: pemetaan LID baru disimpan', {
      lid: shortJid(result.learnedLid.lid), number: shortJid(result.learnedLid.number),
    });
  }

  if (!result.pass) {
    const r = describeRejection(msg, result.reason);
    if (r) logFn(r.level, 'wa', r.text, r.extra);
    return result;
  }

  const { jid, canonicalJid, number, via, msgType, text, tsMs, waId, waKey, user } = result;

  // log JID asli untuk debug pemetaan @lid (AGENT.md); nomor dipendekkan
  logFn('info', 'wa', `pesan masuk`, {
    jid_raw: msg.key.remoteJid,
    sender_pn: msg.key.senderPn ? shortJid(msg.key.senderPn) : undefined,
    via,
    type: msgType,
    number: shortJid(number),
  });

  // dedup berdasarkan wa_id
  if (waId && db.hasWaId(waId)) {
    logFn('debug', 'wa', `dedup: ${waId} sudah ada`);
    return { ...result, pass: false, reason: 'duplicate' };
  }

  // simpan ke tabel messages (pakai JID kanonik berbasis nomor); wa_key = key Baileys utuh (JSON)
  const insertRes = db.insertMessage({
    jid: canonicalJid,
    dir: 'in',
    type: msgType,
    text: text,
    ts: tsMs,
    wa_id: waId,
    wa_key: waKey,
    status: 'queued',
  });
  const currentMsgId = Number(insertRes?.lastInsertRowid ?? insertRes?.id ?? null);

  const replyJid = jidNormalizedUser(jid);
  const now = clock();
  const dayWib = wibDayKey(now);
  const dayBudget = budget.day();

  // Helper kirim pesan dan tandai answered
  async function replyAndMark(texts, sourceName) {
    const sent = await sendTexts(sock, replyJid, texts, { dryRun, logFn });
    if (!sent.length) return false;
    const batchId = `b_${waId ?? Date.now()}`;
    db.transaction(() => {
      for (const s of sent) {
        db.insertMessage({
          jid: canonicalJid,
          dir: 'out',
          type: 'text',
          text: s.text,
          ts: s.ts,
          wa_id: s.key?.id ?? null,
          wa_key: s.key,
          status: 'answered',
          batch_id: batchId,
        });
      }
      db.markAnswered(canonicalJid, batchId);
    });
    return true;
  }

  // --- Cek batas pesan harian per user (SPEC §3) ---
  const dbUser = db.getUser(canonicalJid);
  const userDailyCount = (dbUser?.daily_date === dayWib) ? (dbUser?.daily_count ?? 0) : 0;
  if (userDailyCount >= config.DAILY_LIMIT_PER_USER) {
    if (!db.hasNotice(canonicalJid, dayWib, 'user_limit')) {
      const noticeTexts = getSystemReply('sistem_batas_harian', {
        name: config.CHARACTER_NAME,
        callname: user.callname || user.name,
        rng,
      });
      const ok = await replyAndMark(noticeTexts, 'user_limit_notice');
      if (ok) db.markNotice(canonicalJid, dayWib, 'user_limit');
      logFn('info', 'wa', `batas harian user tercapai (${userDailyCount}/${config.DAILY_LIMIT_PER_USER}), pesan sistem terkirim`, { jid: shortJid(canonicalJid) });
      return { ...result, replied: true, reason: 'user_limit_notified' };
    }
    logFn('debug', 'wa', `batas harian user tercapai, sudah diberitahu hari ini → diam`, { jid: shortJid(canonicalJid) });
    return { ...result, replied: false, reason: 'user_limit_silent' };
  }

  // --- Cek anggaran harian global panggilan model (Tahap 3 bagian A) ---
  if (budget.isExhausted()) {
    if (!db.hasNotice(canonicalJid, dayBudget, 'model_budget')) {
      const noticeTexts = getSystemReply('sistem_batas_harian', {
        name: config.CHARACTER_NAME,
        callname: user.callname || user.name,
        rng,
      });
      const ok = await replyAndMark(noticeTexts, 'model_budget_notice');
      if (ok) db.markNotice(canonicalJid, dayBudget, 'model_budget');
      logFn('warn', 'wa', `anggaran model harian habis, pesan sistem batas terkirim`, { jid: shortJid(canonicalJid) });
      return { ...result, replied: true, reason: 'model_budget_notified' };
    }
    logFn('debug', 'wa', `anggaran model habis, sudah diberitahu hari ini → diam`, { jid: shortJid(canonicalJid) });
    return { ...result, replied: false, reason: 'model_budget_silent' };
  }

  // --- Pesan non-teks: balas dengan pemilihan acak dari media_tidak_bisa (tanpa panggil model) ---
  if (msgType !== 'text' || !text.trim()) {
    const mediaTexts = getSystemReply('media_tidak_bisa', {
      name: config.CHARACTER_NAME,
      callname: user.callname || user.name,
      rng,
    });
    const ok = await replyAndMark(mediaTexts, 'media_tidak_bisa');
    return { ...result, replied: ok, sentCount: mediaTexts.length, source: 'system_media' };
  }

  // --- Pesan teks: panggil model ---
  let outTexts;
  let source;
  let actions = [];

  if (customReplyFn) {
    try {
      const r = await customReplyFn(text);
      outTexts = r.messages;
      source = r.model;
      actions = r.parsed?.actions ?? [];
      logFn('info', 'wa', 'balasan model siap (custom replyFn)', { model: r.model, count: outTexts.length });
    } catch (e) {
      logFn('error', 'wa', `model gagal (${e.kind ?? 'error'}): ${e.message}`);
      return { ...result, replied: false, reason: 'model_failed' };
    }
  } else {
    try {
      const assembled = assemblePromptMessages({
        db,
        user: { ...user, jid: canonicalJid },
        incomingText: text,
        incomingTs: tsMs,
        beforeMessageId: currentMsgId,
        now,
        cfg: config,
        rng,
      });
      const modelOpts = { ...(isBool ? {} : opts), onSuccess: () => budget.record() };
      const r = await generateReply(assembled.messages, modelOpts);
      outTexts = r.messages;
      source = r.model;
      actions = r.parsed?.actions ?? [];
      logFn('info', 'wa', 'balasan model siap', { model: r.model, mode: r.mode, count: outTexts.length });
    } catch (e) {
      // Jika semua model gagal: pesan tetap queued, jangan balas apa-apa (BAGIAN A poin 6)
      logFn('error', 'wa', `model gagal (${e.kind ?? 'error'}): ${e.message}`);
      return { ...result, replied: false, reason: 'model_failed' };
    }
  }

  // Anggaran model dicatat oleh onSuccess per HTTP 200 (jalur replyFn tanpa HTTP dicatat langsung)
  if (customReplyFn) budget.record();
  db.bumpDailyCount(canonicalJid, dayWib);

  // Proses aksi jika ada (misal save_fact)
  for (const act of actions) {
    if (act.type === 'save_fact' && act.text) {
      saveFact(db, canonicalJid, act.text, Date.now(), config);
    }
  }

  const ok = await replyAndMark(outTexts, source);
  if (!ok) {
    return { ...result, replied: false, reason: 'send_failed' };
  }

  // Pemicu pembuatan ringkasan di latar belakang
  triggerBackgroundSummarize({
    db,
    jid: canonicalJid,
    callModelFn: (msgs, o) => generateText(msgs, { ...(isBool ? {} : opts), ...o }),
    budget,
    cfg: config,
  }).catch(() => {});

  return { ...result, replied: true, sentCount: outTexts.length, source };
}

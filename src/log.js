// src/log.js — log metadata + penulisan event_log ke DB
// Isi pesan TIDAK dicetak ke log (AGENT.md §Keamanan)

import config from '../config.js';

// JID dipendekkan untuk log (privasi)
function shortJid(jid) {
  if (!jid) return '?';
  const num = jid.split('@')[0];
  if (num.length <= 6) return num;
  return num.slice(0, 3) + '…' + num.slice(-3);
}

// Format waktu WIB
function wib(date) {
  return new Intl.DateTimeFormat('id-ID', {
    timeZone: config.TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).format(date);
}

/**
 * Log ke konsol. Hanya metadata, tanpa isi pesan.
 * @param {'info'|'warn'|'error'|'debug'} level
 * @param {string} tag
 * @param {string} msg
 * @param {Record<string, unknown>} [extra]
 */
export function log(level, tag, msg, extra) {
  const ts = wib(new Date());
  const prefix = `[${ts}] [${level.toUpperCase()}] [${tag}]`;
  const suffix = extra ? ' ' + JSON.stringify(extra) : '';
  console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'](
    `${prefix} ${msg}${suffix}`
  );
}

/**
 * Catat event_log ke DB (keputusan acak, perubahan mood, dll.)
 * @param {object} db - antarmuka DB dari db.js
 * @param {string} kind - jenis event
 * @param {Record<string, unknown>} detail
 */
export function logEvent(db, kind, detail) {
  const ts = Date.now();
  try {
    db.insertEventLog({ ts, kind, detail: JSON.stringify(detail) });
  } catch (e) {
    log('error', 'log', `gagal tulis event_log: ${e.message}`);
  }
}

export { shortJid, wib };

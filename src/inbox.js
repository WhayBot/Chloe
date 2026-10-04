// src/inbox.js — antrean pesan masuk per JID (tabel inbox) dengan debounce.
// Tanpa Baileys dan tanpa timer: seluruh state di DB, waktu & acak diinjeksi.
import config from '../config.js';
import { getRng } from './rng.js';

/** Tunda due_at kalau `now` sudah dekat due_at; due_at tidak pernah dimajukan. */
function postponeIfNear(db, row, now, cfg, rng) {
  if (now < row.due_at - cfg.DEBOUNCE_WINDOW_MS) return row.due_at;
  const extra = rng.int(cfg.DEBOUNCE_EXTRA_MIN_MS, cfg.DEBOUNCE_EXTRA_MAX_MS);
  const dueAt = Math.max(row.due_at, now + extra);
  if (dueAt !== row.due_at) db.updateInboxDueAt(row.jid, dueAt);
  return dueAt;
}

/**
 * Daftarkan pesan masuk ke inbox.
 * Belum ada baris → due_at = now + delayMs. Sudah ada → pesan ikut digabung (last_msg_ts naik),
 * due_at tidak dimajukan; kalau now >= due_at - DEBOUNCE_WINDOW_MS, ditunda ke now + acak.
 * @returns {{ created: boolean, dueAt: number }}
 */
export function enqueueIncoming({ db, jid, msgTs, now, delayMs, cfg = config, rng = getRng() }) {
  const existing = db.getInboxByJid(jid);
  if (!existing) {
    const dueAt = now + delayMs;
    db.upsertInbox({ jid, due_at: dueAt, first_msg_ts: msgTs, last_msg_ts: msgTs });
    return { created: true, dueAt };
  }
  db.upsertInbox({ jid, due_at: existing.due_at, first_msg_ts: existing.first_msg_ts, last_msg_ts: msgTs });
  return { created: false, dueAt: postponeIfNear(db, existing, now, cfg, rng) };
}

/**
 * Presence 'composing' dari pengirim: tunda due_at dengan aturan yang sama.
 * Tidak membuat baris baru (tanpa pesan di antrean tidak ada yang perlu ditunda).
 * @returns {number|null} due_at terbaru, null kalau tidak ada baris
 */
export function extendForTyping(db, jid, now, cfg = config, rng = getRng()) {
  const existing = db.getInboxByJid(jid);
  if (!existing) return null;
  return postponeIfNear(db, existing, now, cfg, rng);
}

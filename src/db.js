// src/db.js — antarmuka penyimpanan, semua tabel SPEC §2
// Backend: node:sqlite (DatabaseSync). Node v26.8.2 mendukungnya.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { log } from './log.js';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    jid TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    callname TEXT NOT NULL DEFAULT '',
    relationship_note TEXT NOT NULL DEFAULT '',
    is_owner INTEGER NOT NULL DEFAULT 0,
    allowed INTEGER NOT NULL DEFAULT 1,
    daily_count INTEGER NOT NULL DEFAULT 0,
    daily_date TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    jid TEXT NOT NULL,
    dir TEXT NOT NULL CHECK(dir IN ('in','out')),
    type TEXT NOT NULL DEFAULT 'text',
    text TEXT NOT NULL DEFAULT '',
    ts INTEGER NOT NULL,
    wa_id TEXT UNIQUE,
    wa_key TEXT,
    status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','answered')),
    batch_id TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_messages_jid_ts ON messages(jid, ts);
  CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status);

  CREATE TABLE IF NOT EXISTS inbox (
    jid TEXT PRIMARY KEY,
    due_at INTEGER NOT NULL,
    first_msg_ts INTEGER NOT NULL,
    last_msg_ts INTEGER NOT NULL,
    gen_id TEXT
  );

  CREATE TABLE IF NOT EXISTS mood_state (
    jid TEXT PRIMARY KEY,
    mood TEXT NOT NULL DEFAULT 'santai',
    intensity INTEGER NOT NULL DEFAULT 1,
    reason TEXT NOT NULL DEFAULT '',
    since INTEGER NOT NULL,
    last_change INTEGER NOT NULL,
    nag_level INTEGER NOT NULL DEFAULT 0,
    nag_updated INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS facts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    jid TEXT NOT NULL,
    text TEXT NOT NULL,
    ts INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_facts_jid ON facts(jid);

  CREATE TABLE IF NOT EXISTS summaries (
    jid TEXT PRIMARY KEY,
    text TEXT NOT NULL DEFAULT '',
    upto_msg_id INTEGER,
    ts INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    jid TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    ts INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_notes_jid ON notes(jid);

  CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    jid TEXT NOT NULL,
    due_at INTEGER NOT NULL,
    text TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sent','missed')),
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_reminders_jid ON reminders(jid);
  CREATE INDEX IF NOT EXISTS idx_reminders_status ON reminders(status);

  CREATE TABLE IF NOT EXISTS sleep_plan (
    date TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    sleep_at INTEGER NOT NULL,
    wake_at INTEGER NOT NULL,
    groggy_min INTEGER NOT NULL,
    energy REAL NOT NULL
  );

  CREATE TABLE IF NOT EXISTS activity (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    state TEXT NOT NULL DEFAULT '',
    until INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS event_log (
    ts INTEGER NOT NULL,
    kind TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS idx_event_log_ts ON event_log(ts);

  -- perubahan SPEC (Tahap 1 revisi): pemetaan LID → nomor, permanen lintas restart
  -- source: 'sender_pn' (dipelajari dari key.senderPn) | 'users_json' (pengikatan manual)
  CREATE TABLE IF NOT EXISTS jid_map (
    lid TEXT PRIMARY KEY,
    number TEXT NOT NULL,
    source TEXT NOT NULL CHECK(source IN ('sender_pn','users_json')),
    updated_at INTEGER NOT NULL
  );

  -- perubahan SPEC (Tahap 3 bagian A): anggaran harian global panggilan model.
  -- day = hari anggaran (UTC, jam reset di config); count = panggilan HTTP 200;
  -- remote_* = hasil sinkron opsional dari OpenRouter /api/v1/auth/key
  CREATE TABLE IF NOT EXISTS model_usage (
    day TEXT PRIMARY KEY,
    count INTEGER NOT NULL DEFAULT 0,
    remote_used INTEGER,
    remote_limit INTEGER,
    count_at_sync INTEGER,
    synced_at INTEGER
  );

  -- perubahan SPEC (Tahap 3 bagian A): pesan sistem yang sudah dikirim (sekali per user per hari per jenis)
  CREATE TABLE IF NOT EXISTS system_notices (
    jid TEXT NOT NULL,
    day TEXT NOT NULL,
    kind TEXT NOT NULL,
    ts INTEGER NOT NULL,
    PRIMARY KEY (jid, day, kind)
  );
`;

/** @returns {import('./db.js').Db} */
export function openDb(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);

  // WAL mode untuk performa
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA foreign_keys=ON');

  // buat semua tabel
  db.exec(SCHEMA);

  // pastikan activity punya baris default
  const actRow = db.prepare('SELECT id FROM activity WHERE id = 1').get();
  if (!actRow) {
    db.prepare("INSERT INTO activity (id, state, until) VALUES (1, '', 0)").run();
  }

  log('info', 'db', `SQLite dibuka: ${dbPath} (node:sqlite, Node ${process.version})`);

  // --- prepared statements ---
  const stmts = {
    // users
    upsertUser: db.prepare(`
      INSERT INTO users (jid, name, callname, relationship_note, is_owner, allowed, daily_count, daily_date, created_at)
      VALUES (?, ?, ?, ?, ?, 1, 0, '', ?)
      ON CONFLICT(jid) DO UPDATE SET name=excluded.name, callname=excluded.callname,
        relationship_note=excluded.relationship_note, is_owner=excluded.is_owner
    `),
    getUser: db.prepare('SELECT * FROM users WHERE jid = ?'),
    getAllUsers: db.prepare('SELECT * FROM users'),
    updateDailyCount: db.prepare('UPDATE users SET daily_count = ?, daily_date = ? WHERE jid = ?'),
    // naikkan penghitung harian; reset ke 1 kalau tanggal berganti
    bumpDailyCount: db.prepare(`
      UPDATE users SET
        daily_count = CASE WHEN daily_date = ? THEN daily_count + 1 ELSE 1 END,
        daily_date = ?
      WHERE jid = ?
      RETURNING daily_count
    `),
    setAllowedAll: db.prepare('UPDATE users SET allowed = 0'),
    setAllowed: db.prepare('UPDATE users SET allowed = 1 WHERE jid = ?'),

    // messages
    insertMessage: db.prepare(`
      INSERT INTO messages (jid, dir, type, text, ts, wa_id, wa_key, status, batch_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    getMessagesByJid: db.prepare('SELECT * FROM messages WHERE jid = ? ORDER BY ts ASC'),
    getRecentMessagesByJid: db.prepare('SELECT * FROM messages WHERE jid = ? ORDER BY ts DESC LIMIT ?'),
    getQueuedByJid: db.prepare("SELECT * FROM messages WHERE jid = ? AND status = 'queued' ORDER BY ts ASC"),
    markAnswered: db.prepare("UPDATE messages SET status = 'answered', batch_id = ? WHERE jid = ? AND status = 'queued'"),
    getMessageByWaId: db.prepare('SELECT id FROM messages WHERE wa_id = ?'),
    // riwayat berdasarkan urutan simpan (id), bukan ts: ts pesan masuk = waktu WA, ts keluar = waktu lokal
    getRecentBeforeId: db.prepare('SELECT * FROM messages WHERE jid = ? AND id < ? ORDER BY id DESC LIMIT ?'),
    getMessagesAfterId: db.prepare('SELECT * FROM messages WHERE jid = ? AND id > ? ORDER BY id ASC LIMIT ?'),
    countMessagesAfterId: db.prepare('SELECT COUNT(*) AS cnt FROM messages WHERE jid = ? AND id > ?'),

    // inbox
    upsertInbox: db.prepare(`
      INSERT INTO inbox (jid, due_at, first_msg_ts, last_msg_ts, gen_id)
      VALUES (?, ?, ?, ?, NULL)
      ON CONFLICT(jid) DO UPDATE SET last_msg_ts = excluded.last_msg_ts
    `),
    getInboxDue: db.prepare('SELECT * FROM inbox WHERE due_at <= ?'),
    getInboxByJid: db.prepare('SELECT * FROM inbox WHERE jid = ?'),
    updateInboxDueAt: db.prepare('UPDATE inbox SET due_at = ? WHERE jid = ?'),
    updateInboxGenId: db.prepare('UPDATE inbox SET gen_id = ? WHERE jid = ?'),
    deleteInbox: db.prepare('DELETE FROM inbox WHERE jid = ?'),

    // mood_state
    upsertMood: db.prepare(`
      INSERT INTO mood_state (jid, mood, intensity, reason, since, last_change, nag_level, nag_updated)
      VALUES (?, ?, ?, ?, ?, ?, 0, 0)
      ON CONFLICT(jid) DO UPDATE SET mood=excluded.mood, intensity=excluded.intensity,
        reason=excluded.reason, since=excluded.since, last_change=excluded.last_change
    `),
    getMood: db.prepare('SELECT * FROM mood_state WHERE jid = ?'),
    updateNag: db.prepare('UPDATE mood_state SET nag_level = ?, nag_updated = ? WHERE jid = ?'),

    // facts
    insertFact: db.prepare('INSERT INTO facts (jid, text, ts) VALUES (?, ?, ?)'),
    getFactsByJid: db.prepare('SELECT * FROM facts WHERE jid = ? ORDER BY ts DESC'),
    countFactsByJid: db.prepare('SELECT COUNT(*) as cnt FROM facts WHERE jid = ?'),
    deleteFact: db.prepare('DELETE FROM facts WHERE id = ?'),

    // summaries
    upsertSummary: db.prepare(`
      INSERT INTO summaries (jid, text, upto_msg_id, ts) VALUES (?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET text=excluded.text, upto_msg_id=excluded.upto_msg_id, ts=excluded.ts
    `),
    getSummary: db.prepare('SELECT * FROM summaries WHERE jid = ?'),

    // notes
    insertNote: db.prepare('INSERT INTO notes (jid, title, body, ts) VALUES (?, ?, ?, ?)'),
    getNotesByJid: db.prepare('SELECT * FROM notes WHERE jid = ? ORDER BY ts DESC'),
    deleteNote: db.prepare('DELETE FROM notes WHERE id = ? AND jid = ?'),
    searchNotes: db.prepare("SELECT * FROM notes WHERE jid = ? AND (title LIKE ? OR body LIKE ?) ORDER BY ts DESC"),

    // reminders
    insertReminder: db.prepare('INSERT INTO reminders (jid, due_at, text, status, created_at) VALUES (?, ?, ?, \'pending\', ?)'),
    getPendingReminders: db.prepare("SELECT * FROM reminders WHERE status = 'pending' AND due_at <= ?"),
    getRemindersByJid: db.prepare('SELECT * FROM reminders WHERE jid = ? ORDER BY due_at ASC'),
    updateReminderStatus: db.prepare('UPDATE reminders SET status = ? WHERE id = ?'),
    getMissedReminders: db.prepare("SELECT * FROM reminders WHERE status = 'pending' AND due_at < ? AND due_at >= ?"),

    // sleep_plan
    upsertSleepPlan: db.prepare(`
      INSERT INTO sleep_plan (date, type, sleep_at, wake_at, groggy_min, energy) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(date) DO UPDATE SET type=excluded.type, sleep_at=excluded.sleep_at,
        wake_at=excluded.wake_at, groggy_min=excluded.groggy_min, energy=excluded.energy
    `),
    getSleepPlan: db.prepare('SELECT * FROM sleep_plan WHERE date = ?'),
    getLatestSleepPlan: db.prepare('SELECT * FROM sleep_plan ORDER BY date DESC LIMIT 1'),

    // activity
    getActivity: db.prepare('SELECT * FROM activity WHERE id = 1'),
    updateActivity: db.prepare('UPDATE activity SET state = ?, until = ? WHERE id = 1'),

    // event_log
    insertEventLog_: db.prepare('INSERT INTO event_log (ts, kind, detail) VALUES (?, ?, ?)'),

    // jid_map
    upsertJidMap: db.prepare(`
      INSERT INTO jid_map (lid, number, source, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(lid) DO UPDATE SET number=excluded.number, source=excluded.source, updated_at=excluded.updated_at
    `),
    getAllJidMap: db.prepare('SELECT lid, number, source, updated_at FROM jid_map'),
    deleteJidMap: db.prepare('DELETE FROM jid_map WHERE lid = ?'),

    // model_usage
    getUsage: db.prepare('SELECT * FROM model_usage WHERE day = ?'),
    bumpUsage: db.prepare(`
      INSERT INTO model_usage (day, count) VALUES (?, 1)
      ON CONFLICT(day) DO UPDATE SET count = count + 1
      RETURNING count
    `),
    setRemoteUsage: db.prepare(`
      INSERT INTO model_usage (day, count, remote_used, remote_limit, count_at_sync, synced_at) VALUES (?, 0, ?, ?, 0, ?)
      ON CONFLICT(day) DO UPDATE SET remote_used=excluded.remote_used, remote_limit=excluded.remote_limit,
        count_at_sync=model_usage.count, synced_at=excluded.synced_at
    `),

    // system_notices
    hasNotice: db.prepare('SELECT 1 FROM system_notices WHERE jid = ? AND day = ? AND kind = ?'),
    insertNotice: db.prepare('INSERT OR IGNORE INTO system_notices (jid, day, kind, ts) VALUES (?, ?, ?, ?)'),
  };

  // --- public API ---
  const api = {
    // raw db untuk transaksi
    _raw: db,
    backend: 'node:sqlite',
    nodeVersion: process.version,

    close() { db.close(); },

    // --- transaksi ---
    transaction(fn) {
      db.exec('BEGIN');
      try {
        const result = fn();
        db.exec('COMMIT');
        return result;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },

    upsertUser(u) {
      stmts.upsertUser.run(
        u.jid,
        u.name ?? '',
        u.callname ?? '',
        u.relationship_note ?? '',
        u.is_owner ? 1 : 0,
        u.created_at ?? Date.now()
      );
    },
    getUser(jid) { return stmts.getUser.get(jid) ?? null; },
    getAllUsers() { return stmts.getAllUsers.all(); },
    updateDailyCount(jid, count, date) { stmts.updateDailyCount.run(count, date, jid); },
    /** @returns {number|null} penghitung baru; null kalau user tidak ada di tabel */
    bumpDailyCount(jid, date) { return stmts.bumpDailyCount.get(date, date, jid)?.daily_count ?? null; },
    /** allowed=1 hanya untuk JID di daftar (users.json); sisanya 0 */
    syncAllowed(jids) {
      api.transaction(() => {
        stmts.setAllowedAll.run();
        for (const j of jids) stmts.setAllowed.run(j);
      });
    },

    // messages
    insertMessage(m) {
      return stmts.insertMessage.run(
        m.jid, m.dir, m.type ?? 'text', m.text ?? '', m.ts,
        m.wa_id ?? null, m.wa_key ? JSON.stringify(m.wa_key) : null,
        m.status ?? 'queued', m.batch_id ?? null
      );
    },
    getMessagesByJid(jid) { return stmts.getMessagesByJid.all(jid); },
    getRecentMessagesByJid(jid, limit) { return stmts.getRecentMessagesByJid.all(jid, limit); },
    getQueuedByJid(jid) { return stmts.getQueuedByJid.all(jid); },
    markAnswered(jid, batchId) { stmts.markAnswered.run(batchId, jid); },
    /** Tandai hanya pesan queued dengan id tertentu (worker: pesan baru saat generate tidak ikut terjawab). */
    markAnsweredByIds(ids, batchId) {
      if (!ids.length) return;
      const q = ids.map(() => '?').join(',');
      db.prepare(`UPDATE messages SET status = 'answered', batch_id = ? WHERE status = 'queued' AND id IN (${q})`).run(batchId, ...ids);
    },
    hasWaId(waId) { return !!stmts.getMessageByWaId.get(waId); },
    getRecentBeforeId(jid, beforeId, limit) { return stmts.getRecentBeforeId.all(jid, beforeId, limit); },
    getMessagesAfterId(jid, afterId, limit) { return stmts.getMessagesAfterId.all(jid, afterId, limit); },
    countMessagesAfterId(jid, afterId) { return stmts.countMessagesAfterId.get(jid, afterId).cnt; },

    // inbox
    upsertInbox(row) { stmts.upsertInbox.run(row.jid, row.due_at, row.first_msg_ts, row.last_msg_ts); },
    getInboxDue(now) { return stmts.getInboxDue.all(now); },
    getInboxByJid(jid) { return stmts.getInboxByJid.get(jid) ?? null; },
    updateInboxDueAt(jid, dueAt) { stmts.updateInboxDueAt.run(dueAt, jid); },
    updateInboxGenId(jid, genId) { stmts.updateInboxGenId.run(genId, jid); },
    deleteInbox(jid) { stmts.deleteInbox.run(jid); },

    // mood_state
    upsertMood(m) { stmts.upsertMood.run(m.jid, m.mood, m.intensity, m.reason ?? '', m.since, m.last_change); },
    getMood(jid) { return stmts.getMood.get(jid) ?? null; },
    updateNag(jid, level, ts) { stmts.updateNag.run(level, ts, jid); },

    // facts
    insertFact(jid, text, ts) { stmts.insertFact.run(jid, text, ts ?? Date.now()); },
    getFactsByJid(jid) { return stmts.getFactsByJid.all(jid); },
    countFactsByJid(jid) { return stmts.countFactsByJid.get(jid).cnt; },
    deleteFact(id) { stmts.deleteFact.run(id); },

    // summaries
    upsertSummary(jid, text, uptoMsgId, ts) { stmts.upsertSummary.run(jid, text, uptoMsgId, ts ?? Date.now()); },
    getSummary(jid) { return stmts.getSummary.get(jid) ?? null; },

    // notes
    insertNote(jid, title, body, ts) { stmts.insertNote.run(jid, title, body, ts ?? Date.now()); },
    getNotesByJid(jid) { return stmts.getNotesByJid.all(jid); },
    deleteNote(id, jid) { stmts.deleteNote.run(id, jid); },
    searchNotes(jid, q) {
      const like = `%${q}%`;
      return stmts.searchNotes.all(jid, like, like);
    },

    // reminders
    insertReminder(jid, dueAt, text, createdAt) { stmts.insertReminder.run(jid, dueAt, text, createdAt ?? Date.now()); },
    getPendingReminders(now) { return stmts.getPendingReminders.all(now); },
    getRemindersByJid(jid) { return stmts.getRemindersByJid.all(jid); },
    updateReminderStatus(id, status) { stmts.updateReminderStatus.run(status, id); },
    getMissedReminders(now, since) { return stmts.getMissedReminders.all(now, since); },

    // sleep_plan
    upsertSleepPlan(p) { stmts.upsertSleepPlan.run(p.date, p.type, p.sleep_at, p.wake_at, p.groggy_min, p.energy); },
    getSleepPlan(date) { return stmts.getSleepPlan.get(date) ?? null; },
    getLatestSleepPlan() { return stmts.getLatestSleepPlan.get() ?? null; },

    // activity
    getActivity() { return stmts.getActivity.get(); },
    updateActivity(state, until) { stmts.updateActivity.run(state, until); },

    // event_log
    insertEventLog(e) { stmts.insertEventLog_.run(e.ts, e.kind, e.detail ?? '{}'); },

    // jid_map
    upsertJidMap(lid, number, source, ts) { stmts.upsertJidMap.run(lid, number, source, ts ?? Date.now()); },
    getAllJidMap() { return stmts.getAllJidMap.all(); },
    deleteJidMap(lid) { stmts.deleteJidMap.run(lid); },

    // model_usage
    getUsage(day) { return stmts.getUsage.get(day) ?? null; },
    bumpUsage(day) { return stmts.bumpUsage.get(day).count; },
    setRemoteUsage(day, used, limit, ts) { stmts.setRemoteUsage.run(day, used, limit, ts ?? Date.now()); },

    // system_notices
    hasNotice(jid, day, kind) { return !!stmts.hasNotice.get(jid, day, kind); },
    markNotice(jid, day, kind, ts) { return stmts.insertNotice.run(jid, day, kind, ts ?? Date.now()).changes > 0; },
  };

  return api;
}

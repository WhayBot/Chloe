// tests/db.test.js — tes DB: insert, query, transaksi, filter per JID
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const TEST_DIR = join(import.meta.dirname, '..', 'data', '_test');
let db;
let dbCounter = 0;

function freshDb() {
  dbCounter++;
  mkdirSync(TEST_DIR, { recursive: true });
  const path = join(TEST_DIR, `test_${dbCounter}_${Date.now()}.db`);
  return openDb(path);
}

beforeEach(() => { db = freshDb(); });
afterEach(() => { db.close(); });

// --- cleanup setelah semua tes ---
import { after } from 'node:test';
after(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('db — users', () => {
  it('upsert dan get user', () => {
    db.upsertUser({ jid: '628111@s.whatsapp.net', name: 'Test', callname: 'Bos', relationship_note: 'teman', is_owner: true, created_at: 1000 });
    const u = db.getUser('628111@s.whatsapp.net');
    assert.ok(u);
    assert.strictEqual(u.name, 'Test');
    assert.strictEqual(u.callname, 'Bos');
    assert.strictEqual(u.is_owner, 1);
  });

  it('upsert memperbarui data tanpa menimpa daily_count', () => {
    db.upsertUser({ jid: '628111@s.whatsapp.net', name: 'A', callname: 'X', relationship_note: '', is_owner: false, created_at: 1000 });
    db.updateDailyCount('628111@s.whatsapp.net', 5, '2026-10-03');
    db.upsertUser({ jid: '628111@s.whatsapp.net', name: 'B', callname: 'Y', relationship_note: 'baru', is_owner: true, created_at: 2000 });
    const u = db.getUser('628111@s.whatsapp.net');
    assert.strictEqual(u.name, 'B');
    assert.strictEqual(u.daily_count, 5); // tidak di-reset
  });
});

describe('db — messages', () => {
  const JID1 = '628111@s.whatsapp.net';
  const JID2 = '628222@s.whatsapp.net';

  it('insert dan query per JID', () => {
    db.insertMessage({ jid: JID1, dir: 'in', type: 'text', text: 'halo', ts: 1000, wa_id: 'w1' });
    db.insertMessage({ jid: JID2, dir: 'in', type: 'text', text: 'hai', ts: 1001, wa_id: 'w2' });
    db.insertMessage({ jid: JID1, dir: 'out', type: 'text', text: 'yo', ts: 1002, wa_id: 'w3' });

    const m1 = db.getMessagesByJid(JID1);
    assert.strictEqual(m1.length, 2);
    assert.strictEqual(m1[0].text, 'halo');
    assert.strictEqual(m1[1].dir, 'out');

    const m2 = db.getMessagesByJid(JID2);
    assert.strictEqual(m2.length, 1);
  });

  it('dedup by wa_id', () => {
    db.insertMessage({ jid: JID1, dir: 'in', type: 'text', text: 'a', ts: 1000, wa_id: 'dup1' });
    assert.throws(() => {
      db.insertMessage({ jid: JID1, dir: 'in', type: 'text', text: 'b', ts: 1001, wa_id: 'dup1' });
    });
  });

  it('hasWaId', () => {
    db.insertMessage({ jid: JID1, dir: 'in', type: 'text', text: 'x', ts: 1000, wa_id: 'exists1' });
    assert.ok(db.hasWaId('exists1'));
    assert.ok(!db.hasWaId('nope'));
  });

  it('queued → answered', () => {
    db.insertMessage({ jid: JID1, dir: 'in', type: 'text', text: 'a', ts: 1000, wa_id: 'q1', status: 'queued' });
    db.insertMessage({ jid: JID1, dir: 'in', type: 'text', text: 'b', ts: 1001, wa_id: 'q2', status: 'queued' });
    const queued = db.getQueuedByJid(JID1);
    assert.strictEqual(queued.length, 2);

    db.markAnswered(JID1, 'batch-1');
    const after = db.getQueuedByJid(JID1);
    assert.strictEqual(after.length, 0);
  });

  it('getRecentMessagesByJid respects limit', () => {
    for (let i = 0; i < 10; i++) {
      db.insertMessage({ jid: JID1, dir: 'in', type: 'text', text: `m${i}`, ts: 1000 + i, wa_id: `r${i}` });
    }
    const recent = db.getRecentMessagesByJid(JID1, 3);
    assert.strictEqual(recent.length, 3);
    // recent harus terurut desc
    assert.ok(recent[0].ts > recent[1].ts);
  });
});

describe('db — facts (filter per JID)', () => {
  it('fakta terpisah per JID', () => {
    const J1 = '628111@s.whatsapp.net';
    const J2 = '628222@s.whatsapp.net';
    db.insertFact(J1, 'suka teh', 1000);
    db.insertFact(J2, 'suka kopi', 1001);
    db.insertFact(J1, 'alergi udang', 1002);

    const f1 = db.getFactsByJid(J1);
    assert.strictEqual(f1.length, 2);
    const f2 = db.getFactsByJid(J2);
    assert.strictEqual(f2.length, 1);
    assert.strictEqual(f2[0].text, 'suka kopi');
  });
});

describe('db — notes', () => {
  it('insert, search, delete', () => {
    const J = '628111@s.whatsapp.net';
    db.insertNote(J, 'belanja', 'sabun, sampo', 1000);
    db.insertNote(J, 'rapat', 'jam 10', 1001);
    const all = db.getNotesByJid(J);
    assert.strictEqual(all.length, 2);

    const found = db.searchNotes(J, 'sabun');
    assert.strictEqual(found.length, 1);
    assert.strictEqual(found[0].title, 'belanja');

    db.deleteNote(all[0].id, J);
    assert.strictEqual(db.getNotesByJid(J).length, 1);
  });
});

describe('db — reminders', () => {
  it('insert dan getPendingReminders', () => {
    const J = '628111@s.whatsapp.net';
    db.insertReminder(J, 5000, 'bayar listrik', 1000);
    db.insertReminder(J, 9000, 'rapat', 1000);

    const due = db.getPendingReminders(6000);
    assert.strictEqual(due.length, 1);
    assert.strictEqual(due[0].text, 'bayar listrik');
  });
});

describe('db — transaksi', () => {
  it('commit — data tersimpan', () => {
    const J = '628111@s.whatsapp.net';
    db.transaction(() => {
      db.insertFact(J, 'fakta 1', 1000);
      db.insertFact(J, 'fakta 2', 1001);
    });
    assert.strictEqual(db.countFactsByJid(J), 2);
  });

  it('rollback — data tidak tersimpan', () => {
    const J = '628111@s.whatsapp.net';
    assert.throws(() => {
      db.transaction(() => {
        db.insertFact(J, 'akan hilang', 1000);
        throw new Error('gagal');
      });
    }, { message: 'gagal' });
    assert.strictEqual(db.countFactsByJid(J), 0);
  });
});

describe('db — event_log', () => {
  it('insert event_log', () => {
    db.insertEventLog({ ts: Date.now(), kind: 'test', detail: '{"a":1}' });
    // tidak ada query publik, cek lewat raw
    const rows = db._raw.prepare('SELECT * FROM event_log').all();
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].kind, 'test');
  });
});

describe('db — sleep_plan', () => {
  it('upsert dan get', () => {
    db.upsertSleepPlan({ date: '2026-10-03', type: 'normal', sleep_at: 1000, wake_at: 2000, groggy_min: 12, energy: 0.8 });
    const p = db.getSleepPlan('2026-10-03');
    assert.ok(p);
    assert.strictEqual(p.type, 'normal');
    assert.strictEqual(p.energy, 0.8);
  });

  it('getLatestSleepPlan', () => {
    db.upsertSleepPlan({ date: '2026-10-01', type: 'sehat', sleep_at: 100, wake_at: 200, groggy_min: 10, energy: 0.9 });
    db.upsertSleepPlan({ date: '2026-10-03', type: 'berantakan', sleep_at: 300, wake_at: 400, groggy_min: 15, energy: 0.5 });
    const latest = db.getLatestSleepPlan();
    assert.strictEqual(latest.date, '2026-10-03');
  });
});

describe('db — inbox', () => {
  it('upsert dan getDue', () => {
    db.upsertInbox({ jid: '628111@s.whatsapp.net', due_at: 5000, first_msg_ts: 4000, last_msg_ts: 4500 });
    const due = db.getInboxDue(6000);
    assert.strictEqual(due.length, 1);
    const notDue = db.getInboxDue(3000);
    assert.strictEqual(notDue.length, 0);
  });
});

describe('db — mood_state', () => {
  it('upsert dan get per JID', () => {
    const J1 = '628111@s.whatsapp.net';
    const J2 = '628222@s.whatsapp.net';
    db.upsertMood({ jid: J1, mood: 'ngambek', intensity: 3, reason: 'dicuekin', since: 1000, last_change: 1000 });
    db.upsertMood({ jid: J2, mood: 'ceria', intensity: 2, reason: '', since: 1000, last_change: 1000 });

    const m1 = db.getMood(J1);
    assert.strictEqual(m1.mood, 'ngambek');
    assert.strictEqual(m1.intensity, 3);
    const m2 = db.getMood(J2);
    assert.strictEqual(m2.mood, 'ceria');
  });

  it('updateNag', () => {
    const J = '628111@s.whatsapp.net';
    db.upsertMood({ jid: J, mood: 'santai', intensity: 1, reason: '', since: 1000, last_change: 1000 });
    db.updateNag(J, 2, 2000);
    const m = db.getMood(J);
    assert.strictEqual(m.nag_level, 2);
    assert.strictEqual(m.nag_updated, 2000);
  });
});

describe('db — activity', () => {
  it('default ada dan bisa diubah', () => {
    const a = db.getActivity();
    assert.ok(a);
    assert.strictEqual(a.state, '');
    db.updateActivity('mandi', 5000);
    const b = db.getActivity();
    assert.strictEqual(b.state, 'mandi');
    assert.strictEqual(b.until, 5000);
  });
});

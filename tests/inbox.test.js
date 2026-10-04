// tests/inbox.test.js — enqueueIncoming & extendForTyping (DB ':memory:' nyata, jam & rng palsu)
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import config from '../config.js';
import { openDb } from '../src/db.js';
import { createRng } from '../src/rng.js';
import { enqueueIncoming, extendForTyping } from '../src/inbox.js';

const JID = '628111@s.whatsapp.net';
const T0 = Date.parse('2026-10-04T05:00:00Z');

describe('inbox — enqueueIncoming', () => {
  let db;
  beforeEach(() => { db = openDb(':memory:'); });

  it('belum ada baris → due_at = now + delayMs', () => {
    const r = enqueueIncoming({ db, jid: JID, msgTs: T0, now: T0, delayMs: 20_000, cfg: config, rng: createRng('a') });
    assert.equal(r.created, true);
    const row = db.getInboxByJid(JID);
    assert.equal(row.due_at, T0 + 20_000);
    assert.equal(row.first_msg_ts, T0);
  });

  it('pesan kedua jauh dari due_at → digabung, due_at tidak berubah', () => {
    enqueueIncoming({ db, jid: JID, msgTs: T0, now: T0, delayMs: 60_000, cfg: config, rng: createRng('a') });
    enqueueIncoming({ db, jid: JID, msgTs: T0 + 1000, now: T0 + 1000, delayMs: 60_000, cfg: config, rng: createRng('a') });
    const row = db.getInboxByJid(JID);
    assert.equal(row.due_at, T0 + 60_000);
    assert.equal(row.last_msg_ts, T0 + 1000);
    assert.equal(row.first_msg_ts, T0);
  });

  it('pesan kedua dalam DEBOUNCE_WINDOW_MS dari due_at (sudah lewat) → due_at = now + acak [2000, 6000]', () => {
    enqueueIncoming({ db, jid: JID, msgTs: T0, now: T0, delayMs: 3000, cfg: config, rng: createRng('a') });
    for (let i = 0; i < 20; i++) {
      db.updateInboxDueAt(JID, T0 + 3000); // reset
      const now = T0 + 3000 + 500; // lewat due_at
      enqueueIncoming({ db, jid: JID, msgTs: now, now, delayMs: 3000, cfg: config, rng: createRng(`s${i}`) });
      const due = db.getInboxByJid(JID).due_at;
      assert.ok(due >= now + config.DEBOUNCE_EXTRA_MIN_MS && due <= now + config.DEBOUNCE_EXTRA_MAX_MS, `due=${due - now}`);
    }
  });

  it('due_at tidak pernah dimajukan walau now + acak lebih kecil dari due_at', () => {
    enqueueIncoming({ db, jid: JID, msgTs: T0, now: T0, delayMs: 5000, cfg: config, rng: createRng('a') });
    // now = due - 5000 (dalam jendela 6000); acak min 2000 → kandidat now+2000 < due
    enqueueIncoming({ db, jid: JID, msgTs: T0, now: T0, delayMs: 5000, cfg: config, rng: { int: (min) => min } });
    assert.equal(db.getInboxByJid(JID).due_at, T0 + 5000);
  });

  it('now tepat di batas due_at - DEBOUNCE_WINDOW_MS ikut menunda', () => {
    enqueueIncoming({ db, jid: JID, msgTs: T0, now: T0, delayMs: 20_000, cfg: config, rng: createRng('a') });
    const now = T0 + 20_000 - config.DEBOUNCE_WINDOW_MS;
    enqueueIncoming({ db, jid: JID, msgTs: now, now, delayMs: 20_000, cfg: config, rng: { int: (_min, max) => max } });
    assert.equal(db.getInboxByJid(JID).due_at, Math.max(T0 + 20_000, now + config.DEBOUNCE_EXTRA_MAX_MS));
  });
});

describe('inbox — extendForTyping', () => {
  let db;
  beforeEach(() => { db = openDb(':memory:'); });

  it('tanpa baris inbox → null dan tidak membuat baris', () => {
    assert.equal(extendForTyping(db, JID, T0, config, createRng('a')), null);
    assert.equal(db.getInboxByJid(JID), null);
  });

  it('dekat due_at → ditunda; jauh dari due_at → tidak berubah', () => {
    enqueueIncoming({ db, jid: JID, msgTs: T0, now: T0, delayMs: 60_000, cfg: config, rng: createRng('a') });
    assert.equal(extendForTyping(db, JID, T0 + 1000, config, createRng('b')), T0 + 60_000);

    const now = T0 + 59_000;
    const due = extendForTyping(db, JID, now, config, { int: (min) => min });
    assert.equal(due, now + config.DEBOUNCE_EXTRA_MIN_MS);
    assert.equal(db.getInboxByJid(JID).due_at, due);
  });
});

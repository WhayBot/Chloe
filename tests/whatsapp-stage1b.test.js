// tests/whatsapp-stage1b.test.js — tes revisi Tahap 1: reconnect, jid_map/@lid, log penolakan, wa_id/wa_key, versi
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DisconnectReason, DEFAULT_CONNECTION_CONFIG } from '@whiskeysockets/baileys';
import { openDb } from '../src/db.js';
import {
  decideOnClose,
  backoffMs,
  RESET_COUNTERS,
  EXIT_CRASH,
  EXIT_BOT_NUMBER_MISSING,
  EXIT_LOGGED_OUT,
  EXIT_PAIRING_FAILED,
  EXIT_CONNECTION_REPLACED,
  EXIT_FORBIDDEN,
  EXIT_BAD_SESSION,
  EXIT_CONFIG,
  EXIT_MESSAGES,
  buildAllowlist,
  loadJidMappings,
  registerLidMapping,
  getLidMapping,
  resolveSender,
  parseLidJid,
  filterMessage,
  describeRejection,
  handleIncomingMessage,
  resolveWaVersion,
  _resetLidMap,
} from '../src/whatsapp.js';

const cfg = { RECONNECT_BASE_MS: 2000, RECONNECT_MAX_DELAY_MS: 60_000, PAIRING_MAX_ATTEMPTS: 3, BAD_SESSION_MAX_RETRIES: 8, VERSION_FETCH_TIMEOUT_MS: 10 };

// =====================================================================
// Poin 1 — reconnect
// =====================================================================
describe('reconnect — decideOnClose', () => {
  it('loggedOut → exit dengan kode non-zero', () => {
    const d = decideOnClose({ statusCode: DisconnectReason.loggedOut, registered: true, counters: RESET_COUNTERS }, cfg);
    assert.strictEqual(d.action, 'exit');
    assert.strictEqual(d.exitCode, EXIT_LOGGED_OUT);
    assert.notStrictEqual(d.exitCode, 0);
  });

  it('non-fatal (terdaftar) → retry tanpa batas, delay maksimal 60 dtk', () => {
    let counters = { ...RESET_COUNTERS };
    const delays = [];
    for (let i = 0; i < 50; i++) {
      const d = decideOnClose({ statusCode: DisconnectReason.connectionLost, registered: true, counters }, cfg);
      assert.strictEqual(d.action, 'retry', `percobaan ke-${i + 1} harus retry`);
      delays.push(d.delay);
      counters = d.counters;
    }
    assert.deepStrictEqual(delays.slice(0, 6), [2000, 4000, 8000, 16000, 32000, 60000]);
    assert.ok(delays.every(x => x <= 60_000));
    assert.strictEqual(counters.attempt, 50);
  });

  it('restartRequired (515) setelah pairing → retry biasa', () => {
    const d = decideOnClose({ statusCode: DisconnectReason.restartRequired, registered: true, counters: RESET_COUNTERS }, cfg);
    assert.strictEqual(d.action, 'retry');
    assert.strictEqual(d.delay, 2000);
  });

  it('error tanpa statusCode (connect() throw) → retry', () => {
    const d = decideOnClose({ statusCode: undefined, registered: true, counters: RESET_COUNTERS }, cfg);
    assert.strictEqual(d.action, 'retry');
  });

  it('counter direset (RESET_COUNTERS) → delay kembali ke awal', () => {
    let counters = { attempt: 9, pairingAttempts: 0 };
    assert.strictEqual(decideOnClose({ statusCode: 428, registered: true, counters }, cfg).delay, 60_000);
    counters = { ...RESET_COUNTERS }; // terjadi saat connection === 'open'
    assert.strictEqual(decideOnClose({ statusCode: 428, registered: true, counters }, cfg).delay, 2000);
  });

  it('belum terdaftar → maksimal 3 percobaan lalu exit', () => {
    let counters = { ...RESET_COUNTERS };
    const actions = [];
    for (let i = 0; i < 3; i++) {
      const d = decideOnClose({ statusCode: DisconnectReason.timedOut, registered: false, counters }, cfg);
      actions.push(d.action);
      counters = d.counters;
      if (d.action === 'exit') {
        assert.strictEqual(d.exitCode, EXIT_PAIRING_FAILED);
        break;
      }
    }
    // koneksi ke-1 dan ke-2 gagal → retry; ke-3 gagal → exit. Total maksimal 3 socket = 3 kode pairing.
    assert.deepStrictEqual(actions, ['retry', 'retry', 'exit']);
    assert.strictEqual(counters.pairingAttempts, 3);
  });

  it('belum terdaftar + loggedOut → exit logged_out', () => {
    const d = decideOnClose({ statusCode: DisconnectReason.loggedOut, registered: false, counters: RESET_COUNTERS }, cfg);
    assert.strictEqual(d.exitCode, EXIT_LOGGED_OUT);
  });

  it('backoffMs monoton dan dibatasi', () => {
    assert.strictEqual(backoffMs(1, cfg), 2000);
    assert.strictEqual(backoffMs(100, cfg), 60_000);
  });
});

describe('reconnect — disconnect fatal baru', () => {
  const close = (statusCode, counters = RESET_COUNTERS, registered = true) =>
    decideOnClose({ statusCode, registered, counters }, cfg);

  it('connectionReplaced (440) → exit 4', () => {
    const d = close(DisconnectReason.connectionReplaced);
    assert.strictEqual(d.action, 'exit');
    assert.strictEqual(d.exitCode, EXIT_CONNECTION_REPLACED);
    assert.strictEqual(d.exitCode, 4);
    assert.match(EXIT_MESSAGES[d.reason], /instance lain/);
  });

  it('forbidden (403) → exit 5', () => {
    const d = close(DisconnectReason.forbidden);
    assert.strictEqual(d.exitCode, EXIT_FORBIDDEN);
    assert.strictEqual(d.exitCode, 5);
  });

  it('multideviceMismatch (411) → exit 5', () => {
    const d = close(DisconnectReason.multideviceMismatch);
    assert.strictEqual(d.exitCode, 5);
    assert.ok(EXIT_MESSAGES[d.reason]);
  });

  it('kode fatal juga berlaku saat belum terdaftar', () => {
    assert.strictEqual(close(440, RESET_COUNTERS, false).exitCode, 4);
    assert.strictEqual(close(403, RESET_COUNTERS, false).exitCode, 5);
  });

  it('badSession (500): 8 retry berturut-turut, ke-9 → exit 6', () => {
    let counters = { ...RESET_COUNTERS };
    const actions = [];
    for (let i = 0; i < 9; i++) {
      const d = close(DisconnectReason.badSession, counters);
      actions.push(d.action);
      counters = d.counters;
      if (d.action === 'exit') assert.strictEqual(d.exitCode, EXIT_BAD_SESSION);
    }
    assert.deepStrictEqual(actions, [...Array(8).fill('retry'), 'exit']);
    assert.strictEqual(counters.badSession, 9);
  });

  it('badSession: kode lain di tengah memutus rentetan', () => {
    let counters = { ...RESET_COUNTERS };
    for (const code of [500, 500, 500, 428, 500, 500, 500]) {
      const d = close(code, counters);
      assert.strictEqual(d.action, 'retry', `kode ${code} harus retry`);
      counters = d.counters;
    }
    assert.strictEqual(counters.badSession, 3);
  });

  it('badSession: counter di-reset setelah koneksi berhasil', () => {
    let counters = { ...RESET_COUNTERS };
    for (let i = 0; i < 3; i++) counters = close(500, counters).counters;
    counters = { ...RESET_COUNTERS }; // connection === 'open'
    const d = close(500, counters);
    assert.strictEqual(d.action, 'retry');
    assert.strictEqual(d.counters.badSession, 1);
  });

  it('pesan exit bad_session menyarankan cek auth/ dan tidak menghapus otomatis', () => {
    assert.match(EXIT_MESSAGES.bad_session, /auth\//);
    assert.match(EXIT_MESSAGES.bad_session, /TIDAK dihapus otomatis/);
  });

  it('semua exit code unik 1-7 dan non-zero', () => {
    const codes = [EXIT_CRASH, EXIT_LOGGED_OUT, EXIT_PAIRING_FAILED, EXIT_CONNECTION_REPLACED, EXIT_FORBIDDEN, EXIT_BAD_SESSION, EXIT_CONFIG];
    assert.deepStrictEqual(codes, [1, 2, 3, 4, 5, 6, 7]);
    assert.strictEqual(EXIT_BOT_NUMBER_MISSING, 7);
  });
});

// =====================================================================
// Poin 2 — versi WA
// =====================================================================
describe('resolveWaVersion', () => {
  it('pakai versi terbaru kalau fetch berhasil', async () => {
    const r = await resolveWaVersion(async () => ({ version: [2, 3000, 1], isLatest: true }), cfg);
    assert.deepStrictEqual(r.version, [2, 3000, 1]);
    assert.strictEqual(r.source, 'latest');
  });

  it('fallback ke bawaan kalau fetch gagal (isLatest false)', async () => {
    const r = await resolveWaVersion(async () => ({ version: [9, 9, 9], isLatest: false, error: new Error('offline') }), cfg);
    assert.deepStrictEqual(r.version, DEFAULT_CONNECTION_CONFIG.version);
    assert.strictEqual(r.source, 'bawaan');
    assert.strictEqual(r.error, 'offline');
  });

  it('fallback kalau fetch throw atau versi rusak', async () => {
    const a = await resolveWaVersion(async () => { throw new Error('boom'); }, cfg);
    assert.strictEqual(a.source, 'bawaan');
    const b = await resolveWaVersion(async () => ({ version: ['x'], isLatest: true }), cfg);
    assert.strictEqual(b.source, 'bawaan');
  });
});

// =====================================================================
// Poin 3 — @lid dan jid_map
// =====================================================================
const TEST_DIR = join(import.meta.dirname, '..', 'data', '_test_stage1b');
let dbN = 0;
function freshDb() {
  mkdirSync(TEST_DIR, { recursive: true });
  return openDb(join(TEST_DIR, `t_${++dbN}_${Date.now()}.db`));
}
after(() => { if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true }); });

const users = [
  { number: '628111', name: 'A', jid: '' },
  { number: '628222', name: 'B', jid: '777000111@lid' },
];
const allowlist = buildAllowlist(users);
const nowSec = () => Math.floor(Date.now() / 1000);

function lidMsg(lid, extraKey = {}, message = { conversation: 'isi rahasia' }) {
  return {
    key: { remoteJid: `${lid}@lid`, fromMe: false, id: 'id_' + Math.random().toString(36).slice(2), ...extraKey },
    messageTimestamp: nowSec(),
    message,
  };
}

describe('@lid — resolusi dan jid_map', () => {
  beforeEach(() => _resetLidMap());

  it('parseLidJid menerima <angka>@lid saja', () => {
    assert.strictEqual(parseLidJid('123@lid'), '123');
    assert.strictEqual(parseLidJid('123:4@lid'), '123');
    assert.strictEqual(parseLidJid('628111@s.whatsapp.net'), null);
    assert.strictEqual(parseLidJid('abc@lid'), null);
    assert.strictEqual(parseLidJid(''), null);
  });

  it('senderPn ada → lolos, pemetaan dipelajari dan disimpan ke DB', async () => {
    const db = freshDb();
    const logs = [];
    const sock = { sendMessage: async () => {} };
    const r = await handleIncomingMessage(
      lidMsg('555000111', { senderPn: '628111@s.whatsapp.net' }), allowlist, db, sock,
      (...a) => logs.push(a),
      { replyFn: async () => ({ messages: ['halo'], model: 'mock', mode: 'json' }) },
    );
    assert.ok(r.pass);
    assert.strictEqual(r.via, 'sender_pn');
    const rows = db.getAllJidMap();
    assert.deepStrictEqual(rows.map(x => [x.lid, x.number, x.source]), [['555000111', '628111', 'sender_pn']]);
    db.close();
  });

  it('senderPn tidak ada + belum ada pemetaan → ditolak lid_unmapped', () => {
    const r = filterMessage(lidMsg('555000222'), allowlist);
    assert.ok(!r.pass);
    assert.strictEqual(r.reason, 'lid_unmapped');
  });

  it('senderPn tidak ada + pemetaan dari DB → lolos via jid_map (setelah restart)', () => {
    const db = freshDb();
    db.upsertJidMap('555000333', '628111', 'sender_pn');
    loadJidMappings(db, users);
    const r = filterMessage(lidMsg('555000333'), allowlist);
    assert.ok(r.pass);
    assert.strictEqual(r.via, 'jid_map');
    assert.strictEqual(r.canonicalJid, '628111@s.whatsapp.net');
    db.close();
  });

  it('field jid di users.json → pengikatan manual, disimpan ke DB', () => {
    const db = freshDb();
    const s = loadJidMappings(db, users);
    assert.strictEqual(s.fromUsers, 1);
    assert.deepStrictEqual(getLidMapping('777000111'), { number: '628222', source: 'users_json' });
    const r = filterMessage(lidMsg('777000111'), allowlist);
    assert.ok(r.pass);
    assert.strictEqual(r.via, 'users_json');
    assert.ok(db.getAllJidMap().some(x => x.lid === '777000111' && x.source === 'users_json'));
    db.close();
  });

  it('pengikatan manual menang atas senderPn yang berbeda', () => {
    registerLidMapping('777000111', '628222', 'users_json');
    assert.strictEqual(registerLidMapping('777000111', '628111', 'sender_pn'), 'conflict');
    const s = resolveSender({ remoteJid: '777000111@lid', senderPn: '628111@s.whatsapp.net' });
    assert.deepStrictEqual(s, { number: '628222', via: 'users_json' });
  });

  it('baris users_json yang sudah dihapus dari users.json ikut dihapus dari DB', () => {
    const db = freshDb();
    db.upsertJidMap('888000111', '628111', 'users_json');
    const s = loadJidMappings(db, users);
    assert.strictEqual(s.removed, 1);
    assert.ok(!db.getAllJidMap().some(x => x.lid === '888000111'));
    assert.strictEqual(getLidMapping('888000111'), null);
    db.close();
  });

  it('field jid bukan @lid → diabaikan dan dihitung invalid', () => {
    const db = freshDb();
    const s = loadJidMappings(db, [{ number: '628111', name: 'A', jid: '628111@s.whatsapp.net' }]);
    assert.strictEqual(s.invalid, 1);
    assert.strictEqual(s.fromUsers, 0);
    db.close();
  });

  it('senderPn nomor asing → ditolak dan TIDAK disimpan ke jid_map', async () => {
    const db = freshDb();
    const r = await handleIncomingMessage(
      lidMsg('555000444', { senderPn: '629999@s.whatsapp.net' }), allowlist, db, { sendMessage: async () => {} },
      () => {},
    );
    assert.ok(!r.pass);
    assert.strictEqual(r.reason, 'not_allowed');
    assert.strictEqual(db.getAllJidMap().length, 0);
    assert.strictEqual(getLidMapping('555000444'), null);
    db.close();
  });
});

// =====================================================================
// Poin 4 — log penolakan allowlist
// =====================================================================
describe('log penolakan allowlist', () => {
  beforeEach(() => _resetLidMap());

  it('nomor asing → dicatat level info, JID dipendekkan, alasan, tanpa isi pesan', async () => {
    const db = freshDb();
    const logs = [];
    const msg = {
      key: { remoteJid: '6289999999999@s.whatsapp.net', fromMe: false, id: 'x1' },
      messageTimestamp: nowSec(),
      message: { conversation: 'isi rahasia jangan dilog' },
    };
    await handleIncomingMessage(msg, allowlist, db, { sendMessage: async () => { throw new Error('tidak boleh kirim'); } },
      (...a) => logs.push(a));
    assert.strictEqual(logs.length, 1);
    const [level, tag, text, extra] = logs[0];
    assert.strictEqual(level, 'info');
    assert.strictEqual(tag, 'wa');
    assert.strictEqual(text, 'pesan ditolak allowlist');
    assert.strictEqual(extra.reason, 'not_allowed');
    assert.strictEqual(extra.jid, '628…999');
    const serialized = JSON.stringify(logs);
    assert.ok(!serialized.includes('rahasia'));
    assert.ok(!serialized.includes('6289999999999'));
    // tidak disimpan ke DB
    assert.strictEqual(db.getMessagesByJid('6289999999999@s.whatsapp.net').length, 0);
    db.close();
  });

  it('@lid tanpa pemetaan → dicatat dengan alasan lid_unmapped dan LID lengkap', () => {
    const r = describeRejection(lidMsg('123456789012'), 'lid_unmapped');
    assert.strictEqual(r.level, 'info');
    assert.strictEqual(r.extra.reason, 'lid_unmapped');
    assert.strictEqual(r.extra.jid, '123456789012@lid');
  });

  it('lid_unmapped: LID dengan device dinormalisasi ke <angka>@lid, bisa dipakai di users.json', () => {
    const r = describeRejection({ key: { remoteJid: '123456789012:7@lid' } }, 'lid_unmapped');
    assert.strictEqual(r.extra.jid, '123456789012@lid');
    assert.strictEqual(parseLidJid(r.extra.jid), '123456789012');
  });

  it('lid_unmapped lewat handler: LID lengkap dicetak, tanpa isi pesan dan tanpa nomor telepon', async () => {
    const db = freshDb();
    const logs = [];
    await handleIncomingMessage(
      lidMsg('987654321098', {}, { conversation: 'isi rahasia jangan dilog' }), allowlist, db,
      { sendMessage: async () => { throw new Error('tidak boleh kirim'); } },
      (...a) => logs.push(a),
    );
    assert.strictEqual(logs.length, 1);
    const [level, , text, extra] = logs[0];
    assert.strictEqual(level, 'info');
    assert.strictEqual(text, 'pesan ditolak allowlist');
    assert.strictEqual(extra.reason, 'lid_unmapped');
    assert.strictEqual(extra.jid, '987654321098@lid');
    const serialized = JSON.stringify(logs);
    assert.ok(!serialized.includes('rahasia'));
    assert.ok(!serialized.includes('@s.whatsapp.net'));
    assert.ok(!/62\d{6,}/.test(serialized), 'tidak boleh ada nomor telepon lengkap');
    db.close();
  });

  it('not_allowed tetap memendekkan JID (nomor telepon tidak dicetak lengkap)', () => {
    const r = describeRejection({ key: { remoteJid: '6281234567890@s.whatsapp.net' } }, 'not_allowed');
    assert.strictEqual(r.extra.jid, '628…890');
  });

  it('fromMe tidak dicatat; alasan non-allowlist dicatat level debug', () => {
    assert.strictEqual(describeRejection(lidMsg('1'), 'fromMe'), null);
    assert.strictEqual(describeRejection({ key: { remoteJid: '1@g.us' } }, 'group').level, 'debug');
  });
});

// =====================================================================
// Poin 5 — pesan masuk disimpan dengan wa_id dan wa_key
// =====================================================================
describe('penyimpanan pesan masuk', () => {
  let db;
  before(() => { _resetLidMap(); db = freshDb(); });
  after(() => db.close());

  it('wa_id dan wa_key (JSON key Baileys) tersimpan, lalu status answered', async () => {
    const msg = {
      key: { remoteJid: '628111@s.whatsapp.net', fromMe: false, id: 'WAID123' },
      messageTimestamp: nowSec(),
      message: { conversation: 'tes' },
    };
    await handleIncomingMessage(
      msg, allowlist, db, { sendMessage: async () => ({ key: { id: 'WAID_OUT' } }) }, () => {},
      { replyFn: async () => ({ messages: ['halo'], model: 'mock', mode: 'json' }) },
    );
    const rows = db.getMessagesByJid('628111@s.whatsapp.net');
    const inRow = rows.find(r => r.dir === 'in');
    assert.strictEqual(inRow.wa_id, 'WAID123');
    assert.deepStrictEqual(JSON.parse(inRow.wa_key), msg.key);
    assert.strictEqual(inRow.status, 'answered');
  });

  it('wa_id sama dikirim ulang → tidak disimpan dua kali', async () => {
    const msg = {
      key: { remoteJid: '628111@s.whatsapp.net', fromMe: false, id: 'WAID123' },
      messageTimestamp: nowSec(),
      message: { conversation: 'tes' },
    };
    const r = await handleIncomingMessage(msg, allowlist, db, { sendMessage: async () => {} }, () => {});
    assert.strictEqual(r.reason, 'duplicate');
    assert.strictEqual(db.getMessagesByJid('628111@s.whatsapp.net').filter(x => x.dir === 'in').length, 1);
  });
});

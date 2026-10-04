// tests/worker.test.js â€” createWorker (DB ':memory:' nyata, jam palsu, generate/deliver palsu)
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import config from '../config.js';
import { openDb } from '../src/db.js';
import { createRng } from '../src/rng.js';
import { enqueueIncoming } from '../src/inbox.js';
import { createWorker } from '../src/worker.js';
import { formatRecentHistory } from '../src/memory.js';
import { generateReply } from '../src/agent.js';

const A = '628111@s.whatsapp.net';
const B = '628222@s.whatsapp.net';
const T0 = Date.parse('2026-10-04T05:00:00Z');

function setup(over = {}) {
  const db = openDb(':memory:');
  for (const jid of [A, B]) db.upsertUser({ jid, name: 'Uji', callname: 'kak', relationship_note: '' });
  const clock = { t: T0 };
  const gens = [];
  const delivers = [];
  const state = { generate: null };
  const cfg = { ...config, ...(over.cfg ?? {}) };
  const generate = async (msgs, opts) => {
    gens.push(msgs);
    if (state.generate) return state.generate(msgs, opts, gens.length);
    return { messages: [`balas ${gens.length}`], parsed: { actions: [] } };
  };
  const deliver = async (p) => { delivers.push(p); };
  const mk = (extra = {}) => createWorker({
    db, now: () => clock.t, generate, deliver,
    getUser: (jid) => db.getUser(jid),
    systemReply: () => ['sistem gagal'],
    cfg, rng: createRng('w'), logFn: () => {}, ...extra,
  });
  const addMsg = (jid, text, ts = clock.t) => {
    const id = Number(db.insertMessage({ jid, dir: 'in', text, ts, status: 'queued' }).lastInsertRowid);
    enqueueIncoming({ db, jid, msgTs: ts, now: clock.t, delayMs: 10_000, cfg, rng: createRng('e') });
    return id;
  };
  const status = (id) => db.getMessagesByJid(A).concat(db.getMessagesByJid(B)).find((m) => m.id === id);
  const dueAt = (jid) => db.getInboxByJid(jid).due_at;
  const advanceToDue = (jid) => { clock.t = Math.max(clock.t, dueAt(jid)); };
  return { db, clock, gens, delivers, state, cfg, mk, addMsg, status, dueAt, advanceToDue };
}

describe('worker (a) dua pesan dalam jendela â†’ satu generate, satu deliver', () => {
  it('kedua pesan answered, prompt memuat keduanya tepat sekali dengan awalan [HH:MM]', async () => {
    const s = setup();
    const w = s.mk();
    const id1 = s.addMsg(A, 'halo chloe');
    s.clock.t += 3000;
    const id2 = s.addMsg(A, 'lagi apa nih');
    await w.tick();
    assert.equal(s.gens.length, 0, 'belum due â†’ tidak generate');

    s.advanceToDue(A);
    await w.tick();
    assert.equal(s.gens.length, 1);
    assert.equal(s.delivers.length, 1);
    assert.equal(s.delivers[0].queuedMessages.length, 2);
    assert.deepEqual(s.delivers[0].texts, ['balas 1']);
    assert.equal(s.status(id1).status, 'answered');
    assert.equal(s.status(id2).status, 'answered');
    assert.equal(db_count(s.db, A, 'out'), 1, 'balasan tersimpan sebagai pesan keluar');
    assert.equal(s.db.getInboxByJid(A), null);

    const msgs = s.gens[0];
    const last = msgs[msgs.length - 1];
    assert.equal(last.role, 'user');
    assert.match(last.content, /^\[\d\d:\d\d\] halo chloe\n\[\d\d:\d\d\] lagi apa nih$/);
    const all = msgs.map((m) => m.content).join('\n');
    assert.equal(all.split('halo chloe').length - 1, 1, 'pesan tidak dobel di riwayat');
    assert.equal(w.pendingCount(), 0);
  });
});

function db_count(db, jid, dir) {
  return db.getMessagesByJid(jid).filter((m) => m.dir === dir).length;
}

describe('worker (b) pesan masuk saat generate', () => {
  it('hasil pertama dibuang, deliver sekali dengan hasil kedua', async () => {
    const s = setup();
    const w = s.mk();
    const id1 = s.addMsg(A, 'pesan satu');
    s.advanceToDue(A);
    let id2;
    s.state.generate = async (_m, _o, n) => {
      if (n === 1) { id2 = s.addMsg(A, 'pesan dua'); return { messages: ['hasil lama'], parsed: { actions: [] } }; }
      return { messages: ['hasil baru'], parsed: { actions: [] } };
    };
    await w.tick();
    assert.equal(s.gens.length, 2);
    assert.equal(s.delivers.length, 1);
    assert.deepEqual(s.delivers[0].texts, ['hasil baru']);
    assert.equal(s.delivers[0].queuedMessages.length, 2);
    assert.match(s.gens[1][s.gens[1].length - 1].content, /pesan satu\n\[\d\d:\d\d\] pesan dua$/);
    assert.equal(s.status(id1).status, 'answered');
    assert.equal(s.status(id2).status, 'answered');
    const outs = s.db.getMessagesByJid(A).filter((m) => m.dir === 'out').map((m) => m.text);
    assert.deepEqual(outs, ['hasil baru']);
  });

  it('REGEN_MAX tercapai â†’ kirim apa adanya; pesan yang masuk belakangan tetap queued', async () => {
    const s = setup({ cfg: { REGEN_MAX: 1 } });
    const w = s.mk();
    s.addMsg(A, 'p0');
    s.advanceToDue(A);
    const late = [];
    s.state.generate = async (_m, _o, n) => {
      late.push(s.addMsg(A, `susulan ${n}`));
      return { messages: [`r${n}`], parsed: { actions: [] } };
    };
    await w.tick();
    assert.equal(s.gens.length, 2, '1 generate + 1 regen');
    assert.equal(s.delivers.length, 1);
    assert.deepEqual(s.delivers[0].texts, ['r2']);
    assert.equal(s.status(late[0]).status, 'answered');
    assert.equal(s.status(late[1]).status, 'queued', 'pesan masuk saat generate terakhir belum terjawab');
    assert.ok(s.db.getInboxByJid(A), 'inbox dipertahankan untuk pesan yang tersisa');
  });
});

describe('worker (c) restart', () => {
  it('worker baru pada DB yang sama melanjutkan inbox yang belum selesai', async () => {
    const s = setup();
    const w1 = s.mk();
    const id = s.addMsg(A, 'sebelum restart');
    await w1.tick();
    assert.equal(w1.pendingCount(), 1);

    const w2 = s.mk(); // proses baru, state memori kosong
    assert.equal(w2.pendingCount(), 1);
    s.advanceToDue(A);
    await w2.tick();
    assert.equal(s.delivers.length, 1);
    assert.equal(s.status(id).status, 'answered');
    assert.equal(w2.pendingCount(), 0);
  });
});

describe('worker (d) gagal beruntun', () => {
  it('backoff naik, sistem_gagal sekali, pesan tetap queued, sukses mereset', async () => {
    const s = setup();
    const w = s.mk();
    const id = s.addMsg(A, 'tolong dong');
    s.state.generate = async () => { throw new Error('model down'); };

    s.advanceToDue(A);
    await w.tick();
    assert.equal(s.dueAt(A), s.clock.t + 30_000);
    s.clock.t = s.dueAt(A);
    await w.tick();
    assert.equal(s.dueAt(A), s.clock.t + 120_000);
    assert.equal(s.delivers.length, 0, 'belum ada notifikasi sebelum gagal ke-3');
    s.clock.t = s.dueAt(A);
    await w.tick();
    assert.equal(s.dueAt(A), s.clock.t + 600_000);
    assert.equal(s.delivers.length, 1);
    assert.equal(s.delivers[0].kind, 'sistem_gagal');
    assert.deepEqual(s.delivers[0].texts, ['sistem gagal']);
    assert.equal(s.status(id).status, 'queued');

    s.clock.t = s.dueAt(A);
    await w.tick(); // gagal ke-4: tetap hanya satu notifikasi
    assert.equal(s.dueAt(A), s.clock.t + 3_600_000);
    s.clock.t = s.dueAt(A);
    await w.tick(); // gagal ke-5: backoff tetap 1 jam
    assert.equal(s.dueAt(A), s.clock.t + 3_600_000);
    assert.equal(s.delivers.length, 1);
    assert.equal(s.status(id).status, 'queued');

    // sukses â†’ reset
    s.state.generate = null;
    s.clock.t = s.dueAt(A);
    await w.tick();
    assert.equal(s.delivers.length, 2);
    assert.equal(s.delivers[1].kind, undefined);
    assert.equal(s.status(id).status, 'answered');

    // rentetan baru mulai dari backoff pertama
    const id2 = s.addMsg(A, 'lagi');
    s.state.generate = async () => { throw new Error('down lagi'); };
    s.advanceToDue(A);
    await w.tick();
    assert.equal(s.dueAt(A), s.clock.t + 30_000);
    assert.equal(s.status(id2).status, 'queued');
  });
});

describe('worker (e) pesan kedaluwarsa', () => {
  it('tidak dijawab, tidak masuk riwayat, batch_id expired', async () => {
    const s = setup();
    const w = s.mk();
    const old = s.addMsg(A, 'pesan basi', s.clock.t - config.QUEUE_EXPIRE_MS - 60_000);
    const fresh = s.addMsg(A, 'pesan baru');
    s.advanceToDue(A);
    await w.tick();
    assert.equal(s.gens.length, 1);
    const prompt = s.gens[0].map((m) => m.content).join('\n');
    assert.ok(!prompt.includes('pesan basi'));
    assert.equal(s.status(old).status, 'answered');
    assert.equal(s.status(old).batch_id, 'expired');
    assert.notEqual(s.status(fresh).batch_id, 'expired');
    assert.equal(s.delivers[0].queuedMessages.length, 1);

    const hist = formatRecentHistory(s.db, A, 50);
    assert.ok(hist.every((h) => !h.content.includes('pesan basi')));
    assert.ok(hist.some((h) => h.content.includes('pesan baru')));
  });

  it('hanya ada pesan kedaluwarsa â†’ tanpa generate, inbox dibersihkan', async () => {
    const s = setup();
    const w = s.mk();
    const old = s.addMsg(A, 'pesan basi', s.clock.t - config.QUEUE_EXPIRE_MS - 1000);
    s.advanceToDue(A);
    await w.tick();
    assert.equal(s.gens.length, 0);
    assert.equal(s.delivers.length, 0);
    assert.equal(s.status(old).batch_id, 'expired');
    assert.equal(s.db.getInboxByJid(A), null);
  });
});

describe('worker (f) onSuccess per HTTP 200', () => {
  const agentCfg = {
    OPENROUTER_URL: 'https://openrouter.ai/api/v1/chat/completions',
    OPENROUTER_API_KEY: 'sk-or-test-mock-key',
    OPENROUTER_APP_TITLE: 'Chloe-Test',
    MODEL_PRIMARY: 'vendor/primary:free',
    MODEL_FALLBACKS: [],
    MODEL_TIMEOUT_MS: 500,
    MODEL_TRANSIENT_RETRIES: 1,
    MODEL_RETRY_DELAY_MS: 0,
    MODEL_RETRY_AFTER_MAX_MS: 50,
    MODEL_MAX_TOKENS: 100,
    MODEL_TEMPERATURE: 0.7,
    MAX_MESSAGES_PER_REPLY: 4,
  };
  const resp = (status, body) => ({ ok: status === 200, status, json: async () => body, headers: { get: () => null } });
  const okBody = (content) => ({ model: 'vendor/primary:free', choices: [{ message: { content }, finish_reason: 'stop' }] });

  it('generateReply yang mengulang (output tanpa messages) â†’ dua HTTP 200 â†’ dua onSuccess; 429 tidak dihitung', async () => {
    const s = setup();
    let calls = 0;
    const fetchFn = async () => {
      calls++;
      if (calls === 1) return resp(429, { error: { message: 'slow down' } });
      return resp(200, okBody(calls === 2 ? '{"messages": []}' : '{"messages": ["halo juga"]}'));
    };
    let ok = 0;
    const w = s.mk({
      onSuccess: () => { ok++; },
      generate: (msgs, o) => generateReply(msgs, { fetchFn, cfg: agentCfg, logFn: () => {}, sleep: async () => {}, onSuccess: o.onSuccess }),
    });
    s.addMsg(A, 'halo');
    s.advanceToDue(A);
    await w.tick();
    assert.equal(calls, 3, '429 + 200 kosong + 200 valid');
    assert.equal(ok, 2, 'hanya HTTP 200 yang dihitung, termasuk panggilan ulang');
    assert.deepEqual(s.delivers[0].texts, ['halo juga']);
  });

  it('onSuccess yang melempar tidak mengganggu panggilan model', async () => {
    const fetchFn = async () => resp(200, okBody('{"messages": ["ok"]}'));
    const r = await generateReply([{ role: 'user', content: 'x' }], {
      fetchFn, cfg: agentCfg, logFn: () => {}, sleep: async () => {}, onSuccess: () => { throw new Error('boom'); },
    });
    assert.deepEqual(r.messages, ['ok']);
  });
});

describe('worker (g) dua JID', () => {
  it('kegagalan satu JID tidak mengganggu JID lain', async () => {
    const s = setup();
    const w = s.mk();
    const ia = s.addMsg(A, 'dari A');
    const ib = s.addMsg(B, 'dari B');
    s.clock.t += 20_000;
    s.state.generate = async (msgs) => {
      if (msgs[msgs.length - 1].content.includes('dari A')) throw new Error('A gagal');
      return { messages: ['untuk B'], parsed: { actions: [] } };
    };
    await w.tick();
    assert.equal(s.status(ib).status, 'answered');
    assert.equal(s.status(ia).status, 'queued');
    assert.equal(s.delivers.length, 1);
    assert.equal(s.delivers[0].jid, B);
    assert.equal(s.db.getInboxByJid(B), null);
    assert.equal(s.dueAt(A), s.clock.t + 30_000);
  });

  it('satu JID diproses satu per satu (tick tumpang tindih) dan paralel dibatasi WORKER_MAX_PARALLEL', async () => {
    const s = setup({ cfg: { WORKER_MAX_PARALLEL: 1 } });
    const w = s.mk();
    s.addMsg(A, 'a1');
    s.addMsg(B, 'b1');
    s.clock.t += 20_000;
    let release;
    const gate = new Promise((r) => { release = r; });
    s.state.generate = async () => { await gate; return { messages: ['ok'], parsed: { actions: [] } }; };
    const t1 = w.tick();
    const t2 = w.tick(); // tumpang tindih: slot penuh, JID in-flight dilewati
    release();
    await Promise.all([t1, t2]);
    assert.equal(s.gens.length, 1, 'MAX_PARALLEL=1 â†’ hanya satu JID dalam satu putaran');
    assert.equal(w.pendingCount(), 1);
    await w.tick();
    assert.equal(s.gens.length, 2);
    assert.equal(w.pendingCount(), 0);
  });
});

describe('worker â€” save_fact', () => {
  it('aksi save_fact disimpan lewat saveFact yang sama dengan handler', async () => {
    const s = setup();
    const w = s.mk();
    s.addMsg(A, 'aku suka kopi hitam');
    s.advanceToDue(A);
    s.state.generate = async () => ({ messages: ['oke'], parsed: { actions: [{ type: 'save_fact', text: 'suka kopi hitam' }] } });
    await w.tick();
    assert.ok(s.db.getFactsByJid(A).some((f) => f.text.includes('kopi hitam')));
  });
});

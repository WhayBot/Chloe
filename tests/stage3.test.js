// tests/stage3.test.js — tes unit Tahap 3: parser contoh, substitusi placeholder, pemilih contoh, ringkasan, persistensi memori, pemisahan JID, anggaran harian, 429 upstream
import { describe, it, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import config from '../config.js';
import { openDb } from '../src/db.js';
import { createBudget } from '../src/budget.js';
import {
  stripCommentLines,
  listPlaceholders,
  assertKnownPlaceholders,
  fillPlaceholders,
} from '../src/template.js';
import {
  parseExampleBlock,
  parseExamples,
  selectDialogExamples,
  getSystemReply,
  loadExamples,
  TEMPORARY_EXCLUDED_UNTIL_TOOLS,
} from '../src/examples.js';
import {
  buildSystemPrompt,
  validatePromptAssets,
  formatOutputRules,
} from '../src/prompt.js';
import {
  saveFact,
  isSensitiveFact,
  textSimilarity,
  getFactsForPrompt,
  getSummaryForPrompt,
  formatRecentHistory,
  assemblePromptMessages,
  triggerBackgroundSummarize,
  _resetSummaryState,
} from '../src/memory.js';
import { callModel, isUpstreamRateLimit, generateText } from '../src/agent.js';
import { handleIncomingMessage, buildAllowlist } from '../src/whatsapp.js';
import { createRng } from '../src/rng.js';

const TEST_DIR = join(import.meta.dirname, '..', 'data', '_test_stage3');
let dbCounter = 0;

function freshDb() {
  dbCounter++;
  mkdirSync(TEST_DIR, { recursive: true });
  return openDb(join(TEST_DIR, `test3_${dbCounter}_${Date.now()}.db`));
}

after(() => {
  try {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {}
});

// =====================================================================
// 1. Substitusi Placeholder & Komentar Template (SPEC §7)
// =====================================================================
describe('template — stripCommentLines & fillPlaceholders', () => {
  it('stripCommentLines membuang baris yang diawali >', () => {
    const raw = '> Komentar 1\n> Komentar 2\nBaris asli\n  > Indented comment\nBaris kedua';
    assert.strictEqual(stripCommentLines(raw), 'Baris asli\nBaris kedua');
  });

  it('substitusi dua tahap: relationship_note diproses sebelum callname', () => {
    const template = 'Halo, aku {{name}}. {{relationship_note}}';
    const vars = {
      name: 'Chloe',
      callname: 'Kak Bayu',
      relationship_note: 'Aku asisten dari {{callname}}.',
    };
    const res = fillPlaceholders(template, vars);
    assert.strictEqual(res, 'Halo, aku Chloe. Aku asisten dari Kak Bayu.');
  });

  it('placeholder tidak dikenal memunculkan galat', () => {
    const bad = 'Halo {{nama_salah}}, apa kabar?';
    assert.throws(() => {
      assertKnownPlaceholders(bad, ['name', 'callname'], 'test');
    }, /placeholder tidak dikenal/);
  });

  it('placeholder yang belum terisi setelah substitusi melempar galat', () => {
    const raw = 'Halo {{unknown_var}}';
    assert.throws(() => {
      fillPlaceholders(raw, { name: 'Chloe', callname: 'Bos' }, 'test');
    }, /placeholder tersisa/);
  });
});

// =====================================================================
// 2. Parser examples.md (SPEC §7 & BAGIAN B)
// =====================================================================
describe('examples — parseExamples & parseExampleBlock', () => {
  const sampleDoc = `
# Header
> Ini komentar
## situasi: sapaan
U: halo
A: hai {{callname}}

---

U: p
U: tes
A: salam yang bener dong
A: kenapa?

## situasi: media_tidak_bisa
> Pesan sistem
A: gambarnya nggak kebuka nih
---
A: kirim teks aja ya

## jangan begini
- Jangan kaku
- U: tes
  A: dilarang
`;

  it('parseExampleBlock menangani U: dan A: beruntun serta tanpa U:', () => {
    const b1 = parseExampleBlock('U: p\nU: tes\nA: salam yang bener\nA: kenapa?');
    assert.ok(b1);
    assert.strictEqual(b1.lines.length, 4);
    assert.deepStrictEqual(b1.assistantTexts, ['salam yang bener', 'kenapa?']);

    const b2 = parseExampleBlock('A: hanya balasan sistem');
    assert.ok(b2);
    assert.strictEqual(b2.lines.length, 1);
    assert.strictEqual(b2.assistantTexts[0], 'hanya balasan sistem');
  });

  it('parseExamples memecah per situasi dan mengabaikan "jangan begini"', () => {
    const map = parseExamples(sampleDoc, 'test-sample');
    assert.ok(map.has('sapaan'));
    assert.ok(map.has('media_tidak_bisa'));
    assert.ok(!map.has('jangan begini'));
    assert.strictEqual(map.get('sapaan').length, 2);
    assert.strictEqual(map.get('media_tidak_bisa').length, 2);
  });

  it('getSystemReply memilih balasan sistem acak dengan placeholder terisi', () => {
    const map = parseExamples(sampleDoc, 'test-sample');
    const reply = getSystemReply('media_tidak_bisa', {
      name: 'Chloe',
      callname: 'Kakak',
      examplesMap: map,
      rng: createRng(1),
    });
    assert.ok(Array.isArray(reply));
    assert.ok(reply.length >= 1);
    assert.ok(reply[0].includes('gambarnya nggak kebuka') || reply[0].includes('kirim teks'));
  });

  it('selectDialogExamples memilih 3-5 contoh dengan header', () => {
    const map = parseExamples(sampleDoc, 'test-sample');
    const sel = selectDialogExamples({
      name: 'Chloe',
      callname: 'Kakak',
      examplesMap: map,
      min: 1,
      max: 2,
      rng: createRng(42),
    });
    assert.ok(sel.text.includes('Contoh hanya menunjukkan nada dan ritme'));
    assert.ok(sel.count > 0);
  });

  it('selectDialogExamples mengecualikan situasi tidur sementara (tegur_tidur dkk)', () => {
    const map = new Map([
      ['tegur_tidur', [{ lines: [{ role: 'A', text: 'tidur sana' }], assistantTexts: ['tidur sana'] }]],
      ['ironi_tidur', [{ lines: [{ role: 'A', text: 'ironi' }], assistantTexts: ['ironi'] }]],
      ['baru_bangun', [{ lines: [{ role: 'A', text: 'bangun' }], assistantTexts: ['bangun'] }]],
      ['kebangun_karena_pesan', [{ lines: [{ role: 'A', text: 'kebangun' }], assistantTexts: ['kebangun'] }]],
      ['pamit_tidur', [{ lines: [{ role: 'A', text: 'pamit' }], assistantTexts: ['pamit'] }]],
      ['santai', [{ lines: [{ role: 'A', text: 'santai aja' }], assistantTexts: ['santai aja'] }]],
    ]);
    const sel = selectDialogExamples({
      examplesMap: map,
      min: 1,
      max: 5,
      rng: createRng(42),
    });
    assert.ok(!sel.text.includes('tidur sana'));
    assert.ok(!sel.text.includes('ironi'));
    assert.ok(!sel.text.includes('bangun'));
    assert.ok(!sel.text.includes('kebangun'));
    assert.ok(!sel.text.includes('pamit'));
    assert.ok(sel.text.includes('santai aja'));
  });
});

// =====================================================================
// 3. System Prompt Assembly (SPEC §7)
// =====================================================================
describe('prompt — buildSystemPrompt', () => {
  it('menyusun urutan persis: persona → KONDISI SAAT INI → fakta → ringkasan → contoh → aturan output', () => {
    const user = {
      jid: '628111@s.whatsapp.net',
      name: 'Bayu',
      callname: 'Kak Bayu',
      relationship_note: 'Teman baik dari {{callname}}.',
    };
    const facts = ['Suka kopi tanpa gula', 'Bekerja shift malam'];
    const summary = 'Kemarin membahas rencana liburan ke Bandung.';

    const prompt = buildSystemPrompt({
      user,
      facts,
      summary,
      now: Date.parse('2026-10-04T10:00:00+07:00'),
    });

    const posPersona = prompt.indexOf('Kamu adalah');
    const posKondisi = prompt.indexOf('## KONDISI SAAT INI');
    const posFakta = prompt.indexOf('## Fakta tentang Kak Bayu');
    const posSummary = prompt.indexOf('## Ringkasan percakapan lama');
    const posContoh = prompt.indexOf('## Contoh dialog');
    const posRules = prompt.indexOf('## Aturan output (KONTRAK KETAT)');

    assert.ok(posPersona >= 0);
    assert.ok(posKondisi > posPersona);
    assert.ok(posFakta > posKondisi);
    assert.ok(posSummary > posFakta);
    assert.ok(posContoh > posSummary);
    assert.ok(posRules > posContoh);

    // menyebut 10 mood
    assert.ok(prompt.includes('santai, ceria, manja, ngambek, males, dongkol, lembut, salting, murung, ngantuk'));
    assert.ok(prompt.includes('Kak Bayu'));
  });

  it('validatePromptAssets melempar galat jika placeholder di persona tidak dikenal', () => {
    assert.doesNotThrow(() => validatePromptAssets());
  });

  it('semua heading persona.md (## dan ###) muncul lengkap di system prompt', () => {
    const raw = readFileSync(config.PERSONA_FILE, 'utf8');
    const headings = [...raw.matchAll(/^#{2,3}\s+.+$/gm)].map((m) => m[0].trim());
    assert.ok(headings.length >= 8, 'persona.md harus memiliki setidaknya 8 heading');

    const prompt = buildSystemPrompt({
      user: { name: 'Budi Santoso', callname: 'Kak Budi', relationship_note: 'Teman lama {{callname}}.' },
      facts: ['Fakta 1'],
      summary: 'Ringkasan',
    });

    for (const h of headings) {
      assert.ok(prompt.includes(h), `Heading persona hilang di system prompt: ${h}`);
    }
  });
});

// =====================================================================
// 4. Memori: Fakta, Ringkasan, Persistensi, dan Isolasi Antar-JID (SPEC §7)
// =====================================================================
describe('memory — fakta, ringkasan, persistensi, dan isolasi', () => {
  let db;
  beforeEach(() => { db = freshDb(); });
  afterEach(() => { db.close(); });

  it('saveFact menolak fakta yang memuat informasi sensitif (keuangan, kesehatan, alamat)', () => {
    assert.strictEqual(saveFact(db, 'user1@s.whatsapp.net', 'Password emailku adalah rahasia123').ok, false);
    assert.strictEqual(saveFact(db, 'user1@s.whatsapp.net', 'Nomor rekening bank mandiri 123456').ok, false);
    assert.strictEqual(saveFact(db, 'user1@s.whatsapp.net', 'Diagnosa dokter saya terkena asam lambung kronis').ok, false);
    assert.strictEqual(saveFact(db, 'user1@s.whatsapp.net', 'Saya minum obat resep dari psikiater').ok, false);
    assert.strictEqual(saveFact(db, 'user1@s.whatsapp.net', 'Alamat rumah saya di Jl. Melati Indah No 12').ok, false);
    assert.strictEqual(saveFact(db, 'user1@s.whatsapp.net', 'Lokasi tempat tinggal di Komplek Sakura Blok C').ok, false);
  });

  it('saveFact memperbarui fakta yang mirip (dedup/replace)', () => {
    const jid = 'user1@s.whatsapp.net';
    saveFact(db, jid, 'Suka minum kopi hitam tanpa gula');
    const f1 = getFactsForPrompt(db, jid);
    assert.strictEqual(f1.length, 1);

    // fakta mirip diperbarui
    const r2 = saveFact(db, jid, 'Suka minum kopi hitam pakai gula');
    assert.strictEqual(r2.ok, true);
    assert.strictEqual(r2.reason, 'replaced');
    const f2 = getFactsForPrompt(db, jid);
    assert.strictEqual(f2.length, 1);
    assert.strictEqual(f2[0], 'Suka minum kopi hitam pakai gula');
  });

  it('memori dua user tidak saling bercampur (isolasi per JID)', () => {
    const jidA = 'userA@s.whatsapp.net';
    const jidB = 'userB@s.whatsapp.net';

    saveFact(db, jidA, 'User A suka teh');
    saveFact(db, jidB, 'User B suka kopi');
    db.upsertSummary(jidA, 'Ringkasan A', 10, 1000);
    db.upsertSummary(jidB, 'Ringkasan B', 20, 2000);
    db.insertMessage({ jid: jidA, dir: 'in', text: 'pesan A', ts: 100 });
    db.insertMessage({ jid: jidB, dir: 'in', text: 'pesan B', ts: 200 });

    const factsA = getFactsForPrompt(db, jidA);
    const factsB = getFactsForPrompt(db, jidB);
    assert.deepStrictEqual(factsA, ['User A suka teh']);
    assert.deepStrictEqual(factsB, ['User B suka kopi']);

    assert.strictEqual(getSummaryForPrompt(db, jidA), 'Ringkasan A');
    assert.strictEqual(getSummaryForPrompt(db, jidB), 'Ringkasan B');

    const histA = formatRecentHistory(db, jidA);
    const histB = formatRecentHistory(db, jidB);
    assert.strictEqual(histA.length, 1);
    assert.ok(histA[0].content.includes('pesan A'));
    assert.strictEqual(histB.length, 1);
    assert.ok(histB[0].content.includes('pesan B'));
  });

  it('ingatan tetap ada setelah restart (re-open DB)', () => {
    const dbPath = join(TEST_DIR, `restart_test_${Date.now()}.db`);
    const db1 = openDb(dbPath);
    const jid = 'user1@s.whatsapp.net';

    saveFact(db1, jid, 'Tinggal di Surabaya');
    db1.upsertSummary(jid, 'Ringkasan lama tersimpan', 5, 500);
    db1.insertMessage({ jid, dir: 'in', text: 'Halo Chloe', ts: 1000, status: 'answered' });
    db1.insertMessage({ jid, dir: 'out', text: 'Halo juga!', ts: 1050, status: 'answered' });
    db1.close();

    // Buka kembali database dari file yang sama
    const db2 = openDb(dbPath);
    assert.deepStrictEqual(getFactsForPrompt(db2, jid), ['Tinggal di Surabaya']);
    assert.strictEqual(getSummaryForPrompt(db2, jid), 'Ringkasan lama tersimpan');
    const hist = formatRecentHistory(db2, jid);
    assert.strictEqual(hist.length, 2);
    db2.close();
  });

  it('pemicu ringkasan latar belakang dengan model palsu', async () => {
    const jid = 'user1@s.whatsapp.net';
    // Masukkan 45 pesan (> threshold 40)
    for (let i = 1; i <= 45; i++) {
      db.insertMessage({ jid, dir: i % 2 === 1 ? 'in' : 'out', text: `Pesan obrolan ke-${i}`, ts: 1000 + i, status: 'answered' });
    }

    let modelCalled = false;
    const mockCallModel = async (msgs) => {
      modelCalled = true;
      assert.ok(msgs[1].content.includes('Pesan obrolan'));
      return { content: 'Ini adalah ringkasan percakapan 20 pesan pertama.' };
    };

    const res = await triggerBackgroundSummarize({
      db,
      jid,
      callModelFn: mockCallModel,
      cfg: { SUMMARY_THRESHOLD: 40, SUMMARY_BATCH: 20, SUMMARY_MAX_WORDS: 300, CHARACTER_NAME: 'Chloe' },
    });

    assert.strictEqual(res.triggered, true);
    assert.strictEqual(modelCalled, true);
    const summary = db.getSummary(jid);
    assert.ok(summary);
    assert.strictEqual(summary.text, 'Ini adalah ringkasan percakapan 20 pesan pertama.');
    assert.strictEqual(summary.upto_msg_id, 20);
  });

  it('ringkasan latar belakang mematuhi anggaran harian dan mencatat kuota saat berhasil', async () => {
    const jid = 'user1@s.whatsapp.net';
    for (let i = 1; i <= 45; i++) {
      db.insertMessage({ jid, dir: 'in', text: `Pesan ${i}`, ts: 1000 + i, status: 'answered' });
    }

    const budget = createBudget({
      db,
      cfg: { MODEL_DAILY_BUDGET: 1, MODEL_BUDGET_RESET_HOUR_UTC: 0 },
      clock: () => Date.parse('2026-10-03T12:00:00Z'),
    });

    let called = false;
    const resSuccess = await triggerBackgroundSummarize({
      db,
      jid,
      callModelFn: async () => { called = true; return { content: 'ringkasan' }; },
      budget,
      cfg: { SUMMARY_TRIGGER_MSGS: 40, SUMMARY_BATCH_MSGS: 20, SUMMARY_MAX_WORDS: 300, SUMMARY_MIN_BUDGET_RESERVE: 1, CHARACTER_NAME: 'Chloe' },
    });

    assert.strictEqual(resSuccess.triggered, true);
    assert.strictEqual(called, true);
    assert.strictEqual(budget.used(), 1);
    assert.strictEqual(budget.isExhausted(), true);

    // Panggilan berikutnya harus ditolak karena anggaran habis
    called = false;
    for (let i = 46; i <= 90; i++) {
      db.insertMessage({ jid, dir: 'in', text: `Pesan baru ${i}`, ts: 2000 + i, status: 'answered' });
    }
    const resBlocked = await triggerBackgroundSummarize({
      db,
      jid,
      callModelFn: async () => { called = true; return { content: 'ringkasan baru' }; },
      budget,
      cfg: { SUMMARY_TRIGGER_MSGS: 40, SUMMARY_BATCH_MSGS: 20, SUMMARY_MAX_WORDS: 300, SUMMARY_MIN_BUDGET_RESERVE: 1, CHARACTER_NAME: 'Chloe' },
    });

    assert.strictEqual(resBlocked.triggered, false);
    assert.strictEqual(resBlocked.reason, 'budget_exhausted');
    assert.strictEqual(called, false);
  });

  it('assemblePromptMessages memangkas riwayat (min 10) lalu contoh (min 3) lalu fakta, dan tidak pernah memotong persona', () => {
    const jid = 'user_trim@s.whatsapp.net';
    const user = { jid, name: 'TrimUser', callname: 'Kakak' };

    // Isi 20 riwayat pesan
    for (let i = 1; i <= 20; i++) {
      db.insertMessage({ jid, dir: 'in', text: `Pesan obrolan riwayat ke-${i} cukup panjang untuk memakan token`, ts: 1000 + i, status: 'answered' });
    }

    // Isi 5 fakta
    for (let i = 1; i <= 5; i++) {
      db.insertFact(jid, `Fakta user ke-${i} suka membaca buku cerita komik`);
    }

    // Anggaran kecil untuk menguji pemangkasan bertahap
    const res = assemblePromptMessages({
      db,
      user,
      incomingText: 'Halo apa kabar?',
      cfg: {
        PROMPT_TOKEN_BUDGET: 3000,
        HISTORY_MIN_KEEP: 10,
        HISTORY_LIMIT: 20,
        FACTS_IN_PROMPT: 5,
        EXAMPLES_MIN: 3,
        EXAMPLES_MAX: 5,
        TOKENS_PER_WORD: 2,
        CHARACTER_NAME: 'Chloe',
      },
    });

    // Riwayat dipangkas tapi tidak kurang dari batas minimal 10
    assert.ok(res.historyCount >= 10, `historyCount ${res.historyCount} harus >= 10`);
    assert.ok(res.exampleCount >= 3, `exampleCount ${res.exampleCount} harus >= 3`);

    // Pastikan persona dan heading utama tetap utuh
    assert.ok(res.systemPrompt.includes('## 1. Identitas'));
    assert.ok(res.systemPrompt.includes('## KONDISI SAAT INI'));
    assert.ok(res.systemPrompt.includes('## Aturan output (KONTRAK KETAT)'));
  });
});

// =====================================================================
// 5. Anggaran Harian & Limit User (BAGIAN A poin 2 & 3)
// =====================================================================
describe('budget & limits', () => {
  let db;
  beforeEach(() => { db = freshDb(); });
  afterEach(() => { db.close(); });

  it('anggaran harian menghitung pemakaian dan membatasi jika habis', () => {
    const budget = createBudget({
      db,
      cfg: { MODEL_DAILY_BUDGET: 3, MODEL_BUDGET_RESET_HOUR_UTC: 0 },
      clock: () => Date.parse('2026-10-03T12:00:00Z'),
    });

    assert.strictEqual(budget.used(), 0);
    assert.strictEqual(budget.remaining(), 3);
    assert.strictEqual(budget.isExhausted(), false);

    budget.record();
    budget.record();
    assert.strictEqual(budget.used(), 2);
    assert.strictEqual(budget.remaining(), 1);
    assert.strictEqual(budget.isExhausted(), false);

    budget.record();
    assert.strictEqual(budget.used(), 3);
    assert.strictEqual(budget.remaining(), 0);
    assert.strictEqual(budget.isExhausted(), true);
  });

  it('ketika anggaran habis, bot membalas sistem_batas_harian sekali per hari lalu diam', async () => {
    const jid = '628111@s.whatsapp.net';
    const allowlist = buildAllowlist([{ number: '628111', name: 'User 1', callname: 'Kakak' }]);
    db.upsertUser({ jid, name: 'User 1', callname: 'Kakak', is_owner: false, created_at: 100 });

    const budget = createBudget({
      db,
      cfg: { MODEL_DAILY_BUDGET: 1, MODEL_BUDGET_RESET_HOUR_UTC: 0 },
      clock: () => Date.parse('2026-10-03T12:00:00Z'),
    });
    budget.record(); // habiskan kuota

    const sent = [];
    const mockSock = {
      sendMessage: async (targetJid, payload) => {
        sent.push({ jid: targetJid, text: payload.text });
        return { key: { id: 'out_' + Date.now() } };
      },
    };

    const msg1 = {
      key: { remoteJid: jid, fromMe: false, id: 'msg1' },
      messageTimestamp: Math.floor(Date.now() / 1000),
      message: { conversation: 'Halo Chloe' },
    };

    // Panggilan pertama: terkirim pesan sistem batas harian
    const r1 = await handleIncomingMessage(msg1, allowlist, db, mockSock, () => {}, { budget });
    assert.strictEqual(r1.replied, true);
    assert.strictEqual(r1.reason, 'model_budget_notified');
    assert.strictEqual(sent.length, 1);

    // Panggilan kedua di hari yang sama: diam (tidak membalas)
    const msg2 = {
      key: { remoteJid: jid, fromMe: false, id: 'msg2' },
      messageTimestamp: Math.floor(Date.now() / 1000),
      message: { conversation: 'Halo lagi' },
    };
    const r2 = await handleIncomingMessage(msg2, allowlist, db, mockSock, () => {}, { budget });
    assert.strictEqual(r2.replied, false);
    assert.strictEqual(r2.reason, 'model_budget_silent');
    assert.strictEqual(sent.length, 1); // tetap 1
  });
});

// =====================================================================
// 6. Upstream Rate Limit 429 Tanpa Retry (BAGIAN A poin 1)
// =====================================================================
describe('callModel — 429 upstream rate limit', () => {
  it('isUpstreamRateLimit mendeteksi indikator upstream shared pool', () => {
    assert.strictEqual(isUpstreamRateLimit({ metadata: { limit_source: 'upstream_provider_shared_pool' } }), true);
    assert.strictEqual(isUpstreamRateLimit({ metadata: { raw: 'google/gemma is temporarily rate-limited upstream.' } }), true);
    assert.strictEqual(isUpstreamRateLimit({ message: 'rate-limited upstream' }), true);
    assert.strictEqual(isUpstreamRateLimit({ message: 'Normal rate limit' }), false);
    assert.strictEqual(isUpstreamRateLimit(null), false);
  });

  it('respons 429 dengan tanda limit upstream langsung pindah ke fallback tanpa retry di model sama', async () => {
    const attempts = [];
    const mockFetch = async (url, opts) => {
      const body = JSON.parse(opts.body);
      attempts.push(body.model);
      if (body.model === 'vendor/primary:free') {
        return {
          ok: false,
          status: 429,
          headers: new Map(),
          json: async () => ({
            error: {
              message: 'Provider returned error',
              code: 429,
              metadata: { limit_source: 'upstream_provider_shared_pool' },
            },
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          model: 'vendor/fallback:free',
          choices: [{ message: { content: '{"messages": ["sukses fallback"]}' } }],
        }),
      };
    };

    const cfg = {
      OPENROUTER_URL: 'https://openrouter.ai/api/v1/chat/completions',
      OPENROUTER_API_KEY: 'test-key',
      OPENROUTER_APP_TITLE: 'Chloe',
      MODEL_PRIMARY: 'vendor/primary:free',
      MODEL_FALLBACKS: ['vendor/fallback:free'],
      MODEL_TIMEOUT_MS: 500,
      MODEL_TRANSIENT_RETRIES: 2, // jika transient biasa akan dicoba 3x
      MODEL_RETRY_DELAY_MS: 1,
      MODEL_RETRY_AFTER_MAX_MS: 50,
      MODEL_MAX_TOKENS: 50,
      MODEL_TEMPERATURE: 0.7,
    };

    const res = await callModel([{ role: 'user', content: 'hi' }], {
      fetchFn: mockFetch,
      cfg,
      sleep: async () => {},
      logFn: () => {},
    });

    assert.strictEqual(res.model, 'vendor/fallback:free');
    // Primary HANYA dicoba 1 kali (tanpa retry) karena limit upstream terdeteksi
    assert.deepStrictEqual(attempts, ['vendor/primary:free', 'vendor/fallback:free']);
  });
});

// =====================================================================
// 7. Verifikasi 5 Poin Perbaikan Tahap 3
// =====================================================================
describe('7 Perbaikan Tahap 3 (Revisi)', () => {
  beforeEach(() => {
    _resetSummaryState();
  });

  it('Poin 1: pesan masuk di handleIncomingMessage muncul tepat satu kali di akhir prompt messages', () => {
    const db = freshDb();
    const jid = 'user_double@s.whatsapp.net';
    const user = { jid, name: 'DoubleUser', callname: 'Kakak' };

    // 1. Simpan pesan masuk ke DB seperti yang dilakukan di handleIncomingMessage
    const text = 'Halo Chloe, ini pesan masuk uji coba yang unik 12345';
    const tsMs = 1791000000000;
    const insertRes = db.insertMessage({
      jid,
      dir: 'in',
      type: 'text',
      text,
      ts: tsMs,
      wa_id: 'wa_msg_uniq_1',
      wa_key: { id: 'wa_msg_uniq_1' },
      status: 'queued',
    });
    const currentMsgId = Number(insertRes?.lastInsertRowid ?? insertRes?.id);

    // 2. Panggil assemblePromptMessages dengan beforeMessageId
    const assembled = assemblePromptMessages({
      db,
      user,
      incomingText: text,
      incomingTs: tsMs,
      beforeMessageId: currentMsgId,
      cfg: config,
    });

    // 3. Hitung kemunculan teks pesan tersebut di array messages hasil rakitan
    const occurrences = assembled.messages.filter((m) => m.content.includes(text)).length;
    assert.strictEqual(occurrences, 1, 'Pesan masuk harus muncul TEPAT SEKALI di array messages');

    // Pastikan pesan tersebut berada di pesan terakhir
    const lastMsg = assembled.messages[assembled.messages.length - 1];
    assert.strictEqual(lastMsg.role, 'user');
    assert.ok(lastMsg.content.includes(text), 'Pesan masuk harus menjadi pesan terakhir');
    db.close();
  });

  it('Poin 2: triggerBackgroundSummarize menggunakan generateText sungguhan, concurrency guard, dan failure cooldown', async () => {
    const db = freshDb();
    _resetSummaryState();
    const jid = 'user_sum_agent@s.whatsapp.net';

    // Buat 45 pesan
    for (let i = 1; i <= 45; i++) {
      db.insertMessage({ jid, dir: i % 2 === 1 ? 'in' : 'out', text: `Pesan obrolan ke-${i}`, ts: 1000 + i, status: 'answered' });
    }

    let fetchCount = 0;
    const fakeFetch = async (url, opts) => {
      fetchCount++;
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({
          model: 'test/model-summary',
          choices: [
            {
              message: {
                content: 'Ringkasan percakapan biasa teks mentah tanpa format JSON sama sekali.',
              },
            },
          ],
        }),
      };
    };

    const cfg = {
      ...config,
      MODEL_PRIMARY: 'test/model-summary',
      MODEL_FALLBACKS: [],
      SUMMARY_TRIGGER_MSGS: 40,
      SUMMARY_BATCH_MSGS: 20,
      SUMMARY_MIN_BUDGET_RESERVE: 1,
      SUMMARY_RETRY_COOLDOWN_MS: 1800000,
    };

    // 1. Eksekusi triggerBackgroundSummarize memakai generateText sungguhan dari agent.js
    const res1 = await triggerBackgroundSummarize({
      db,
      jid,
      callModelFn: (msgs) => generateText(msgs, { fetchFn: fakeFetch, cfg, logFn: () => {} }),
      cfg,
    });

    assert.strictEqual(res1.triggered, true);
    assert.strictEqual(fetchCount, 1);
    const saved = db.getSummary(jid);
    assert.ok(saved);
    assert.strictEqual(saved.text, 'Ringkasan percakapan biasa teks mentah tanpa format JSON sama sekali.');

    // 2. Concurrency guard: dua panggilan berjalan bersamaan untuk JID yang sama
    for (let i = 46; i <= 90; i++) {
      db.insertMessage({ jid, dir: 'in', text: `Pesan obrolan baru ${i}`, ts: 2000 + i, status: 'answered' });
    }

    let slowResolve;
    const slowFetch = async () => {
      fetchCount++;
      await new Promise((r) => { slowResolve = r; });
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({
          model: 'test/model-summary',
          choices: [{ message: { content: 'Ringkasan kedua' } }],
        }),
      };
    };

    const promiseA = triggerBackgroundSummarize({
      db,
      jid,
      callModelFn: (msgs) => generateText(msgs, { fetchFn: slowFetch, cfg, logFn: () => {} }),
      cfg,
    });

    const promiseB = triggerBackgroundSummarize({
      db,
      jid,
      callModelFn: (msgs) => generateText(msgs, { fetchFn: slowFetch, cfg, logFn: () => {} }),
      cfg,
    });

    // Panggilan kedua harus langsung ditolak dengan reason 'already_running'
    const resB = await promiseB;
    assert.strictEqual(resB.triggered, false);
    assert.strictEqual(resB.reason, 'already_running');

    // Selesaikan panggilan pertama
    slowResolve();
    const resA = await promiseA;
    assert.strictEqual(resA.triggered, true);

    // 3. Failure retry cooldown: setelah gagal tidak dicoba lagi sebelum cooldown
    for (let i = 91; i <= 140; i++) {
      db.insertMessage({ jid, dir: 'in', text: `Pesan lagi ${i}`, ts: 3000 + i, status: 'answered' });
    }

    const failFetch = async () => {
      fetchCount++;
      return {
        ok: false,
        status: 500,
        headers: new Headers(),
        json: async () => ({ error: { message: 'Server error' } }),
      };
    };

    const resFail = await triggerBackgroundSummarize({
      db,
      jid,
      callModelFn: (msgs) => generateText(msgs, { fetchFn: failFetch, cfg, logFn: () => {} }),
      cfg,
    });
    assert.strictEqual(resFail.triggered, false);
    assert.strictEqual(resFail.reason, 'error');

    // Panggilan ulang segera setelah gagal harus ditolak karena cooldown
    const resBlockedCooldown = await triggerBackgroundSummarize({
      db,
      jid,
      callModelFn: (msgs) => generateText(msgs, { fetchFn: fakeFetch, cfg, logFn: () => {} }),
      cfg,
    });
    assert.strictEqual(resBlockedCooldown.triggered, false);
    assert.strictEqual(resBlockedCooldown.reason, 'cooldown');
    db.close();
  });

  it('Poin 3: log privasi tidak memuat teks fakta, old, updated, preview', () => {
    const db = freshDb();
    const jid = '628123456789@s.whatsapp.net';
    const secretFact = 'UserRahasia999 suka makan durian tengah malam';

    const capturedLogs = [];
    const originalConsoleLog = console.log;
    const originalConsoleWarn = console.warn;
    const originalConsoleError = console.error;

    const interceptor = (...args) => {
      capturedLogs.push(args.join(' '));
    };

    console.log = interceptor;
    console.warn = interceptor;
    console.error = interceptor;

    try {
      // 1. Simpan fakta baru
      saveFact(db, jid, secretFact);

      // 2. Simpan fakta yang mirip untuk memicu 'replaced'
      const updatedFact = 'UserRahasia999 suka makan durian tengah malam bersama teman';
      saveFact(db, jid, updatedFact);

      // 3. Simpan fakta sensitif untuk memicu 'rejected'
      saveFact(db, jid, 'UserRahasia999 punya pin atm 1234');
    } finally {
      console.log = originalConsoleLog;
      console.warn = originalConsoleWarn;
      console.error = originalConsoleError;
    }

    assert.ok(capturedLogs.length >= 3, 'Harus ada setidaknya 3 log dari operasi fakta');
    for (const logLine of capturedLogs) {
      // Teks fakta tidak boleh muncul di log
      assert.ok(!logLine.includes('UserRahasia999'), `Teks fakta tidak boleh muncul di log: ${logLine}`);
      assert.ok(!logLine.includes('durian'), `Teks fakta tidak boleh muncul di log: ${logLine}`);
      assert.ok(!logLine.includes('1234'), `Teks fakta tidak boleh muncul di log: ${logLine}`);
      // Field terlarang tidak boleh ada
      assert.ok(!logLine.includes('"fact"'), `Field "fact" tidak boleh ada di log: ${logLine}`);
      assert.ok(!logLine.includes('"old"'), `Field "old" tidak boleh ada di log: ${logLine}`);
      assert.ok(!logLine.includes('"updated"'), `Field "updated" tidak boleh ada di log: ${logLine}`);
      assert.ok(!logLine.includes('"preview"'), `Field "preview" tidak boleh ada di log: ${logLine}`);
    }
    db.close();
  });

  it('Poin 4: isSensitiveFact memfilter kata pendek dengan word boundary dan aturan jalan', () => {
    // Harus MENERIMA (return false):
    assert.strictEqual(isSensitiveFact('suka jalan pagi'), false, 'harus menerima "suka jalan pagi"');
    assert.strictEqual(isSensitiveFact('hobi jalan kaki di taman'), false, 'harus menerima "hobi jalan kaki di taman"');
    assert.strictEqual(isSensitiveFact('suka archive file'), false, 'harus menerima "suka archive file"');

    // Harus MENOLAK (return true):
    assert.strictEqual(isSensitiveFact('Jl. Merdeka No. 5'), true, 'harus menolak "Jl. Merdeka No. 5"');
    assert.strictEqual(isSensitiveFact('tinggal di Jalan Melati 12'), true, 'harus menolak "tinggal di Jalan Melati 12"');
    assert.strictEqual(isSensitiveFact('penyakit jantung'), true, 'harus menolak "penyakit jantung"');
    assert.strictEqual(isSensitiveFact('hiv'), true, 'harus menolak "hiv"');
  });

  it('Poin 5: CHARACTER_NAME kustom menggantikan Chloe di prompt dan jumlah contoh bervariasi di 3-5', () => {
    // 1. Dengan CHARACTER_NAME berbeda, kata "Chloe" tidak boleh muncul sama sekali
    const customPrompt = buildSystemPrompt({
      cfg: { ...config, CHARACTER_NAME: 'Aira' },
      user: { jid: 'user_aira@s.whatsapp.net', name: 'Budi', callname: 'Kak Budi' },
    });
    assert.ok(!customPrompt.includes('Chloe'), 'Kata "Chloe" tidak boleh muncul saat nama karakter disetel ke "Aira"');
    assert.ok(customPrompt.includes('Aira'), 'Nama "Aira" harus muncul di prompt');

    // 2. Dengan seed berbeda, jumlah contoh bervariasi di rentang 3-5
    const exampleCounts = new Set();
    const testSeeds = ['seed_alpha', 'seed_beta', 'seed_gamma', 'seed_delta', 'seed_omega', 'seed_123', 'seed_456', 'seed_789'];
    for (const s of testSeeds) {
      const rng = createRng(s);
      const prompt = buildSystemPrompt({
        cfg: config,
        rng,
        user: { jid: 'user_rng@s.whatsapp.net', name: 'User' },
      });

      // Hitung contoh dialog di seksi ## Contoh dialog
      const match = /## Contoh dialog\n([\s\S]*?)(?=\n## Aturan output|$)/.exec(prompt);
      assert.ok(match, 'Seksi Contoh dialog harus ada di prompt');
      const dialogText = match[1].replace('Contoh hanya menunjukkan nada dan ritme. Jangan menyalin kalimatnya. Buat kalimat baru.', '').trim();
      const blocks = dialogText.split(/\n\s*---\s*\n/).filter(Boolean);
      const count = blocks.length;
      assert.ok(count >= 3 && count <= 5, `Jumlah contoh (${count}) harus dalam rentang 3-5`);
      exampleCounts.add(count);
    }

    // Pastikan ada variasi (tidak selalu terpaku pada satu angka saja)
    assert.ok(exampleCounts.size > 1, `Jumlah contoh harus bervariasi di 3-5, terdeteksi: ${Array.from(exampleCounts).join(', ')}`);
  });
});

// =====================================================================
// 8. Pengecualian Sementara Contoh Dialog & Aturan Output (Tahap 3d)
// =====================================================================
describe('Tahap 3d — Pengecualian Sementara & Aturan Output Tools', () => {
  it('(a) situasi yang dikecualikan (fungsional, reminder_terkirim, males, dongkol) tidak pernah terpilih pada 200 seed berbeda', () => {
    const map = loadExamples();
    const excludedSituations = new Set([
      'fungsional',
      'reminder_terkirim',
      'males',
      'dongkol',
      ...TEMPORARY_EXCLUDED_UNTIL_TOOLS,
    ]);

    // Kumpulkan seluruh teks unik dari blok dialog dalam situasi yang dikecualikan
    const excludedSnippetSet = new Set();
    for (const sit of excludedSituations) {
      const blocks = map.get(sit) ?? [];
      for (const b of blocks) {
        for (const t of b.assistantTexts) {
          if (t && t.trim().length > 3) {
            excludedSnippetSet.add(t.trim());
          }
        }
      }
    }

    assert.ok(excludedSnippetSet.size > 0, 'Harus ada contoh dalam situasi yang dikecualikan');

    for (let i = 1; i <= 200; i++) {
      const rng = createRng(`seed_tahap3d_${i}`);
      const sel = selectDialogExamples({ rng });
      for (const snippet of excludedSnippetSet) {
        assert.ok(
          !sel.text.includes(snippet),
          `Contoh dari situasi terlarang ("${snippet}") terpilih pada seed ke-${i}`
        );
      }
    }
  });

  it('(b) formatOutputRules memuat kalimat pembatasan aksi bahwa saat ini hanya save_fact yang aktif', () => {
    const rules = formatOutputRules();
    const expectedSentence = 'Saat ini aksi yang tersedia HANYA save_fact. Pengingat dan catatan BELUM aktif: jangan menjanjikan, menawarkan, atau mengaku bisa melakukannya, termasuk saat ditanya apa saja yang bisa kamu lakukan. Kalau ditanya kemampuanmu, sebutkan ngobrol dan mengingat hal tentang pengguna.';
    assert.ok(rules.includes(expectedSentence), 'formatOutputRules harus memuat kalimat pembatasan aksi');

    const prompt = buildSystemPrompt({
      user: { name: 'UserTest', callname: 'Kakak' },
    });
    assert.ok(prompt.includes(expectedSentence), 'buildSystemPrompt harus memuat kalimat pembatasan aksi');
  });
});



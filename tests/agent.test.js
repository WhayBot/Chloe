// tests/agent.test.js — tes unit OpenRouter caller, fallback model, retry 429, timeout, dan parser JSON toleran
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  stripFences,
  repairJson,
  parseModelOutput,
  validateModelConfig,
  getModelChain,
  classifyStatus,
  parseRetryAfter,
  callModel,
  generateReply,
  ModelError,
  TEMP_SYSTEM_PROMPT,
  resolveReasoningParam,
  looksLikeJson,
  salvageTruncatedMessages,
  resolveProviderParam,
  isDataPolicyError,
} from '../src/agent.js';
import { collectConfigErrors } from '../src/index.js';
import { formatOutputRules } from '../src/prompt.js';
import { parseCliArgs } from '../scripts/try-model.js';

// =====================================================================
// 1. Parser JSON Toleran (SPEC §7)
// =====================================================================
describe('stripFences', () => {
  it('menghapus pagar ```json ... ```', () => {
    const raw = '```json\n{"messages": ["halo"]}\n```';
    assert.strictEqual(stripFences(raw), '{"messages": ["halo"]}');
  });

  it('menghapus pagar tanpa tag bahasa', () => {
    const raw = '```\n{"messages": ["halo"]}\n```';
    assert.strictEqual(stripFences(raw), '{"messages": ["halo"]}');
  });

  it('teks biasa tanpa pagar tidak berubah', () => {
    const raw = '{"messages": ["halo"]}';
    assert.strictEqual(stripFences(raw), '{"messages": ["halo"]}');
  });
});

describe('repairJson', () => {
  it('membuang trailing comma sebelum } atau ]', () => {
    const bad = '{"messages": ["a", "b",], "reaction": null,}';
    assert.strictEqual(repairJson(bad), '{"messages": ["a", "b"], "reaction": null}');
  });
});

describe('parseModelOutput', () => {
  const dummyCfg = { MAX_MESSAGES_PER_REPLY: 4 };

  it('JSON valid standar → mode json', () => {
    const raw = JSON.stringify({
      messages: ['halo kak!', 'lagi apa?'],
      reaction: '👋',
      mood: 'ceria',
      serious: false,
      actions: [],
      query: null,
    });
    const res = parseModelOutput(raw, dummyCfg);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.mode, 'json');
    assert.deepStrictEqual(res.messages, ['halo kak!', 'lagi apa?']);
    assert.strictEqual(res.reaction, '👋');
    assert.deepStrictEqual(res.mood, { name: 'ceria', delta: 0, reason: '' });
    assert.strictEqual(res.serious, false);
  });

  it('JSON di dalam pagar markdown ```json → dibaca benar', () => {
    const raw = '```json\n{"messages": ["santai aja"]}\n```';
    const res = parseModelOutput(raw, dummyCfg);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.mode, 'json');
    assert.deepStrictEqual(res.messages, ['santai aja']);
  });

  it('JSON dengan trailing comma → mode repaired', () => {
    const raw = '{"messages": ["oke",],}';
    const res = parseModelOutput(raw, dummyCfg);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.mode, 'repaired');
    assert.deepStrictEqual(res.messages, ['oke']);
  });

  it('JSON tertanam di dalam penjelasan teks bebas → diekstrak', () => {
    const raw = 'Tentu, ini balasannya:\n{"messages": ["iya dong"]}\nSemoga membantu!';
    const res = parseModelOutput(raw, dummyCfg);
    assert.strictEqual(res.ok, true);
    assert.deepStrictEqual(res.messages, ['iya dong']);
  });

  it('Bukan JSON (teks mentah) → fallback mode raw menjadi 1 pesan', () => {
    const raw = 'Aku lagi dengerin lagu nih, santai.';
    const res = parseModelOutput(raw, dummyCfg);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.mode, 'raw');
    assert.deepStrictEqual(res.messages, ['Aku lagi dengerin lagu nih, santai.']);
  });

  it('Toleransi alternatif key (message/reply/text) jika messages bukan array', () => {
    const r1 = parseModelOutput('{"reply": "halo"}', dummyCfg);
    assert.deepStrictEqual(r1.messages, ['halo']);

    const r2 = parseModelOutput('{"message": "hai"}', dummyCfg);
    assert.deepStrictEqual(r2.messages, ['hai']);

    const r3 = parseModelOutput('{"text": "yo"}', dummyCfg);
    assert.deepStrictEqual(r3.messages, ['yo']);
  });

  it('messages melebihi batas (maks 4) → dipotong dan digabung ke pesan ke-4', () => {
    const raw = JSON.stringify({
      messages: ['pesan 1', 'pesan 2', 'pesan 3', 'pesan 4', 'pesan 5', 'pesan 6'],
    });
    const res = parseModelOutput(raw, dummyCfg);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.truncated, true);
    assert.strictEqual(res.messages.length, 4);
    assert.strictEqual(res.messages[0], 'pesan 1');
    assert.strictEqual(res.messages[1], 'pesan 2');
    assert.strictEqual(res.messages[2], 'pesan 3');
    assert.strictEqual(res.messages[3], 'pesan 4\npesan 5\npesan 6');
  });

  it('Output kosong total → ok: false', () => {
    const res = parseModelOutput('   ', dummyCfg);
    assert.strictEqual(res.ok, false);
    assert.deepStrictEqual(res.messages, []);
  });
});

// =====================================================================
// 2. Validasi Konfigurasi & Model Chain
// =====================================================================
describe('validateModelConfig & getModelChain', () => {
  it('getModelChain menggabungkan primary dan fallbacks tanpa duplikat', () => {
    const cfg = {
      MODEL_PRIMARY: 'vendor/model-a:free',
      MODEL_FALLBACKS: ['vendor/model-b:free', 'vendor/model-a:free', 'vendor/model-c:free'],
    };
    assert.deepStrictEqual(getModelChain(cfg), [
      'vendor/model-a:free',
      'vendor/model-b:free',
      'vendor/model-c:free',
    ]);
  });

  it('OPENROUTER_API_KEY kosong → error validasi', () => {
    const cfg = { OPENROUTER_API_KEY: '', MODEL_PRIMARY: 'vendor/model:free' };
    const { errors } = validateModelConfig(cfg);
    assert.ok(errors.some((e) => e.includes('OPENROUTER_API_KEY')));
  });

  it('MODEL_PRIMARY kosong → error validasi', () => {
    const cfg = { OPENROUTER_API_KEY: 'test-key', MODEL_PRIMARY: '' };
    const { errors } = validateModelConfig(cfg);
    assert.ok(errors.some((e) => e.includes('MODEL_PRIMARY')));
  });

  it('format model tidak valid (tanpa vendor/name) → error', () => {
    const cfg = { OPENROUTER_API_KEY: 'test-key', MODEL_PRIMARY: 'model-tanpa-vendor' };
    const { errors } = validateModelConfig(cfg);
    assert.ok(errors.some((e) => e.includes('tidak valid')));
  });

  it('model non-:free memberikan peringatan (warning)', () => {
    const cfg = { OPENROUTER_API_KEY: 'test-key', MODEL_PRIMARY: 'openai/gpt-4o' };
    const { errors, warnings } = validateModelConfig(cfg);
    assert.strictEqual(errors.length, 0);
    assert.ok(warnings.some((w) => w.includes('bukan varian :free')));
  });
});

// =====================================================================
// 3. Retry-After & Status Classification
// =====================================================================
describe('parseRetryAfter & classifyStatus', () => {
  it('parseRetryAfter detik angka → milidetik', () => {
    assert.strictEqual(parseRetryAfter('5'), 5000);
    assert.strictEqual(parseRetryAfter('0'), 0);
    assert.strictEqual(parseRetryAfter(null), null);
    assert.strictEqual(parseRetryAfter(''), null);
  });

  it('parseRetryAfter tanggal HTTP', () => {
    const now = 1_000_000;
    const future = new Date(now + 7000).toUTCString();
    assert.strictEqual(parseRetryAfter(future, now), 7000);
  });

  it('classifyStatus membedakan auth, transient, dan model', () => {
    assert.strictEqual(classifyStatus(401), 'auth');
    assert.strictEqual(classifyStatus(429), 'transient');
    assert.strictEqual(classifyStatus(500), 'transient');
    assert.strictEqual(classifyStatus(503), 'transient');
    assert.strictEqual(classifyStatus(404), 'model');
    assert.strictEqual(classifyStatus(400), 'model');
  });
});

// =====================================================================
// 4. callModel dengan Mock fetch
// =====================================================================
describe('callModel — mock fetch', () => {
  const baseCfg = {
    OPENROUTER_URL: 'https://openrouter.ai/api/v1/chat/completions',
    OPENROUTER_API_KEY: 'sk-or-test-mock-key',
    OPENROUTER_APP_TITLE: 'Chloe-Test',
    MODEL_PRIMARY: 'vendor/primary:free',
    MODEL_FALLBACKS: ['vendor/fallback:free'],
    MODEL_TIMEOUT_MS: 500,
    MODEL_TRANSIENT_RETRIES: 1,
    MODEL_RETRY_DELAY_MS: 5,
    MODEL_RETRY_AFTER_MAX_MS: 50,
    MODEL_MAX_TOKENS: 100,
    MODEL_TEMPERATURE: 0.7,
  };

  const noopLog = () => {};
  const noopSleep = async () => {};

  it('Primary model berhasil pada percobaan pertama', async () => {
    const mockFetch = async (url, opts) => {
      assert.strictEqual(opts.headers.Authorization, 'Bearer sk-or-test-mock-key');
      const body = JSON.parse(opts.body);
      assert.strictEqual(body.model, 'vendor/primary:free');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          model: 'vendor/primary:free',
          choices: [{ message: { content: '{"messages": ["halo dari primary"]}' } }],
          usage: { total_tokens: 25 },
        }),
      };
    };

    const res = await callModel([{ role: 'user', content: 'tes' }], {
      fetchFn: mockFetch,
      cfg: baseCfg,
      sleep: noopSleep,
      logFn: noopLog,
    });

    assert.strictEqual(res.model, 'vendor/primary:free');
    assert.strictEqual(res.content, '{"messages": ["halo dari primary"]}');
    assert.strictEqual(res.attempts.length, 1);
    assert.strictEqual(res.attempts[0].status, 200);
  });

  it('Fallback model saat primary model error permanen (404/400)', async () => {
    const calls = [];
    const mockFetch = async (url, opts) => {
      const body = JSON.parse(opts.body);
      calls.push(body.model);
      if (body.model === 'vendor/primary:free') {
        return {
          ok: false,
          status: 404,
          statusText: 'Model Not Found',
          json: async () => ({ error: { message: 'No such model' } }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          model: 'vendor/fallback:free',
          choices: [{ message: { content: '{"messages": ["halo dari fallback"]}' } }],
        }),
      };
    };

    const res = await callModel([{ role: 'user', content: 'tes' }], {
      fetchFn: mockFetch,
      cfg: baseCfg,
      sleep: noopSleep,
      logFn: noopLog,
    });

    assert.strictEqual(res.model, 'vendor/fallback:free');
    assert.deepStrictEqual(calls, ['vendor/primary:free', 'vendor/fallback:free']);
    assert.strictEqual(res.attempts.length, 2);
    assert.strictEqual(res.attempts[0].status, 404);
    assert.strictEqual(res.attempts[1].status, 200);
  });

  it('Retry 429 di model yang sama lalu berhasil', async () => {
    let attempts = 0;
    const sleeps = [];
    const mockSleep = async (ms) => sleeps.push(ms);

    const mockFetch = async () => {
      attempts++;
      if (attempts === 1) {
        return {
          ok: false,
          status: 429,
          headers: new Map([['retry-after', '0.02']]),
          json: async () => ({ error: { message: 'Rate limited' } }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          model: 'vendor/primary:free',
          choices: [{ message: { content: '{"messages": ["lolos setelah 429"]}' } }],
        }),
      };
    };

    const res = await callModel([{ role: 'user', content: 'tes' }], {
      fetchFn: mockFetch,
      cfg: baseCfg,
      sleep: mockSleep,
      logFn: noopLog,
    });

    assert.strictEqual(res.model, 'vendor/primary:free');
    assert.strictEqual(attempts, 2);
    assert.deepStrictEqual(sleeps, [20]);
    assert.strictEqual(res.attempts.length, 2);
    assert.strictEqual(res.attempts[0].status, 429);
    assert.strictEqual(res.attempts[1].status, 200);
  });

  it('429 dengan Retry-After terlalu lama (> MAX_MS) → langsung pindah ke fallback tanpa tunggu', async () => {
    const calls = [];
    const sleeps = [];
    const mockSleep = async (ms) => sleeps.push(ms);

    const mockFetch = async (url, opts) => {
      const body = JSON.parse(opts.body);
      calls.push(body.model);
      if (body.model === 'vendor/primary:free') {
        return {
          ok: false,
          status: 429,
          headers: new Map([['retry-after', '120']]), // 120 dtk > MODEL_RETRY_AFTER_MAX_MS (50ms)
          json: async () => ({ error: { message: 'Rate limited 120s' } }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          model: 'vendor/fallback:free',
          choices: [{ message: { content: '{"messages": ["langsung fallback"]}' } }],
        }),
      };
    };

    const res = await callModel([{ role: 'user', content: 'tes' }], {
      fetchFn: mockFetch,
      cfg: baseCfg,
      sleep: mockSleep,
      logFn: noopLog,
    });

    assert.strictEqual(res.model, 'vendor/fallback:free');
    assert.strictEqual(sleeps.length, 0); // tidak tidur lama
    assert.deepStrictEqual(calls, ['vendor/primary:free', 'vendor/fallback:free']);
  });

  it('Timeout request ditangani sebagai transient dan pindah ke fallback', async () => {
    const calls = [];
    const mockFetch = async (url, opts) => {
      const body = JSON.parse(opts.body);
      calls.push(body.model);
      if (body.model === 'vendor/primary:free') {
        const err = new Error('The operation was aborted');
        err.name = 'TimeoutError';
        throw err;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          model: 'vendor/fallback:free',
          choices: [{ message: { content: '{"messages": ["ok setelah timeout"]}' } }],
        }),
      };
    };

    const res = await callModel([{ role: 'user', content: 'tes' }], {
      fetchFn: mockFetch,
      cfg: baseCfg,
      sleep: noopSleep,
      logFn: noopLog,
    });

    assert.strictEqual(res.model, 'vendor/fallback:free');
    // primary dicoba 2x (1 awal + 1 transient retry) lalu fallback 1x
    assert.deepStrictEqual(calls, [
      'vendor/primary:free',
      'vendor/primary:free',
      'vendor/fallback:free',
    ]);
  });

  it('401 Unauthorized → langsung melempar ModelError auth tanpa mencoba model lain', async () => {
    let callCount = 0;
    const mockFetch = async () => {
      callCount++;
      return {
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        json: async () => ({ error: { message: 'Invalid API key' } }),
      };
    };

    await assert.rejects(
      async () => {
        await callModel([{ role: 'user', content: 'tes' }], {
          fetchFn: mockFetch,
          cfg: baseCfg,
          sleep: noopSleep,
          logFn: noopLog,
        });
      },
      (err) => {
        assert.ok(err instanceof ModelError);
        assert.strictEqual(err.kind, 'auth');
        return true;
      }
    );
    assert.strictEqual(callCount, 1); // tidak lanjut ke fallback
  });

  it('Semua model gagal → melempar ModelError all_failed', async () => {
    const mockFetch = async () => ({
      ok: false,
      status: 500,
      json: async () => ({ error: { message: 'Internal Server Error' } }),
    });

    await assert.rejects(
      async () => {
        await callModel([{ role: 'user', content: 'tes' }], {
          fetchFn: mockFetch,
          cfg: baseCfg,
          sleep: noopSleep,
          logFn: noopLog,
        });
      },
      (err) => {
        assert.ok(err instanceof ModelError);
        assert.strictEqual(err.kind, 'all_failed');
        return true;
      }
    );
  });

  it('Konten balasan kosong di primary → dianggap gagal dan pindah ke fallback', async () => {
    const mockFetch = async (url, opts) => {
      const body = JSON.parse(opts.body);
      if (body.model === 'vendor/primary:free') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            model: 'vendor/primary:free',
            choices: [{ message: { content: '   ' } }],
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          model: 'vendor/fallback:free',
          choices: [{ message: { content: '{"messages": ["isi valid"]}' } }],
        }),
      };
    };

    const res = await callModel([{ role: 'user', content: 'tes' }], {
      fetchFn: mockFetch,
      cfg: baseCfg,
      sleep: noopSleep,
      logFn: noopLog,
    });

    assert.strictEqual(res.model, 'vendor/fallback:free');
    assert.strictEqual(res.content, '{"messages": ["isi valid"]}');
  });
});

// =====================================================================
// 5. generateReply
// =====================================================================
describe('generateReply', () => {
  const dummyCfg = {
    OPENROUTER_URL: 'https://openrouter.ai/api/v1/chat/completions',
    OPENROUTER_API_KEY: 'sk-test',
    OPENROUTER_APP_TITLE: 'Chloe-Test',
    MODEL_PRIMARY: 'vendor/primary:free',
    MODEL_FALLBACKS: [],
    MODEL_TIMEOUT_MS: 500,
    MODEL_TRANSIENT_RETRIES: 0,
    MODEL_RETRY_DELAY_MS: 5,
    MODEL_RETRY_AFTER_MAX_MS: 50,
    MODEL_MAX_TOKENS: 100,
    MODEL_TEMPERATURE: 0.7,
    MAX_MESSAGES_PER_REPLY: 4,
  };

  it('Menghasilkan balasan dari model dengan format parsed valid', async () => {
    const mockFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        model: 'vendor/primary:free',
        choices: [{ message: { content: '{"messages": ["halo!", "ada apa?"]}' } }],
      }),
    });

    const res = await generateReply('halo', {
      fetchFn: mockFetch,
      cfg: dummyCfg,
      logFn: () => {},
    });

    assert.deepStrictEqual(res.messages, ['halo!', 'ada apa?']);
    assert.strictEqual(res.model, 'vendor/primary:free');
    assert.strictEqual(res.mode, 'json');
  });

  it('Jika output pertama tidak memiliki messages, panggil ulang sekali', async () => {
    let callCount = 0;
    const mockFetch = async () => {
      callCount++;
      const content = callCount === 1 ? '{"messages": []}' : '{"messages": ["balasan ke-2"]}';
      return {
        ok: true,
        status: 200,
        json: async () => ({
          model: 'vendor/primary:free',
          choices: [{ message: { content } }],
        }),
      };
    };

    const res = await generateReply('halo', {
      fetchFn: mockFetch,
      cfg: dummyCfg,
      logFn: () => {},
    });

    assert.strictEqual(callCount, 2);
    assert.deepStrictEqual(res.messages, ['balasan ke-2']);
  });
});

// =====================================================================
// 6. Integrasi Startup & Validasi Konfigurasi
// =====================================================================
describe('collectConfigErrors', () => {
  it('mengumpulkan error jika model atau api key kosong', () => {
    const badCfg = {
      configErrors: [],
      OPENROUTER_API_KEY: '',
      MODEL_PRIMARY: '',
      MODEL_FALLBACKS: [],
    };
    const { errors } = collectConfigErrors(badCfg);
    assert.ok(errors.length >= 2);
    assert.ok(errors.some((e) => e.includes('OPENROUTER_API_KEY')));
    assert.ok(errors.some((e) => e.includes('MODEL_PRIMARY')));
  });
});

// =====================================================================
// 7. Tahap 3e — Diagnostik Konten Kosong, Retry, Argument Parser, & Aturan Output
// =====================================================================
describe('Tahap 3e — Diagnostik, Retry Konten Kosong, try-model CLI, & Output Rules', () => {
  const dummyCfg = {
    OPENROUTER_URL: 'https://openrouter.ai/api/v1/chat/completions',
    OPENROUTER_API_KEY: 'sk-test-key',
    OPENROUTER_APP_TITLE: 'Chloe-Test',
    MODEL_PRIMARY: 'vendor/primary:free',
    MODEL_FALLBACKS: ['vendor/fallback:free'],
    MODEL_TIMEOUT_MS: 500,
    MODEL_TRANSIENT_RETRIES: 1,
    MODEL_EMPTY_RETRIES: 1,
    MODEL_RETRY_DELAY_MS: 5,
    MODEL_RETRY_AFTER_MAX_MS: 50,
    MODEL_MAX_TOKENS: 400,
    MODEL_REASONING: '',
    MODEL_TEMPERATURE: 0.7,
  };

  it('Poin 1: saat konten kosong, log diagnostik dan attempts memuat metadata tanpa isi balasan dan tanpa reasoning', async () => {
    const logged = [];
    const mockLog = (level, cat, msg, data) => logged.push({ level, cat, msg, data });

    const secretReasoning = 'ini adalah pemikiran internal rahasia model 987654321';
    const mockFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        model: 'vendor/primary:free',
        choices: [
          {
            finish_reason: 'length',
            message: {
              role: 'assistant',
              content: '   ',
              reasoning: secretReasoning,
            },
          },
        ],
        usage: {
          prompt_tokens: 1500,
          completion_tokens: 400,
          total_tokens: 1900,
          completion_tokens_details: {
            reasoning_tokens: 400,
          },
        },
      }),
    });

    await assert.rejects(
      async () => {
        await callModel([{ role: 'user', content: 'tes' }], {
          fetchFn: mockFetch,
          cfg: { ...dummyCfg, MODEL_FALLBACKS: [] },
          sleep: async () => {},
          logFn: mockLog,
        });
      },
      (err) => {
        assert.ok(err instanceof ModelError);
        assert.strictEqual(err.kind, 'all_failed');
        assert.strictEqual(err.attempts.length, 2); // 1 initial + 1 empty retry
        for (const att of err.attempts) {
          assert.strictEqual(att.status, 'empty');
          assert.strictEqual(att.finish_reason, 'length');
          assert.strictEqual(att.completion_tokens, 400);
          assert.strictEqual(att.reasoning_tokens, 400);
          assert.strictEqual(att.reasoning_chars, secretReasoning.length);
          assert.strictEqual(att.max_tokens, 400);
          const attStr = JSON.stringify(att);
          assert.ok(!attStr.includes(secretReasoning), 'objek attempt tidak boleh memuat isi reasoning');
          assert.ok(!att.content, 'objek attempt tidak boleh memuat field content');
        }
        return true;
      }
    );

    const failLogs = logged.filter((l) => l.msg === 'model gagal');
    assert.strictEqual(failLogs.length, 2);
    for (const fl of failLogs) {
      assert.strictEqual(fl.data.status, 'empty');
      assert.strictEqual(fl.data.finish_reason, 'length');
      assert.strictEqual(fl.data.completion_tokens, 400);
      assert.strictEqual(fl.data.reasoning_tokens, 400);
      assert.strictEqual(fl.data.reasoning_chars, secretReasoning.length);
      assert.strictEqual(fl.data.max_tokens, 400);

      const logStr = JSON.stringify(fl.data);
      assert.ok(!logStr.includes(secretReasoning), 'log tidak boleh memuat isi reasoning');
      assert.ok(!fl.data.content, 'log tidak boleh memuat field content');
    }
  });

  it('Poin 2: resolveReasoningParam dan pengiriman parameter reasoning ke OpenRouter', async () => {
    assert.strictEqual(resolveReasoningParam(''), undefined);
    assert.strictEqual(resolveReasoningParam(null), undefined);
    assert.deepStrictEqual(resolveReasoningParam('low'), { effort: 'low' });
    assert.deepStrictEqual(resolveReasoningParam('none'), { effort: 'none' });
    assert.deepStrictEqual(resolveReasoningParam('HIGH'), { effort: 'high' });
    assert.deepStrictEqual(resolveReasoningParam('250'), { max_tokens: 250 });
    assert.deepStrictEqual(resolveReasoningParam('{"effort":"low","exclude":true}'), { effort: 'low', exclude: true });

    let sentBody = null;
    const mockFetch = async (url, opts) => {
      sentBody = JSON.parse(opts.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          model: 'vendor/primary:free',
          choices: [{ message: { content: '{"messages":["ok"]}' } }],
        }),
      };
    };

    // Saat MODEL_REASONING diisi
    await callModel([{ role: 'user', content: 'tes' }], {
      fetchFn: mockFetch,
      cfg: { ...dummyCfg, MODEL_REASONING: 'low' },
      sleep: async () => {},
      logFn: () => {},
    });
    assert.deepStrictEqual(sentBody.reasoning, { effort: 'low' });

    // Saat MODEL_REASONING kosong
    await callModel([{ role: 'user', content: 'tes' }], {
      fetchFn: mockFetch,
      cfg: { ...dummyCfg, MODEL_REASONING: '' },
      sleep: async () => {},
      logFn: () => {},
    });
    assert.strictEqual(sentBody.reasoning, undefined);
  });

  it('Poin 3: konten kosong mencoba ulang di model yang sama sekali (MODEL_EMPTY_RETRIES) sebelum pindah model', async () => {
    const calls = [];
    const mockFetch = async (url, opts) => {
      const body = JSON.parse(opts.body);
      calls.push(body.model);
      if (body.model === 'vendor/primary:free') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            model: 'vendor/primary:free',
            choices: [{ message: { content: '   ' } }],
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          model: 'vendor/fallback:free',
          choices: [{ message: { content: '{"messages":["berhasil di fallback"]}' } }],
        }),
      };
    };

    const res = await callModel([{ role: 'user', content: 'tes' }], {
      fetchFn: mockFetch,
      cfg: dummyCfg,
      sleep: async () => {},
      logFn: () => {},
    });

    assert.strictEqual(res.model, 'vendor/fallback:free');
    assert.strictEqual(res.content, '{"messages":["berhasil di fallback"]}');
    // primary dipanggil 2 kali (awal + 1 retry kosong), lalu fallback 1 kali
    assert.deepStrictEqual(calls, [
      'vendor/primary:free',
      'vendor/primary:free',
      'vendor/fallback:free',
    ]);
    assert.strictEqual(res.attempts.length, 3);
    assert.strictEqual(res.attempts[0].model, 'vendor/primary:free');
    assert.strictEqual(res.attempts[0].try, 1);
    assert.strictEqual(res.attempts[0].status, 'empty');
    assert.strictEqual(res.attempts[1].model, 'vendor/primary:free');
    assert.strictEqual(res.attempts[1].try, 2);
    assert.strictEqual(res.attempts[1].status, 'empty');
    assert.strictEqual(res.attempts[2].model, 'vendor/fallback:free');
    assert.strictEqual(res.attempts[2].try, 1);
    assert.strictEqual(res.attempts[2].status, 200);
  });

  it('Poin 4: parsing argumen scripts/try-model.js', () => {
    const parsed = parseCliArgs([
      '--full',
      '--model',
      'vendor/custom-model:free',
      '--max-tokens',
      '800',
      '--repeat',
      '4',
      'halo',
      'chloe',
      'apa',
      'kabar',
    ]);
    assert.strictEqual(parsed.isFull, true);
    assert.strictEqual(parsed.modelId, 'vendor/custom-model:free');
    assert.strictEqual(parsed.maxTokens, 800);
    assert.strictEqual(parsed.repeat, 4);
    assert.strictEqual(parsed.prompt, 'halo chloe apa kabar');

    // Clamping repeat maksimal 5
    const clamped = parseCliArgs(['--repeat', '10', 'tes']);
    assert.strictEqual(clamped.repeat, 5);

    // Format argumen bentuk --key=value
    const parsedEquals = parseCliArgs(['--model=vendor/other:free', '--max-tokens=600', '--repeat=2']);
    assert.strictEqual(parsedEquals.modelId, 'vendor/other:free');
    assert.strictEqual(parsedEquals.maxTokens, 600);
    assert.strictEqual(parsedEquals.repeat, 2);

    // Nilai default
    const empty = parseCliArgs([]);
    assert.strictEqual(empty.isFull, false);
    assert.strictEqual(empty.modelId, null);
    assert.strictEqual(empty.maxTokens, null);
    assert.strictEqual(empty.repeat, 1);
    assert.strictEqual(empty.prompt, 'halo, kamu lagi ngapain?');
  });

  it('Poin 5: formatOutputRules memuat rumusan baru pembatasan kemampuan dan pengingat/catatan', () => {
    const rules = formatOutputRules();
    const expectedSentence = 'Saat ini aksi yang tersedia HANYA save_fact. Pengingat dan catatan BELUM aktif: jangan menjanjikan, menawarkan, atau mengaku bisa melakukannya, termasuk saat ditanya apa saja yang bisa kamu lakukan. Kalau ditanya kemampuanmu, sebutkan ngobrol dan mengingat hal tentang pengguna.';
    assert.ok(rules.includes(expectedSentence), 'formatOutputRules harus memuat teks pembatasan aksi baru');
  });
});

// =====================================================================
// Tahap 3f: Pemulihan JSON Terpotong (Salvaged) & Retry finish_reason=length
// =====================================================================
describe('Tahap 3f — Pemulihan JSON Terpotong (Salvaged) & Retry finish_reason=length', () => {
  const dummyCfg = {
    OPENROUTER_API_KEY: 'test-key',
    MODEL_PRIMARY: 'vendor/primary:free',
    MODEL_FALLBACKS: ['vendor/fallback:free'],
    MODEL_TIMEOUT_MS: 60_000,
    MODEL_TRANSIENT_RETRIES: 1,
    MODEL_EMPTY_RETRIES: 1,
    MODEL_RETRY_DELAY_MS: 0,
    MODEL_RETRY_AFTER_MAX_MS: 10_000,
    MODEL_MAX_TOKENS: 1200,
    MAX_MESSAGES_PER_REPLY: 4,
  };

  it('looksLikeJson mendeteksi JSON atau teks dengan "messages"', () => {
    assert.strictEqual(looksLikeJson('{"messages": ["halo"]}'), true);
    assert.strictEqual(looksLikeJson('  { "foo": 123 }  '), true);
    assert.strictEqual(looksLikeJson('{"messages": ["terpotong...'), true);
    assert.strictEqual(looksLikeJson('ini teks biasa tapi ada "messages" di dalamnya'), true);
    assert.strictEqual(looksLikeJson('Halo semuanya, apa kabar?'), false);
    assert.strictEqual(looksLikeJson(''), false);
  });

  it('JSON terpotong di tengah string kedua → hanya string pertama yang lengkap yang diambil (mode: salvaged)', () => {
    const truncated = '{"messages": ["Halo! Apa kabar?", "Aku lagi mau ceri';
    const salvaged = salvageTruncatedMessages(truncated);
    assert.deepStrictEqual(salvaged, ['Halo! Apa kabar?']);

    const res = parseModelOutput(truncated, dummyCfg);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.mode, 'salvaged');
    assert.deepStrictEqual(res.messages, ['Halo! Apa kabar?']);
  });

  it('salvageTruncatedMessages menangani karakter escape dengan benar tanpa regex rakus', () => {
    const truncated = '{"messages": ["Dia bilang \\"halo\\" dan tersenyum :)", "Pesan kedua terpot';
    const salvaged = salvageTruncatedMessages(truncated);
    assert.deepStrictEqual(salvaged, ['Dia bilang "halo" dan tersenyum :)']);

    const res = parseModelOutput(truncated, dummyCfg);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.mode, 'salvaged');
    assert.deepStrictEqual(res.messages, ['Dia bilang "halo" dan tersenyum :)']);
  });

  it('teks berawalan "{" yang tidak bisa diselamatkan → ok:false', () => {
    // Terpotong sebelum string pertama selesai
    const truncatedEarly = '{"messages": ["h';
    assert.deepStrictEqual(salvageTruncatedMessages(truncatedEarly), []);
    const res1 = parseModelOutput(truncatedEarly, dummyCfg);
    assert.strictEqual(res1.ok, false);
    assert.strictEqual(res1.mode, 'salvaged');
    assert.deepStrictEqual(res1.messages, []);

    // Objek JSON terpotong tanpa array messages
    const truncatedNoMessages = '{"reasoning": "aku sedang berpikir...';
    assert.deepStrictEqual(salvageTruncatedMessages(truncatedNoMessages), []);
    const res2 = parseModelOutput(truncatedNoMessages, dummyCfg);
    assert.strictEqual(res2.ok, false);
    assert.strictEqual(res2.mode, 'salvaged');
    assert.deepStrictEqual(res2.messages, []);
  });

  it('teks biasa tanpa JSON tetap mode raw', () => {
    const plain = 'Halo kak, aku Chloe! Ada yang bisa kubantu?';
    const res = parseModelOutput(plain, dummyCfg);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.mode, 'raw');
    assert.deepStrictEqual(res.messages, [plain]);
  });

  it('finish_reason=length memicu retry di model yang sama (sukses di percobaan ke-2)', async () => {
    let callCount = 0;
    const mockFetch = async () => {
      callCount++;
      if (callCount === 1) {
        // Percobaan 1: terpotong finish_reason: 'length'
        return {
          ok: true,
          status: 200,
          json: async () => ({
            model: 'vendor/primary:free',
            choices: [{
              finish_reason: 'length',
              message: { content: '{"messages": ["Sebagian teks", "terpot' },
            }],
          }),
        };
      }
      // Percobaan 2 di model yang sama: berhasil JSON utuh
      return {
        ok: true,
        status: 200,
        json: async () => ({
          model: 'vendor/primary:free',
          choices: [{
            finish_reason: 'stop',
            message: { content: '{"messages": ["Pesan lengkap dan utuh!"]}' },
          }],
        }),
      };
    };

    const res = await callModel([{ role: 'user', content: 'halo' }], {
      fetchFn: mockFetch,
      cfg: dummyCfg,
      sleep: async () => {},
      logFn: () => {},
    });

    assert.strictEqual(callCount, 2);
    assert.strictEqual(res.model, 'vendor/primary:free');
    assert.strictEqual(res.parsed.mode, 'json');
    assert.deepStrictEqual(res.parsed.messages, ['Pesan lengkap dan utuh!']);
    assert.strictEqual(res.attempts.length, 2);
    assert.strictEqual(res.attempts[0].try, 1);
    assert.strictEqual(res.attempts[0].finish_reason, 'length');
    assert.strictEqual(res.attempts[1].try, 2);
    assert.strictEqual(res.attempts[1].finish_reason, 'stop');
  });

  it('finish_reason=length berulang kali terpotong: memakai hasil salvaged jika ada', async () => {
    let callCount = 0;
    const mockFetch = async () => {
      callCount++;
      // Kedua percobaan mengembalikan pesan terpotong dengan string pertama utuh
      return {
        ok: true,
        status: 200,
        json: async () => ({
          model: 'vendor/primary:free',
          choices: [{
            finish_reason: 'length',
            message: { content: '{"messages": ["Pesan selamat dari pemotongan", "terpotong...' },
          }],
        }),
      };
    };

    const res = await callModel([{ role: 'user', content: 'halo' }], {
      fetchFn: mockFetch,
      cfg: dummyCfg,
      sleep: async () => {},
      logFn: () => {},
    });

    // Dipanggil 2 kali (try 1 + 1 retry karena emptyMax = 1), lalu pakai salvaged
    assert.strictEqual(callCount, 2);
    assert.strictEqual(res.model, 'vendor/primary:free');
    assert.strictEqual(res.parsed.mode, 'salvaged');
    assert.deepStrictEqual(res.parsed.messages, ['Pesan selamat dari pemotongan']);
  });

  it('finish_reason=length tanpa hasil salvaged: pindah ke model fallback setelah retry habis', async () => {
    const calls = [];
    const mockFetch = async (_url, opts) => {
      const body = JSON.parse(opts.body);
      calls.push(body.model);
      if (body.model === 'vendor/primary:free') {
        // Terpotong tanpa ada pesan yang bisa diselamatkan
        return {
          ok: true,
          status: 200,
          json: async () => ({
            model: 'vendor/primary:free',
            choices: [{
              finish_reason: 'length',
              message: { content: '{"messages": ["h' },
            }],
          }),
        };
      }
      // Fallback model sukses
      return {
        ok: true,
        status: 200,
        json: async () => ({
          model: 'vendor/fallback:free',
          choices: [{
            finish_reason: 'stop',
            message: { content: '{"messages": ["Sukses dari fallback!"]}' },
          }],
        }),
      };
    };

    const res = await callModel([{ role: 'user', content: 'halo' }], {
      fetchFn: mockFetch,
      cfg: dummyCfg,
      sleep: async () => {},
      logFn: () => {},
    });

    assert.deepStrictEqual(calls, [
      'vendor/primary:free',
      'vendor/primary:free',
      'vendor/fallback:free',
    ]);
    assert.strictEqual(res.model, 'vendor/fallback:free');
    assert.strictEqual(res.parsed.mode, 'json');
    assert.deepStrictEqual(res.parsed.messages, ['Sukses dari fallback!']);
  });

  it('generateReply berhasil memanfaatkan hasil salvaged saat response terpotong', async () => {
    const mockFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        model: 'vendor/primary:free',
        choices: [{
          finish_reason: 'length',
          message: { content: '{"messages": ["Balasan penting yang selamat!", "pesan terpotong...' },
        }],
      }),
    });

    const reply = await generateReply('halo', {
      fetchFn: mockFetch,
      cfg: dummyCfg,
      sleep: async () => {},
      logFn: () => {},
    });

    assert.strictEqual(reply.mode, 'salvaged');
    assert.deepStrictEqual(reply.messages, ['Balasan penting yang selamat!']);
  });
});

// =====================================================================
// Tahap 3g: Kebijakan Data (MODEL_DATA_COLLECTION & MODEL_ZDR) & --each
// =====================================================================
describe('Tahap 3g — Kebijakan Data & Opsi --each', () => {
  const baseValidCfg = {
    OPENROUTER_API_KEY: 'test-key',
    MODEL_PRIMARY: 'vendor/primary:free',
    MODEL_FALLBACKS: ['vendor/fallback:free'],
    MODEL_TIMEOUT_MS: 60_000,
    MODEL_TRANSIENT_RETRIES: 1,
    MODEL_EMPTY_RETRIES: 1,
    MODEL_RETRY_DELAY_MS: 0,
    MODEL_RETRY_AFTER_MAX_MS: 10_000,
    MODEL_MAX_TOKENS: 1200,
    MAX_MESSAGES_PER_REPLY: 4,
    MODEL_DATA_COLLECTION: '',
    MODEL_ZDR: '0',
  };

  it('resolveProviderParam membentuk objek provider sesuai env atau undefined saat kosong', () => {
    // Kosong / default -> undefined (tidak mengirim apa-apa)
    assert.strictEqual(resolveProviderParam({ MODEL_DATA_COLLECTION: '', MODEL_ZDR: '0' }), undefined);
    assert.strictEqual(resolveProviderParam({ MODEL_DATA_COLLECTION: '', MODEL_ZDR: 0 }), undefined);

    // data_collection allow
    assert.deepStrictEqual(resolveProviderParam({ MODEL_DATA_COLLECTION: 'allow', MODEL_ZDR: '0' }), {
      data_collection: 'allow',
    });

    // data_collection deny
    assert.deepStrictEqual(resolveProviderParam({ MODEL_DATA_COLLECTION: 'deny', MODEL_ZDR: '0' }), {
      data_collection: 'deny',
    });

    // ZDR = 1
    assert.deepStrictEqual(resolveProviderParam({ MODEL_DATA_COLLECTION: '', MODEL_ZDR: '1' }), {
      zdr: true,
    });

    // Kedua parameter aktif
    assert.deepStrictEqual(resolveProviderParam({ MODEL_DATA_COLLECTION: 'deny', MODEL_ZDR: '1' }), {
      data_collection: 'deny',
      zdr: true,
    });
  });

  it('body request memuat provider.data_collection dan zdr saat aktif, dan tidak memuat provider saat kosong', async () => {
    let capturedBody = null;
    const mockFetch = async (_url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          model: 'vendor/primary:free',
          choices: [{ finish_reason: 'stop', message: { content: '{"messages":["ok"]}' } }],
        }),
      };
    };

    // 1. Kosong -> tidak ada field provider
    await callModel([{ role: 'user', content: 'tes' }], {
      fetchFn: mockFetch,
      cfg: { ...baseValidCfg, MODEL_DATA_COLLECTION: '', MODEL_ZDR: '0' },
      sleep: async () => {},
      logFn: () => {},
    });
    assert.strictEqual(capturedBody.provider, undefined);

    // 2. data_collection deny + zdr 1 -> field provider terisi
    await callModel([{ role: 'user', content: 'tes' }], {
      fetchFn: mockFetch,
      cfg: { ...baseValidCfg, MODEL_DATA_COLLECTION: 'deny', MODEL_ZDR: '1' },
      sleep: async () => {},
      logFn: () => {},
    });
    assert.deepStrictEqual(capturedBody.provider, {
      data_collection: 'deny',
      zdr: true,
    });
  });

  it('nilai tidak valid pada MODEL_DATA_COLLECTION atau MODEL_ZDR menghasilkan galat konfigurasi', () => {
    // data_collection tidak valid
    const errDc = validateModelConfig({ ...baseValidCfg, MODEL_DATA_COLLECTION: 'invalid' });
    assert.ok(errDc.errors.some((e) => e.includes('MODEL_DATA_COLLECTION tidak valid')));

    // zdr tidak valid
    const errZdr = validateModelConfig({ ...baseValidCfg, MODEL_ZDR: '2' });
    assert.ok(errZdr.errors.some((e) => e.includes('MODEL_ZDR tidak valid')));

    // nilai valid tidak memunculkan galat
    const okAllow = validateModelConfig({ ...baseValidCfg, MODEL_DATA_COLLECTION: 'allow', MODEL_ZDR: '1' });
    assert.strictEqual(okAllow.errors.length, 0);

    const okDeny = validateModelConfig({ ...baseValidCfg, MODEL_DATA_COLLECTION: 'deny', MODEL_ZDR: '0' });
    assert.strictEqual(okDeny.errors.length, 0);
  });

  it('respons policy tidak di-retry dan langsung pindah ke model berikutnya', async () => {
    const calls = [];
    const logs = [];
    const mockFetch = async (_url, opts) => {
      const b = JSON.parse(opts.body);
      calls.push(b.model);
      if (b.model === 'vendor/primary:free') {
        // OpenRouter menolak dengan 404 data policy
        return {
          ok: false,
          status: 404,
          statusText: 'Not Found',
          json: async () => ({
            error: {
              code: 404,
              message: 'No endpoints found matching your data policy',
            },
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          model: 'vendor/fallback:free',
          choices: [{ finish_reason: 'stop', message: { content: '{"messages":["halo dari fallback"]}' } }],
        }),
      };
    };

    const res = await callModel([{ role: 'user', content: 'tes' }], {
      fetchFn: mockFetch,
      cfg: baseValidCfg,
      sleep: async () => {},
      logFn: (lvl, tag, msg, data) => logs.push({ lvl, tag, msg, data }),
    });

    // Primary model hanya dipanggil TEPAT 1 kali (tidak di-retry)
    assert.deepStrictEqual(calls, ['vendor/primary:free', 'vendor/fallback:free']);
    assert.strictEqual(res.model, 'vendor/fallback:free');

    // Log mencatat jelas bahwa model tidak memenuhi kebijakan data (hanya model dan kind)
    const policyLog = logs.find((l) => l.msg === 'model tidak memenuhi kebijakan data');
    assert.ok(policyLog, 'harus ada log model tidak memenuhi kebijakan data');
    assert.deepStrictEqual(policyLog.data, {
      model: 'vendor/primary:free',
      kind: 'policy',
    });
  });

  it('semua model gagal karena policy → ModelError all_failed menyebut kebijakan data (policy)', async () => {
    const mockFetch = async () => ({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      json: async () => ({
        error: {
          code: 404,
          message: 'No endpoints found matching your data policy',
        },
      }),
    });

    await assert.rejects(
      async () => {
        await callModel([{ role: 'user', content: 'tes' }], {
          fetchFn: mockFetch,
          cfg: baseValidCfg,
          sleep: async () => {},
          logFn: () => {},
        });
      },
      (err) => {
        assert.strictEqual(err.kind, 'all_failed');
        assert.ok(
          err.message.includes('kebijakan data') || err.message.includes('policy'),
          `Pesan error harus menyebut kebijakan data/policy, dapat: ${err.message}`
        );
        return true;
      }
    );
  });

  it('parsing opsi --each pada scripts/try-model.js', () => {
    const parsed1 = parseCliArgs(['--each']);
    assert.strictEqual(parsed1.isEach, true);
    assert.strictEqual(parsed1.prompt, 'halo');

    const parsed2 = parseCliArgs(['--each', '--model=custom/model:free']);
    assert.strictEqual(parsed2.isEach, true);
    assert.strictEqual(parsed2.modelId, 'custom/model:free');
    assert.strictEqual(parsed2.prompt, 'halo');

    const parsed3 = parseCliArgs(['halo chloe']);
    assert.strictEqual(parsed3.isEach, false);
    assert.strictEqual(parsed3.prompt, 'halo chloe');
  });
});



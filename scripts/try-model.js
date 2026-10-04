// scripts/try-model.js — uji satu prompt ke OpenRouter tanpa menjalankan WhatsApp
// Penggunaan:
//   node scripts/try-model.js "halo chloe"
//   node scripts/try-model.js --full --model google/gemma-4-31b-it:free --max-tokens 500 --repeat 2 "halo"
import config from '../config.js';
import { generateReply, validateModelConfig, getModelChain } from '../src/agent.js';
import { openDb } from '../src/db.js';
import { assemblePromptMessages } from '../src/memory.js';
import { EXIT_CONFIG, EXIT_CRASH } from '../src/exit.js';

export function parseCliArgs(argv = process.argv.slice(2)) {
  let isFull = false;
  let isEach = false;
  let modelId = null;
  let maxTokens = null;
  let repeat = 1;
  const promptParts = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--full') {
      isFull = true;
    } else if (arg === '--each') {
      isEach = true;
    } else if (arg === '--model') {
      if (i + 1 < argv.length) modelId = argv[++i];
    } else if (arg.startsWith('--model=')) {
      modelId = arg.slice(8);
    } else if (arg === '--max-tokens') {
      if (i + 1 < argv.length) {
        const n = parseInt(argv[++i], 10);
        if (!Number.isNaN(n)) maxTokens = n;
      }
    } else if (arg.startsWith('--max-tokens=')) {
      const n = parseInt(arg.slice(13), 10);
      if (!Number.isNaN(n)) maxTokens = n;
    } else if (arg === '--repeat') {
      if (i + 1 < argv.length) {
        const n = parseInt(argv[++i], 10);
        if (!Number.isNaN(n)) repeat = Math.min(5, Math.max(1, n));
      }
    } else if (arg.startsWith('--repeat=')) {
      const n = parseInt(arg.slice(9), 10);
      if (!Number.isNaN(n)) repeat = Math.min(5, Math.max(1, n));
    } else {
      promptParts.push(arg);
    }
  }

  const prompt = promptParts.join(' ').trim() || (isEach ? 'halo' : 'halo, kamu lagi ngapain?');
  return { isFull, isEach, modelId, maxTokens, repeat, prompt };
}

export async function runTryModel(argv = process.argv.slice(2)) {
  const { isFull, isEach, modelId, maxTokens, repeat, prompt } = parseCliArgs(argv);

  const runCfg = {
    ...config,
    ...(modelId ? { MODEL_PRIMARY: modelId, MODEL_FALLBACKS: [] } : {}),
    ...(maxTokens != null ? { MODEL_MAX_TOKENS: maxTokens } : {}),
  };

  const { errors, warnings } = validateModelConfig(runCfg);
  for (const w of warnings) console.warn(`[WARN] ${w}`);
  if (errors.length) {
    for (const e of errors) console.error(`[ERROR] ${e}`);
    console.error(`\nKonfigurasi model tidak valid. Cek .env (MODEL_PRIMARY, OPENROUTER_API_KEY).`);
    process.exit(EXIT_CONFIG);
  }

  const chain = getModelChain(runCfg);
  const dataCollectionDisplay = runCfg.MODEL_DATA_COLLECTION || '(kosong)';
  const zdrDisplay = runCfg.MODEL_ZDR === '1' || runCfg.MODEL_ZDR === 1 ? '1' : '0';

  console.log(`[INFO] Mode prompt     : ${isFull ? 'full (assemblePromptMessages)' : 'simple (TEMP_SYSTEM_PROMPT)'}`);
  console.log(`[INFO] Model chain     : ${chain.join(' → ')}`);
  console.log(`[INFO] Data collection : ${dataCollectionDisplay}`);
  console.log(`[INFO] ZDR             : ${zdrDisplay}`);
  console.log(`[INFO] Max tokens      : ${runCfg.MODEL_MAX_TOKENS}`);

  if (isEach) {
    console.log(`[INFO] Mode --each     : mencoba ${chain.length} model secara terpisah (tanpa fallback)`);
    console.log(`[INFO] Prompt uji      : "halo"\n`);

    const tableRows = [];
    for (const m of chain) {
      const singleCfg = {
        ...runCfg,
        MODEL_PRIMARY: m,
        MODEL_FALLBACKS: [],
        MODEL_TRANSIENT_RETRIES: 0,
        MODEL_EMPTY_RETRIES: 0,
      };

      const t0 = Date.now();
      let status = 'lainnya';
      try {
        await generateReply('halo', {
          cfg: singleCfg,
          maxTokens: singleCfg.MODEL_MAX_TOKENS,
        });
        status = 'ok';
      } catch (e) {
        const attempt = e.attempts?.[0];
        const kind = attempt?.kind;
        const attemptStatus = attempt?.status;

        if (kind === 'policy' || attemptStatus === 'policy') {
          status = 'policy';
        } else if (attemptStatus === 429) {
          status = '429';
        } else if (attemptStatus === 'empty') {
          status = 'empty';
        } else {
          status = 'lainnya';
        }
      }
      const dur = Date.now() - t0;
      tableRows.push({
        model: m,
        status,
        durasi: `${dur}ms`,
      });
    }

    console.log('\nHasil pengujian --each:');
    console.table(tableRows);
    console.log('\n| Model | Status | Durasi |');
    console.log('|---|---|---|');
    for (const r of tableRows) {
      console.log(`| ${r.model} | ${r.status} | ${r.durasi} |`);
    }
    return;
  }

  let promptOrMessages = prompt;
  if (isFull) {
    const owner = config.users.find((u) => u.is_owner) || config.users[0] || {
      name: 'Owner',
      callname: 'kakak',
      number: '628123456789',
      jid: '628123456789@s.whatsapp.net',
      is_owner: true,
    };
    const jid = owner.jid || (owner.number ? `${owner.number}@s.whatsapp.net` : 'owner@s.whatsapp.net');
    const user = { ...owner, jid };

    const memDb = openDb(':memory:');
    try {
      const assembled = assemblePromptMessages({
        db: memDb,
        user,
        incomingText: prompt,
        cfg: runCfg,
      });
      promptOrMessages = assembled.messages;
    } finally {
      memDb.close();
    }
  }

  console.log(`[INFO] Repeat          : ${repeat}x`);
  console.log(`[INFO] Prompt uji      : "${prompt}"\n`);

  for (let rep = 1; rep <= repeat; rep++) {
    if (repeat > 1) {
      console.log(`=== Percobaan ${rep}/${repeat} ===`);
    }
    const t0 = Date.now();
    try {
      const result = await generateReply(promptOrMessages, {
        cfg: runCfg,
        maxTokens: runCfg.MODEL_MAX_TOKENS,
      });
      const duration = Date.now() - t0;
      const lastAttempt = result.attempts?.[result.attempts.length - 1];
      const finishReason = result.finish_reason ?? lastAttempt?.finish_reason ?? 'unknown';

      const u = result.usage;
      const reasoningTok = u?.reasoning_tokens ?? u?.completion_tokens_details?.reasoning_tokens;
      const tokenParts = [];
      if (u?.prompt_tokens != null) tokenParts.push(`prompt=${u.prompt_tokens}`);
      if (u?.completion_tokens != null) tokenParts.push(`completion=${u.completion_tokens}`);
      if (reasoningTok != null) tokenParts.push(`reasoning=${reasoningTok}`);
      const tokenStr = tokenParts.length > 0 ? tokenParts.join(', ') : '-';

      const fullReply = result.messages.join(' ');
      const preview = fullReply.length > 200 ? fullReply.slice(0, 200) + '...' : fullReply;

      console.log(`Model         : ${result.model}`);
      console.log(`Durasi        : ${duration}ms`);
      console.log(`Finish reason : ${finishReason}`);
      console.log(`Token         : ${tokenStr}`);
      console.log(`Panjang konten: ${fullReply.length} karakter`);
      console.log(`Mode parse    : ${result.mode}`);
      console.log(`Cuplikan balas: "${preview}"\n`);
    } catch (e) {
      const duration = Date.now() - t0;
      const lastAttempt = e.attempts?.[e.attempts.length - 1];
      const finishReason = lastAttempt?.finish_reason || 'error';
      const tokenParts = [];
      if (lastAttempt?.completion_tokens != null) tokenParts.push(`completion=${lastAttempt.completion_tokens}`);
      if (lastAttempt?.reasoning_tokens != null) tokenParts.push(`reasoning=${lastAttempt.reasoning_tokens}`);
      const tokenStr = tokenParts.length > 0 ? tokenParts.join(', ') : '-';

      console.error(`Model         : ${lastAttempt?.model || modelId || runCfg.MODEL_PRIMARY}`);
      console.error(`Durasi        : ${duration}ms`);
      console.error(`Finish reason : ${finishReason}`);
      console.error(`Token         : ${tokenStr}`);
      console.error(`Panjang konten: 0 karakter`);
      console.error(`Mode parse    : gagal (${e.message})\n`);
      if (rep === repeat && repeat === 1) {
        process.exit(e.kind === 'config' ? EXIT_CONFIG : EXIT_CRASH);
      }
    }
  }
}

const isDirectRun = process.argv[1] && (
  process.argv[1].endsWith('try-model.js') ||
  process.argv[1].endsWith('try-model')
);

if (isDirectRun) {
  runTryModel().catch((e) => {
    console.error(`[FATAL] ${e.message}`);
    process.exit(EXIT_CRASH);
  });
}

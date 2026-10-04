// src/index.js — entry: validasi config, buka DB, koneksi WhatsApp
// Tahap 2: balasan dari model (OpenRouter)
//
// Exit code (SPEC §9): galat konfigurasi/startup → 7 (jangan restart otomatis);
// exception tak terduga → 1 (boleh restart otomatis dengan batas, Tahap 8).

import config from '../config.js';
import { openDb } from './db.js';
import { log } from './log.js';
import { startWhatsApp } from './whatsapp.js';
import { validateModelConfig, getModelChain } from './agent.js';
import { validatePromptAssets } from './prompt.js';
import { initRng } from './rng.js';
import { EXIT_CONFIG, EXIT_CRASH, exitProcess } from './exit.js';

/** Kumpulkan semua galat konfigurasi yang tidak akan sembuh dengan restart. */
export function collectConfigErrors(cfg = config) {
  const { errors, warnings } = validateModelConfig(cfg);
  const allErrors = [...cfg.configErrors, ...errors];
  try {
    validatePromptAssets(cfg);
  } catch (e) {
    allErrors.push(e.message);
  }
  return { errors: allErrors, warnings };
}

async function main() {
  const wibStr = new Intl.DateTimeFormat('id-ID', {
    timeZone: config.TZ,
    dateStyle: 'full',
    timeStyle: 'medium',
  }).format(new Date());

  log('info', 'start', `=== ${config.CHARACTER_NAME} ===`);
  log('info', 'start', `Waktu WIB: ${wibStr}`);
  log('info', 'start', `Node ${process.version}`);
  log('info', 'start', `DRY_RUN=${config.DRY_RUN}, DELAY_SCALE=${config.DELAY_SCALE}`);
  log('info', 'start', `RNG_SEED=${config.RNG_SEED || '(acak)'}`);
  initRng(config.RNG_SEED);

  if (config.FORCE_PHASE) log('info', 'start', `FORCE_PHASE=${config.FORCE_PHASE}`);
  if (config.FORCE_MOOD) log('info', 'start', `FORCE_MOOD=${config.FORCE_MOOD}`);
  if (config.FAKE_NOW) log('info', 'start', `FAKE_NOW=${config.FAKE_NOW}`);

  // --- validasi konfigurasi (users.json, model, API key) ---
  const { errors, warnings } = collectConfigErrors();
  for (const w of warnings) log('warn', 'config', w);
  if (errors.length) {
    for (const e of errors) log('error', 'config', e);
    log('error', 'config', `Galat konfigurasi — berhenti (exit ${EXIT_CONFIG}). Perbaiki lalu jalankan ulang.`);
    return exitProcess(EXIT_CONFIG);
  }
  // nama model boleh dicatat; API key tidak pernah
  log('info', 'start', `Model: ${getModelChain().join(' → ')}`);

  // --- buka DB ---
  let db;
  try {
    db = openDb(config.DB_PATH);
  } catch (e) {
    log('error', 'db', `DB tidak bisa dibuka (${config.DB_PATH}): ${e.message} — berhenti (exit ${EXIT_CONFIG})`);
    return exitProcess(EXIT_CONFIG);
  }

  // sinkronkan users.json ke tabel users
  for (const u of config.users) {
    db.upsertUser({
      jid: `${u.number}@s.whatsapp.net`,
      name: u.name,
      callname: u.callname,
      relationship_note: u.relationship_note,
      is_owner: u.is_owner,
      created_at: Date.now(),
    });
  }
  log('info', 'start', `Users disinkronkan: ${config.users.length}`);
  log('info', 'start', `Batas harian per user: ${config.DAILY_LIMIT_PER_USER}`);
  log('info', 'start', `DB backend: ${db.backend} (${db.nodeVersion})`);

  // --- koneksi WhatsApp ---
  const wa = await startWhatsApp({ db });
  if (wa) log('info', 'start', `=== Siap (Tahap 3 — memori & persona aktif) ===`);
}

// jalankan hanya kalau file ini entry point (supaya collectConfigErrors bisa dites tanpa start bot)
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/').replace(/^(?=[A-Za-z]:)/, '/')}`) {
  main().catch((e) => {
    // galat tak terduga saat start → kode 1 (boleh restart dengan batas)
    log('error', 'start', `Crash tak terduga: ${e?.stack ?? e}`);
    exitProcess(EXIT_CRASH);
  });
}

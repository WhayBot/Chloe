// scripts/db-peek.js — inspeksi cepat isi DB: statistik pesan, jid_map, reminder, dan anggaran model
// Isi teks pesan TIDAK dicetak (AGENT.md §Keamanan & SPEC §9)
import config from '../config.js';
import { openDb } from '../src/db.js';
import { createBudget } from '../src/budget.js';
import { formatWibLong } from '../src/time.js';

function maskLid(lid) {
  const s = String(lid ?? '');
  if (s.length <= 6) return s;
  return s.slice(0, 3) + '…' + s.slice(-3);
}

function maskPhone(num) {
  const s = String(num ?? '');
  if (s.length <= 6) return s;
  return s.slice(0, 3) + '…' + s.slice(-3);
}

try {
  const db = openDb(config.DB_PATH);
  const budget = createBudget({ db });

  console.log(`=== Chloe DB Peek: ${config.DB_PATH} ===\n`);

  // 1. Jumlah pesan per dir dan status
  console.log('--- 1. Ringkasan Pesan (dir & status) ---');
  const msgSummary = db._raw.prepare(`
    SELECT dir, status, COUNT(*) as cnt
    FROM messages
    GROUP BY dir, status
    ORDER BY dir, status
  `).all();
  if (msgSummary.length) {
    for (const r of msgSummary) {
      console.log(`  [${r.dir.toUpperCase()}] status: ${r.status} → ${r.cnt} pesan`);
    }
  } else {
    console.log('  (belum ada pesan)');
  }

  // 2. 10 pesan terakhir (tanpa isi teks)
  console.log('\n--- 2. 10 Pesan Terakhir (Hanya Metadata, Tanpa Isi Teks) ---');
  const last10 = db._raw.prepare(`
    SELECT id, dir, status, length(text) as len, ts
    FROM messages
    ORDER BY id DESC
    LIMIT 10
  `).all();
  if (last10.length) {
    for (const m of last10) {
      const timeStr = m.ts ? formatWibLong(m.ts) : '-';
      console.log(`  #${m.id} [${m.dir.toUpperCase()}] status: ${m.status} | panjang: ${m.len} karakter | waktu: ${timeStr}`);
    }
  } else {
    console.log('  (belum ada pesan)');
  }

  // 3. Isi jid_map (LID disensor sebagian)
  console.log('\n--- 3. Pemetaan jid_map (LID Disensor) ---');
  const jidMaps = db.getAllJidMap();
  if (jidMaps.length) {
    for (const jm of jidMaps) {
      console.log(`  LID: ${maskLid(jm.lid)} → nomor: ${maskPhone(jm.number)} (sumber: ${jm.source})`);
    }
  } else {
    console.log('  (belum ada pemetaan jid_map)');
  }

  // 4. Jumlah reminder pending
  console.log('\n--- 4. Pengingat (Reminders) ---');
  const pendingRem = db._raw.prepare(`
    SELECT COUNT(*) as cnt FROM reminders WHERE status = 'pending'
  `).get();
  console.log(`  Pending reminder: ${pendingRem?.cnt ?? 0}`);

  // 5. Penghitung anggaran model hari ini
  console.log('\n--- 5. Anggaran Model Harian (OpenRouter) ---');
  console.log(`  Hari anggaran : ${budget.day()}`);
  console.log(`  Pemakaian     : ${budget.used()} / ${budget.limit()} panggilan`);
  console.log(`  Sisa kuota    : ${budget.remaining()} panggilan`);
  console.log(`  Habis?        : ${budget.isExhausted() ? 'YA' : 'TIDAK'}`);

  db.close();
} catch (e) {
  console.error(`Gagal membaca database: ${e.message}`);
  process.exit(1);
}

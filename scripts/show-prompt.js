#!/usr/bin/env node
// scripts/show-prompt.js — Cetak system prompt lengkap hasil rakitan prompt.js untuk user tiruan
// Menampilkan perincian token per bagian, total token, dan validasi heading persona.md

import { readFileSync } from 'node:fs';
import config from '../config.js';
import { getNow } from '../src/time.js';
import { buildSystemPrompt } from '../src/prompt.js';
import { estimateTokens } from '../src/memory.js';

// User tiruan representatif
const dummyUser = {
  name: 'Budi Santoso',
  callname: 'Kak Budi',
  relationship_note: 'Teman lama {{callname}} dari kantor.',
  jid: '628123456789@s.whatsapp.net',
};

const dummyFacts = [
  'Suka minum kopi hitam tanpa gula',
  'Bekerja sebagai software engineer',
  'Punya kucing bernama Miko',
];

const dummySummary = 'Pernah mengobrol santai tentang hobi fotografi dan rencana liburan akhir pekan di Bandung.';

// Rakit prompt
const now = getNow();
const prompt = buildSystemPrompt({
  user: dummyUser,
  facts: dummyFacts,
  summary: dummySummary,
  now,
  cfg: config,
});

// --- 1. Bandingkan heading (## dan ###) di persona.md dengan hasil rakitan ---
const personaRaw = readFileSync(config.PERSONA_FILE, 'utf8');
const personaHeadings = [...personaRaw.matchAll(/^#{2,3}\s+.+$/gm)].map((m) => m[0].trim());

const missingHeadings = [];
for (const h of personaHeadings) {
  if (!prompt.includes(h)) {
    missingHeadings.push(h);
  }
}

// --- 2. Pemisahan per bagian untuk estimasi token ---
const markers = [
  { name: 'Persona', startMarker: null, endMarker: '\n\n## KONDISI SAAT INI' },
  { name: 'KONDISI SAAT INI', startMarker: '## KONDISI SAAT INI', endMarker: '\n\n## Fakta tentang' },
  { name: 'Fakta User', startMarker: '## Fakta tentang', endMarker: '\n\n## Ringkasan percakapan lama' },
  { name: 'Ringkasan Percakapan Lama', startMarker: '## Ringkasan percakapan lama', endMarker: '\n\n## Contoh dialog' },
  { name: 'Contoh Dialog', startMarker: '## Contoh dialog', endMarker: '\n\n## Aturan output (KONTRAK KETAT)' },
  { name: 'Aturan Output', startMarker: '## Aturan output (KONTRAK KETAT)', endMarker: null },
];

const sectionBreakdown = [];
let totalTokens = 0;
let totalWords = 0;

for (const m of markers) {
  let content = '';
  if (m.startMarker == null) {
    const endIdx = prompt.indexOf(m.endMarker);
    content = endIdx !== -1 ? prompt.slice(0, endIdx).trim() : prompt.trim();
  } else if (m.endMarker == null) {
    const startIdx = prompt.indexOf(m.startMarker);
    content = startIdx !== -1 ? prompt.slice(startIdx).trim() : '';
  } else {
    const startIdx = prompt.indexOf(m.startMarker);
    const endIdx = prompt.indexOf(m.endMarker);
    content = (startIdx !== -1 && endIdx !== -1) ? prompt.slice(startIdx, endIdx).trim() : '';
  }

  const words = content ? content.split(/\s+/).filter(Boolean).length : 0;
  const tokens = estimateTokens(content, config.TOKENS_PER_WORD ?? 2);
  totalWords += words;
  totalTokens += tokens;

  sectionBreakdown.push({
    name: m.name,
    words,
    tokens,
  });
}

// --- Cetak Laporan Ringkas & Validasi Heading ---
console.log('================================================================================');
console.log('                 CHLOE SYSTEM PROMPT INSPECTOR (SHOW-PROMPT)                    ');
console.log('================================================================================\n');

if (missingHeadings.length > 0) {
  console.log('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
  console.log('⚠️  PERINGATAN KERAS: Terdapat heading dari persona.md yang HILANG di prompt!');
  console.log('Heading yang hilang:');
  for (const mh of missingHeadings) {
    console.log(`  - ❌ ${mh}`);
  }
  console.log('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n');
} else {
  console.log(`✅ [VALIDASI HEADING] Semua ${personaHeadings.length} heading persona.md (## dan ###) lengkap di system prompt!\n`);
  for (const h of personaHeadings) {
    console.log(`   ✔ ${h}`);
  }
  console.log('');
}

console.log('--------------------------------------------------------------------------------');
console.log('PERKIRAAN TOKEN PER BAGIAN (Rumus: 2 token per kata)');
console.log('--------------------------------------------------------------------------------');
for (const s of sectionBreakdown) {
  const padName = s.name.padEnd(28, ' ');
  const padWords = `${s.words} kata`.padStart(12, ' ');
  const padTokens = `~${s.tokens} token`.padStart(14, ' ');
  console.log(`- ${padName} : ${padWords}  | ${padTokens}`);
}
console.log('--------------------------------------------------------------------------------');
const budget = config.PROMPT_TOKEN_BUDGET ?? 10000;
console.log(`TOTAL KESELURUHAN              : ${`${totalWords} kata`.padStart(12, ' ')}  | ${`~${totalTokens} token`.padStart(14, ' ')}`);
console.log(`ANGGARAN TOKEN (BUDGET)        : ~${budget} token`);
console.log(`STATUS ANGGARAN                : ${totalTokens <= budget ? '✅ AMAN (dalam batas anggaran)' : '⚠️ MELEBIHI ANGGARAN'}`);
console.log('================================================================================\n');

console.log('--------------------------------------------------------------------------------');
console.log('ISI SYSTEM PROMPT LENGKAP HASIL RAKITAN:');
console.log('--------------------------------------------------------------------------------\n');
console.log(prompt);
console.log('\n================================================================================');
console.log('                             AKHIR SYSTEM PROMPT                                ');
console.log('================================================================================');

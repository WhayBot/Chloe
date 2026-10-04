// src/mood.js — STUB (Tahap 3). Antarmuka final; logika asli (pemicu, decay, aturan perubahan) di Tahap 7.
// Nilai bawaan sesuai SPEC §9: mood santai intensitas 1, nag_level 0.
import config from '../config.js';

export const VALID_MOODS = config.VALID_MOODS;

/**
 * Mood user saat ini.
 * @returns {{ mood: string, intensity: number, reason: string, since: number|null }}
 */
// eslint-disable-next-line no-unused-vars
export function getMood(jid, now, deps = {}) {
  return { mood: 'santai', intensity: 1, reason: '', since: null }; // TODO(Tahap 7): baca mood_state + FORCE_MOOD
}

/** Tingkat teguran tidur 0-3 (SPEC §4.5). */
// eslint-disable-next-line no-unused-vars
export function getNagLevel(jid, now, deps = {}) {
  return 0; // TODO(Tahap 7)
}

/**
 * Validasi usulan mood dari output model. Murni, sudah final.
 * Nama di luar daftar → null (balasan tetap jalan). delta dibulatkan ke -1/0/+1.
 * @returns {{ name: string, delta: -1|0|1, reason: string } | null}
 */
export function validateMoodProposal(m) {
  if (m == null) return null;
  const obj = typeof m === 'string' ? { name: m } : m;
  if (typeof obj !== 'object' || Array.isArray(obj)) return null;
  const name = typeof obj.name === 'string' ? obj.name.trim().toLowerCase() : '';
  if (!VALID_MOODS.includes(name)) return null;
  const d = Number(obj.delta);
  const delta = Number.isFinite(d) ? Math.max(-1, Math.min(1, Math.round(d))) : 0;
  const reason = typeof obj.reason === 'string' ? obj.reason.trim().slice(0, 120) : '';
  return { name, delta: delta === 0 ? 0 : delta, reason };
}

/**
 * Terapkan usulan mood (kode yang memutuskan). Stub: tidak mengubah apa-apa.
 * @returns {null}
 */
// eslint-disable-next-line no-unused-vars
export function applyMoodProposal(jid, proposal, { serious = false, now } = {}, deps = {}) {
  return null; // TODO(Tahap 7)
}

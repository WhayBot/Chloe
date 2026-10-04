// src/life.js — STUB (Tahap 3). Antarmuka final; logika asli (sleep_plan Markov, fase, aktivitas) di Tahap 6.
// Nilai bawaan sesuai SPEC §9: fase normal, awareness 1, energy 0.7.
// Semua fungsi menerima `now` (epoch ms, dari time.getNow() supaya FAKE_NOW berlaku) dan opsional deps.

export const PHASES = Object.freeze(['tidur', 'bangun', 'larut', 'ngantuk_siang', 'normal']);

const DEFAULTS = Object.freeze({ phase: 'normal', awareness: 1, energy: 0.7 });

/** @returns {'tidur'|'bangun'|'larut'|'ngantuk_siang'|'normal'} */
// eslint-disable-next-line no-unused-vars
export function getPhase(now, deps = {}) {
  return DEFAULTS.phase; // TODO(Tahap 6): hitung dari sleep_plan + FORCE_PHASE
}

/** Kesadaran 0..1. */
// eslint-disable-next-line no-unused-vars
export function getAwareness(now, deps = {}) {
  return DEFAULTS.awareness; // TODO(Tahap 6)
}

/** Energi harian 0.3..1.0. */
// eslint-disable-next-line no-unused-vars
export function getEnergy(now, deps = {}) {
  return DEFAULTS.energy; // TODO(Tahap 6)
}

/**
 * Rencana tidur Chloe untuk malam ini.
 * @returns {{ type: string, sleep_at: number, wake_at: number, groggy_min: number, energy: number } | null}
 */
// eslint-disable-next-line no-unused-vars
export function getSleepPlan(now, deps = {}) {
  return null; // TODO(Tahap 6): buat/ambil sleep_plan
}

/**
 * Aktivitas saat ini / terakhir.
 * @returns {{ state: string, until: number } | null}
 */
// eslint-disable-next-line no-unused-vars
export function getActivity(now, deps = {}) {
  return null; // TODO(Tahap 6)
}

/** Instruksi gaya dari tingkat kesadaran (SPEC §4.2). Murni, sudah final. */
export function awarenessInstruction(a) {
  if (a < 0.3) return 'balasan sangat pendek, ngelantur, kadang salah baca pesan';
  if (a <= 0.7) return 'nyambung tapi lambat, kadang lupa di tengah kalimat';
  return 'normal';
}

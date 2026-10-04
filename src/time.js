// src/time.js — waktu "sekarang" (mendukung FAKE_NOW) + format WIB + kunci hari
import config from '../config.js';

// FAKE_NOW: jam palsu yang tetap berjalan sejak proses start (dipakai untuk logika hidup/prompt).
// Penghitung harian, anggaran model, dan cap waktu DB tetap memakai waktu asli.
const startReal = Date.now();
const fakeStart = config.FAKE_NOW ? Date.parse(config.FAKE_NOW) : NaN;
const fakeOffset = Number.isNaN(fakeStart) ? 0 : fakeStart - startReal;

/** Waktu sekarang untuk logika karakter (epoch ms). */
export function getNow() {
  return Date.now() + fakeOffset;
}

export const isFakeNow = () => fakeOffset !== 0;

const fmtCache = new Map();
function fmt(locale, opts) {
  const k = locale + JSON.stringify(opts);
  if (!fmtCache.has(k)) fmtCache.set(k, new Intl.DateTimeFormat(locale, { timeZone: config.TZ, ...opts }));
  return fmtCache.get(k);
}

/** "Sabtu, 3 Oktober 2026 pukul 20.47 WIB" */
export function formatWibLong(ms) {
  const d = new Date(ms);
  const date = fmt('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(d);
  const time = fmt('id-ID', { hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
  return `${date} pukul ${time} WIB`;
}

/** "20:47" (jam WIB) */
export function formatHHMM(ms) {
  const parts = fmt('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(ms));
  const h = parts.find((p) => p.type === 'hour')?.value ?? '00';
  const m = parts.find((p) => p.type === 'minute')?.value ?? '00';
  return `${h === '24' ? '00' : h}:${m}`;
}

/** Tanggal WIB "YYYY-MM-DD" (batas harian per user, reset 00:00 WIB — SPEC §3). */
export function wibDayKey(ms) {
  return fmt('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}

/** Hari anggaran model "YYYY-MM-DD": hari UTC yang dimulai pada jam resetHourUtc. */
export function budgetDayKey(ms, resetHourUtc = config.MODEL_BUDGET_RESET_HOUR_UTC) {
  return new Date(ms - resetHourUtc * 3600_000).toISOString().slice(0, 10);
}

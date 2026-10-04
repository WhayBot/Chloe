// src/rng.js — RNG ber-seed, satu-satunya sumber acak
// Implementasi: mulberry32 (32-bit, cukup untuk kebutuhan non-kriptografi)

/**
 * Buat RNG dari seed string/number. Kalau seed kosong, pakai Date.now().
 * @param {string|number} [seed]
 */
export function createRng(seed) {
  let state = hashSeed(seed);

  // mulberry32 core
  function next() {
    state |= 0;
    state = (state + 0x6D2B79F5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Float [0, 1) */
  function float() {
    return next();
  }

  /** Integer [min, max] (inklusif) */
  function int(min, max) {
    return Math.floor(next() * (max - min + 1)) + min;
  }

  /** Pilih satu elemen acak dari array */
  function pick(arr) {
    if (!arr.length) return undefined;
    return arr[int(0, arr.length - 1)];
  }

  /**
   * Weighted pick: items = [{ value, weight }, ...]
   * @template T
   * @param {{ value: T, weight: number }[]} items
   * @returns {T}
   */
  function weightedPick(items) {
    const total = items.reduce((s, i) => s + i.weight, 0);
    let r = next() * total;
    for (const item of items) {
      r -= item.weight;
      if (r <= 0) return item.value;
    }
    return items[items.length - 1].value;
  }

  /**
   * Normal distribution (Box-Muller), mean=0, stdev=1
   */
  function normal() {
    let u, v;
    do { u = next(); } while (u === 0);
    v = next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /**
   * Lognormal: exp(mu + sigma * N(0,1))
   * @param {number} mu
   * @param {number} sigma
   */
  function lognormal(mu, sigma) {
    return Math.exp(mu + sigma * normal());
  }

  return { float, int, pick, weightedPick, normal, lognormal, _state: () => state };
}

// --- instans bersama untuk proses (diseed sekali di index.js dari RNG_SEED) ---
let shared = null;
export function initRng(seed) {
  shared = createRng(seed);
  return shared;
}
export function getRng() {
  return shared ?? (shared = createRng());
}

// --- hash seed ke uint32 ---
function hashSeed(seed) {
  if (seed == null || seed === '') return Date.now() | 0;
  if (typeof seed === 'number') return seed | 0;
  // djb2 hash untuk string
  let h = 5381;
  for (let i = 0; i < seed.length; i++) {
    h = ((h << 5) + h + seed.charCodeAt(i)) | 0;
  }
  return h;
}

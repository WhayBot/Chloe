// src/budget.js — anggaran harian global panggilan model (dihitung di DB, lintas restart)
import config from '../config.js';
import { log } from './log.js';
import { budgetDayKey } from './time.js';

/**
 * @param {object} p
 * @param {object} p.db
 * @param {object} [p.cfg]
 * @param {() => number} [p.clock] - waktu ASLI (bukan FAKE_NOW): kuota OpenRouter mengikuti jam nyata
 */
export function createBudget({ db, cfg = config, clock = Date.now }) {
  const day = () => budgetDayKey(clock(), cfg.MODEL_BUDGET_RESET_HOUR_UTC);

  /**
   * Pemakaian hari ini = hitungan lokal + pemakaian dari luar bot (app lain dengan key yang sama)
   * yang terlihat saat sinkron terakhir: remote_used - count_at_sync.
   */
  function used() {
    const row = db.getUsage(day());
    const external = row?.remote_used != null ? Math.max(0, row.remote_used - (row.count_at_sync ?? 0)) : 0;
    return (row?.count ?? 0) + external;
  }

  function remaining() {
    const row = db.getUsage(day());
    // kalau batas akun (hasil sinkron) lebih kecil dari anggaran config, pakai yang lebih kecil
    const cap = row?.remote_limit != null ? Math.min(cfg.MODEL_DAILY_BUDGET, row.remote_limit) : cfg.MODEL_DAILY_BUDGET;
    return Math.max(0, cap - used());
  }

  return {
    day,
    used,
    remaining,
    limit: () => cfg.MODEL_DAILY_BUDGET,
    isExhausted: () => remaining() <= 0,
    /** Catat satu panggilan model yang berhasil (HTTP 200). */
    record() {
      const n = db.bumpUsage(day());
      if (remaining() === 0) log('warn', 'budget', `anggaran model harian habis (${used()}/${cfg.MODEL_DAILY_BUDGET})`, { day: day() });
      return n;
    },

    /**
     * Opsional: sinkron pemakaian dari OpenRouter /api/v1/auth/key (field free_model_daily_requests).
     * Tidak pernah melempar galat; kegagalan hanya dicatat.
     * @returns {Promise<{ ok: boolean, used?: number, limit?: number, error?: string }>}
     */
    async syncRemote({ fetchFn = globalThis.fetch } = {}) {
      try {
        const res = await fetchFn(cfg.OPENROUTER_KEY_URL, {
          headers: { Authorization: `Bearer ${cfg.OPENROUTER_API_KEY}` },
          signal: AbortSignal.timeout(cfg.BUDGET_SYNC_TIMEOUT_MS),
        });
        if (!res.ok) return fail(`HTTP ${res.status}`);
        const body = await res.json();
        // UNVERIFIED (tidak ada di dokumentasi resmi yang dibaca): field ini teramati di respons asli 2026-10-03
        const f = body?.data?.free_model_daily_requests;
        if (!Number.isInteger(f?.used) || !Number.isInteger(f?.limit)) return fail('field free_model_daily_requests tidak ada');
        db.setRemoteUsage(day(), f.used, f.limit, clock());
        log('info', 'budget', 'sinkron kuota OpenRouter', { used: f.used, limit: f.limit, budget: cfg.MODEL_DAILY_BUDGET, remaining: remaining() });
        return { ok: true, used: f.used, limit: f.limit };
      } catch (e) {
        return fail(e?.name === 'TimeoutError' ? 'timeout' : String(e?.message ?? e).slice(0, 120));
      }
    },
  };

  function fail(error) {
    log('warn', 'budget', `sinkron kuota OpenRouter gagal (diabaikan): ${error}`);
    return { ok: false, error };
  }
}

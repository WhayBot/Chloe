// src/worker.js — pemroses antrean inbox. Tanpa Baileys; semua dependensi diinjeksi.
// State antrean ada di DB (tanpa setTimeout); penghitung gagal beruntun hanya di memori.
import config from '../config.js';
import { log, shortJid } from './log.js';
import { assemblePromptMessages, saveFact } from './memory.js';
import { formatHHMM } from './time.js';
import { getRng } from './rng.js';

const maxId = (rows) => rows.reduce((m, r) => (r.id > m ? r.id : m), 0);
const minId = (rows) => rows.reduce((m, r) => (r.id < m ? r.id : m), Infinity);

/**
 * @param {object} p
 * @param {object} p.db
 * @param {() => number} [p.now]
 * @param {(messages: object[], opts: { onSuccess?: Function }) => Promise<{ messages: string[], parsed?: object }>} p.generate
 * @param {(p: { jid: string, texts: string[], parsed: object|null, queuedMessages: object[], kind?: string }) => Promise<Array<{text:string, ts?:number, key?:object}>|void>} p.deliver
 *   boleh mengembalikan daftar pesan terkirim; worker yang menyimpannya sebagai pesan keluar.
 * @param {(jid: string) => object|null|Promise<object|null>} p.getUser
 * @param {(situation: string, user: object) => string[]|string} p.systemReply
 */
export function createWorker({
  db, now = Date.now, generate, deliver, getUser, systemReply,
  cfg = config, rng = getRng(), logFn = log, onSuccess,
}) {
  const inFlight = new Set();
  const fails = new Map(); // jid -> { n, notified }
  let genSeq = 0;
  const lg = (level, msg, extra) => logFn(level, 'worker', msg, extra);

  /** Pesan queued jid yang belum kedaluwarsa; yang kedaluwarsa ditandai 'answered' + batch_id 'expired'. */
  function loadQueued(jid) {
    const t = now();
    const all = db.getQueuedByJid(jid);
    const expired = all.filter((m) => t - m.ts > cfg.QUEUE_EXPIRE_MS);
    if (!expired.length) return all;
    db.markAnsweredByIds(expired.map((m) => m.id), 'expired');
    lg('info', 'pesan kedaluwarsa dilewati', { jid: shortJid(jid), count: expired.length });
    const gone = new Set(expired.map((m) => m.id));
    return all.filter((m) => !gone.has(m.id));
  }

  /** Simpan pesan keluar (dipanggil di dalam transaksi pemanggil). */
  function persistOut(jid, texts, sent, batchId) {
    const items = Array.isArray(sent) && sent.length ? sent : texts.map((text) => ({ text, ts: now() }));
    for (const s of items) {
      db.insertMessage({
        jid, dir: 'out', type: 'text', text: s.text, ts: s.ts ?? now(),
        wa_id: s.key?.id ?? null, wa_key: s.key ?? null, status: 'answered', batch_id: batchId,
      });
    }
  }

  async function processJid(jid) {
    const user = await getUser(jid);
    if (!user) {
      // JID tidak lagi dikenal: jangan jawab dan jangan masuk riwayat
      const q = db.getQueuedByJid(jid);
      db.markAnsweredByIds(q.map((m) => m.id), 'expired');
      db.deleteInbox(jid);
      lg('warn', 'user tidak dikenal, antrean dibuang', { jid: shortJid(jid), count: q.length });
      return;
    }

    let regen = 0;
    while (true) {
      const queued = loadQueued(jid);
      const usable = queued.filter((m) => m.text && m.text.trim());
      if (!usable.length) {
        // tidak ada teks untuk model (kosong/non-teks): selesaikan tanpa generate
        db.markAnsweredByIds(queued.map((m) => m.id), 'skipped');
        db.deleteInbox(jid);
        return;
      }

      const firstId = minId(queued);
      const lastId = maxId(queued);
      const incomingText = usable.map((m) => `[${formatHHMM(m.ts)}] ${m.text}`).join('\n');
      const genId = `g_${now()}_${++genSeq}`;
      db.updateInboxGenId(jid, genId);

      const assembled = assemblePromptMessages({
        db,
        user: { ...user, jid },
        incomingText,
        incomingTs: usable[usable.length - 1].ts,
        beforeMessageId: firstId,
        now: now(),
        cfg,
        rng,
        incomingPreformatted: true,
      });
      const r = await generate(assembled.messages, { onSuccess });

      // pesan baru saat generate, atau gen_id diubah pihak lain → buang hasil, generate ulang
      const row = db.getInboxByJid(jid);
      const changed = maxId(loadQueued(jid)) > lastId || (row != null && row.gen_id !== genId);
      if (changed && regen < cfg.REGEN_MAX) {
        regen++;
        lg('info', 'hasil generate dibuang, ada pesan baru', { jid: shortJid(jid), regen });
        continue;
      }
      if (changed) lg('warn', 'REGEN_MAX tercapai, kirim apa adanya', { jid: shortJid(jid) });

      const texts = r.messages;
      const batchId = `b_${firstId}_${lastId}`;
      const mine = queued.filter((m) => m.id <= lastId);
      const sent = await deliver({ jid, texts, parsed: r.parsed ?? null, queuedMessages: mine });

      for (const act of r.parsed?.actions ?? []) {
        if (act.type === 'save_fact' && act.text) saveFact(db, jid, act.text, now(), cfg);
      }
      db.transaction(() => {
        persistOut(jid, texts, sent, batchId);
        db.markAnsweredByIds(mine.map((m) => m.id), batchId); // pesan yang masuk saat kirim tetap queued
      });
      fails.delete(jid);
      // pesan baru yang belum terjawab → inbox dipertahankan (due_at sudah ditunda enqueueIncoming)
      if (!loadQueued(jid).length) db.deleteInbox(jid);
      lg('info', 'balasan terkirim', { jid: shortJid(jid), count: texts.length, regen });
      return;
    }
  }

  async function onFail(jid, e) {
    const st = fails.get(jid) ?? { n: 0, notified: false };
    st.n++;
    fails.set(jid, st);
    const backoff = cfg.WORKER_BACKOFF_MS;
    const wait = backoff[Math.min(st.n - 1, backoff.length - 1)];
    db.updateInboxDueAt(jid, now() + wait);
    lg('warn', `gagal memproses antrean: ${e?.kind ?? 'error'}`, { jid: shortJid(jid), fails: st.n, retry_ms: wait });

    if (st.n >= cfg.WORKER_FAIL_NOTICE_AT && !st.notified) {
      st.notified = true; // sekali per rentetan gagal
      try {
        const user = await getUser(jid);
        const raw = systemReply('sistem_gagal', user);
        const texts = Array.isArray(raw) ? raw : [String(raw)];
        const sent = await deliver({ jid, texts, parsed: null, queuedMessages: [], kind: 'sistem_gagal' });
        db.transaction(() => persistOut(jid, texts, sent, 'sistem_gagal')); // pesan queued tidak ditandai
      } catch (err) {
        lg('error', `pesan sistem_gagal tidak terkirim: ${err?.message}`, { jid: shortJid(jid) });
      }
    }
  }

  async function run(jid) {
    try {
      await processJid(jid);
    } catch (e) {
      await onFail(jid, e);
    } finally {
      inFlight.delete(jid);
    }
  }

  async function tick() {
    const due = db.getInboxDue(now())
      .filter((r) => !inFlight.has(r.jid))
      .sort((a, b) => a.due_at - b.due_at);
    const picked = due.slice(0, Math.max(0, cfg.WORKER_MAX_PARALLEL - inFlight.size));
    for (const r of picked) inFlight.add(r.jid); // sinkron: tick yang tumpang tindih tidak ambil JID sama
    await Promise.all(picked.map((r) => run(r.jid)));
  }

  /** Jumlah JID yang masih punya baris inbox (due maupun belum). */
  function pendingCount() {
    return db.getInboxDue(Number.MAX_SAFE_INTEGER).length;
  }

  return { tick, pendingCount };
}

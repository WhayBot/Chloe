// tests/whatsapp.test.js — tes filter pesan dan normalisasi nomor
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeNumber,
  buildAllowlist,
  resolveJidToNumber,
  registerLidMapping,
  checkAllowlist,
  filterMessage,
  classifyMessage,
} from '../src/whatsapp.js';

// --- normalizeNumber ---
describe('normalizeNumber', () => {
  it('buang + dan spasi', () => {
    assert.strictEqual(normalizeNumber('+62 812-3456-7890'), '6281234567890');
  });
  it('buang kurung dan strip', () => {
    assert.strictEqual(normalizeNumber('(+62) 812-345'), '62812345');
  });
  it('angka polos tidak berubah', () => {
    assert.strictEqual(normalizeNumber('628123'), '628123');
  });
});

// --- buildAllowlist ---
const testUsers = [
  { number: '628111', name: 'A', callname: 'Bos', is_owner: true, relationship_note: '' },
  { number: '+62-822-2222', name: 'B', callname: 'Kak', is_owner: false, relationship_note: '' },
];

describe('buildAllowlist', () => {
  it('membangun map dari nomor yang dinormalisasi', () => {
    const al = buildAllowlist(testUsers);
    assert.ok(al.has('628111'));
    assert.ok(al.has('628222222'));
    assert.ok(!al.has('+62-822-2222')); // versi mentah tidak ada
  });
});

// --- resolveJidToNumber ---
describe('resolveJidToNumber', () => {
  it('JID @s.whatsapp.net → nomor', () => {
    assert.strictEqual(resolveJidToNumber('628111@s.whatsapp.net'), '628111');
  });

  it('JID @lid tanpa pemetaan → null', () => {
    assert.strictEqual(resolveJidToNumber('99887766@lid'), null);
  });

  it('JID @lid dengan pemetaan → nomor', () => {
    registerLidMapping('55443322', '628111');
    assert.strictEqual(resolveJidToNumber('55443322@lid'), '628111');
  });

  it('JID @g.us → null (bukan nomor pribadi)', () => {
    // jidDecode masih bisa decode tapi server=g.us bukan s.whatsapp.net
    const result = resolveJidToNumber('123456@g.us');
    assert.strictEqual(result, null);
  });
});

// --- checkAllowlist ---
describe('checkAllowlist', () => {
  const al = buildAllowlist(testUsers);

  it('nomor yang ada di allowlist → berhasil', () => {
    const r = checkAllowlist('628111@s.whatsapp.net', al);
    assert.ok(r);
    assert.strictEqual(r.number, '628111');
    assert.strictEqual(r.user.name, 'A');
  });

  it('nomor yang tidak ada → null', () => {
    assert.strictEqual(checkAllowlist('629999@s.whatsapp.net', al), null);
  });

  it('grup → null', () => {
    assert.strictEqual(checkAllowlist('123456@g.us', al), null);
  });
});

// --- classifyMessage ---
describe('classifyMessage', () => {
  it('conversation → text', () => {
    const { msgType, text } = classifyMessage({ conversation: 'halo' }, 'conversation');
    assert.strictEqual(msgType, 'text');
    assert.strictEqual(text, 'halo');
  });

  it('extendedTextMessage → text', () => {
    const { msgType, text } = classifyMessage(
      { extendedTextMessage: { text: 'yo' } }, 'extendedTextMessage'
    );
    assert.strictEqual(msgType, 'text');
    assert.strictEqual(text, 'yo');
  });

  it('imageMessage → image, caption dibaca', () => {
    const { msgType, text } = classifyMessage(
      { imageMessage: { caption: 'foto saya' } }, 'imageMessage'
    );
    assert.strictEqual(msgType, 'image');
    assert.strictEqual(text, 'foto saya');
  });

  it('imageMessage tanpa caption → text kosong', () => {
    const { msgType, text } = classifyMessage(
      { imageMessage: {} }, 'imageMessage'
    );
    assert.strictEqual(msgType, 'image');
    assert.strictEqual(text, '');
  });

  it('audioMessage → audio', () => {
    const { msgType } = classifyMessage({ audioMessage: {} }, 'audioMessage');
    assert.strictEqual(msgType, 'audio');
  });

  it('stickerMessage → sticker', () => {
    const { msgType } = classifyMessage({ stickerMessage: {} }, 'stickerMessage');
    assert.strictEqual(msgType, 'sticker');
  });

  it('contentType null → unknown', () => {
    const { msgType } = classifyMessage({}, null);
    assert.strictEqual(msgType, 'unknown');
  });
});

// --- filterMessage (event palsu) ---
describe('filterMessage', () => {
  const al = buildAllowlist(testUsers);
  const nowSec = Math.floor(Date.now() / 1000);

  function makeMsg(overrides) {
    return {
      key: {
        remoteJid: '628111@s.whatsapp.net',
        fromMe: false,
        id: 'msg_' + Math.random().toString(36).slice(2),
        ...overrides.key,
      },
      messageTimestamp: overrides.messageTimestamp ?? nowSec,
      message: overrides.message ?? { conversation: 'test' },
    };
  }

  it('pesan valid dari allowlist → pass', () => {
    const r = filterMessage(makeMsg({}), al);
    assert.ok(r.pass);
    assert.strictEqual(r.msgType, 'text');
    assert.strictEqual(r.text, 'test');
    assert.strictEqual(r.number, '628111');
  });

  it('fromMe → ditolak', () => {
    const r = filterMessage(makeMsg({ key: { fromMe: true } }), al);
    assert.ok(!r.pass);
    assert.strictEqual(r.reason, 'fromMe');
  });

  it('grup → ditolak', () => {
    const r = filterMessage(makeMsg({ key: { remoteJid: '123@g.us' } }), al);
    assert.ok(!r.pass);
    assert.strictEqual(r.reason, 'group');
  });

  it('broadcast → ditolak', () => {
    const r = filterMessage(makeMsg({ key: { remoteJid: 'status@broadcast' } }), al);
    assert.ok(!r.pass);
    assert.strictEqual(r.reason, 'broadcast');
  });

  it('nomor di luar allowlist → ditolak', () => {
    const r = filterMessage(makeMsg({ key: { remoteJid: '629999@s.whatsapp.net' } }), al);
    assert.ok(!r.pass);
    assert.strictEqual(r.reason, 'not_allowed');
  });

  it('pesan terlalu tua (> 24 jam) → ditolak', () => {
    const oldTs = Math.floor(Date.now() / 1000) - 25 * 3600; // 25 jam lalu
    const r = filterMessage(makeMsg({ messageTimestamp: oldTs }), al);
    assert.ok(!r.pass);
    assert.strictEqual(r.reason, 'too_old');
  });

  it('pesan tanpa message content → ditolak', () => {
    const msg = {
      key: {
        remoteJid: '628111@s.whatsapp.net',
        fromMe: false,
        id: 'no_content_1',
      },
      messageTimestamp: nowSec,
      // message sengaja tidak ada
    };
    const r = filterMessage(msg, al);
    assert.ok(!r.pass);
    assert.strictEqual(r.reason, 'no_content');
  });

  it('pesan non-teks (gambar) → pass dengan type image', () => {
    const r = filterMessage(makeMsg({
      message: { imageMessage: { caption: 'lihat ini' } },
    }), al);
    assert.ok(r.pass);
    assert.strictEqual(r.msgType, 'image');
    assert.strictEqual(r.text, 'lihat ini');
  });

  it('timestamp dalam milidetik tetap dihitung benar', () => {
    const tsMs = Date.now() - 1000; // 1 detik lalu (dalam ms, > 1e12)
    const r = filterMessage(makeMsg({ messageTimestamp: tsMs }), al);
    assert.ok(r.pass);
  });

  it('timestamp protobuf Long object', () => {
    const r = filterMessage(makeMsg({
      messageTimestamp: { low: nowSec, high: 0, unsigned: true },
    }), al);
    assert.ok(r.pass);
  });

  it('@lid dengan key.senderPn di allowlist → pass, canonicalJid berbasis nomor', () => {
    const r = filterMessage(makeMsg({
      key: { remoteJid: '11122233@lid', senderPn: '628222222@s.whatsapp.net' },
    }), al);
    assert.ok(r.pass);
    assert.strictEqual(r.number, '628222222');
    assert.strictEqual(r.canonicalJid, '628222222@s.whatsapp.net');
    // pemetaan tersimpan untuk pesan berikutnya tanpa senderPn
    assert.strictEqual(resolveJidToNumber('11122233@lid'), '628222222');
  });

  it('@lid dengan senderPn di luar allowlist → ditolak', () => {
    const r = filterMessage(makeMsg({
      key: { remoteJid: '44455566@lid', senderPn: '629999@s.whatsapp.net' },
    }), al);
    assert.ok(!r.pass);
    assert.strictEqual(r.reason, 'not_allowed');
  });

  it('protocolMessage (hapus/edit) → ditolak', () => {
    const r = filterMessage(makeMsg({ message: { protocolMessage: { type: 0 } } }), al);
    assert.ok(!r.pass);
    assert.strictEqual(r.reason, 'non_message');
  });

  it('reactionMessage → ditolak', () => {
    const r = filterMessage(makeMsg({ message: { reactionMessage: { text: '👍' } } }), al);
    assert.ok(!r.pass);
    assert.strictEqual(r.reason, 'non_message');
  });

  it('ephemeralMessage (pesan sementara) → teks dibuka', () => {
    const r = filterMessage(makeMsg({
      message: { ephemeralMessage: { message: { extendedTextMessage: { text: 'rahasia' } } } },
    }), al);
    assert.ok(r.pass);
    assert.strictEqual(r.msgType, 'text');
    assert.strictEqual(r.text, 'rahasia');
  });
});

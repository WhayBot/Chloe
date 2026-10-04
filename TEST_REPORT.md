# Panduan Uji Manual & Lembar Laporan Sementara (Tahap 1)

Gunakan file ini sebagai checklist dan tempat mencatat hasil pengujian di HP dan laptop. Setelah selesai, kamu bisa menyalin bagian **Form Hasil Pengujian** untuk dievaluasi bersama.

---

## A. Langkah-Langkah Persiapan

Sebelum mulai menjalankan kode, siapkan konfigurasi awal:

1. **Salin dan isi file `.env`**:
   Salin dari [`.env.example`](file:///e:/Chloe-Assist/.env.example):
   ```bash
   cp .env.example .env
   ```
   Pastikan variabel berikut terisi di `.env`:
   ```env
   BOT_NUMBER=628xxxxxxxxxx      # Nomor HP bot (hanya digit, tanpa +, diawali kode negara 62)
   DRY_RUN=1                     # Mulai dengan mode simulasi (tanpa kirim pesan beneran)
   ```

2. **Salin dan isi file `users.json`**:
   Salin dari [`users.example.json`](file:///e:/Chloe-Assist/users.example.json):
   ```bash
   cp users.example.json users.json
   ```
   Edit `users.json`, masukkan nomormu (HP pribadi yang akan dipakai chat ke bot):
   ```json
   [
     {
       "number": "628yyyyyyyyyy",
       "name": "Nama Kamu",
       "callname": "Kak",
       "is_owner": true,
       "relationship_note": ""
     }
   ]
   ```

3. **Nomor cadangan (opsional)**:
   Siapkan 1 nomor lain (teman / nomor HP kedua) yang sengaja **TIDAK** didaftarkan di `users.json` untuk pengujian allowlist (Tes 3).

---

## B. Prosedur Pengujian Langkah demi Langkah

### Tes 1: Pairing Code (Sekali saja)
1. Buka terminal di laptop, jalankan:
   ```bash
   node src/index.js
   ```
2. Tunggu banner berikut muncul di terminal:
   ```text
   ══════════════════════════════
     PAIRING CODE: XXXXXXXX
   ══════════════════════════════
   ```
3. Di HP Bot:
   - Buka WhatsApp > Titik tiga / Pengaturan > **Perangkat Tertaut (Linked Devices)**.
   - Pilih **Tautkan Perangkat (Link a Device)**.
   - Klik **Tautkan dengan nomor telepon saja (Link with phone number instead)** di bagian bawah.
   - Masukkan 8 karakter kode pairing yang tertera di terminal.
4. **Verifikasi**:
   - Terminal menampilkan: `[INFO] [wa] Terhubung ke WhatsApp`.
   - Pairing tidak berulang/looping kode baru.

---

### Tes 2: Pesan Masuk dari Nomor Terdaftar (`DRY_RUN=1`)
1. Pastikan bot masih berjalan dengan `DRY_RUN=1`.
2. Dari HP pribadimu (nomor yang ada di `users.json`), kirim pesan: `tes`.
3. **Verifikasi di konsol terminal**:
   - Muncul log:
     ```text
     [INFO] [wa] pesan masuk {"jid_raw":"...","type":"text","number":"..."}
     [INFO] [wa] [DRY_RUN] balas ke ...: halo
     ```
   - HP kamu **tidak** menerima chat balasan (karena `DRY_RUN=1`).
   - Perhatikan format `jid_raw` (apakah berakhiran `@s.whatsapp.net` atau `@lid`).

---

### Tes 3: Filter Nomor Asing (Di luar Allowlist)
1. Bot masih berjalan.
2. Dari nomor lain yang **tidak terdaftar** di `users.json`, kirim pesan apa saja (misal: `halo`).
3. **Verifikasi**:
   - Konsol terminal menampilkan penolakan:
     ```text
     [DEBUG] [wa] pesan ditolak: not_allowed ...
     ```
   - Bot sama sekali tidak membalas ke pengirim tersebut.
   - Bot tidak mengalami crash.

---

### Tes 4: Balasan Sungguhan (`DRY_RUN=0`)
1. Hentikan bot di terminal dengan menekan `Ctrl + C`.
2. Buka `.env`, ubah:
   ```env
   DRY_RUN=0
   ```
3. Jalankan kembali:
   ```bash
   node src/index.js
   ```
4. Perhatikan: bot harus langsung terhubung (`Terhubung ke WhatsApp`) **tanpa meminta pairing code baru** (memakai sesi di `auth/`).
5. Dari HP pribadimu, kirim pesan: `tes`.
6. **Verifikasi**:
   - Di terminal muncul log: `[INFO] [wa] balas "halo" ke ...`.
   - Di HP pribadimu, chat masuk menerima balasan: `halo`.

---

### Tes 5: Reconnect Otomatis Saat Jaringan Terputus
1. Biarkan bot tetap berjalan.
2. Matikan koneksi WiFi/Internet di laptop selama 2–3 menit.
3. Di terminal akan muncul log: `[WARN] [wa] Koneksi terputus (...), reconnect ke-1 dalam ...`.
4. Nyalakan kembali WiFi/Internet laptop.
5. **Verifikasi**:
   - Bot mencoba reconnect otomatis dengan jeda backoff.
   - Setelah internet pulih, bot kembali mencatat: `[INFO] [wa] Terhubung ke WhatsApp`.

---

### Tes 6: Restart Proses
1. Hentikan proses bot dengan `Ctrl + C`.
2. Jalankan ulang:
   ```bash
   node src/index.js
   ```
3. **Verifikasi**:
   - Bot membaca kredensial lama di folder `auth/` dan langsung tersambung tanpa meminta pairing code lagi.

---

### Tes 7: Pesan Non-Teks
1. Bot sedang berjalan aktif.
2. Dari HP pribadimu, kirim berturut-turut:
   - 1 foto/gambar (coba dengan caption atau tanpa caption).
   - 1 stiker.
   - 1 voice note / audio.
3. **Verifikasi**:
   - Terminal mencatat `type: "image"`, `type: "sticker"`, `type: "audio"`.
   - Bot tidak melempar uncaught exception / crash.
   - Bot membalas "halo" dengan normal.

---

### Tes 8: Automated Unit Tests
Jalankan di terminal laptop untuk memastikan seluruh unit test lulus:
```bash
npm test
```

---

## C. Form Hasil Pengujian (Isi dan Kirim Balik)

Salin bagian ini dan lengkapi hasilnya setelah pengujian:

```markdown
### Laporan Uji Manual Tahap 1

1. **Hasil Setiap Tes**:
   - Tes 1 (Pairing Code)      : Berhasil — pairing kode GK71MCZT sukses, stream restart normal.
   - Tes 2 (Pesan DRY_RUN=1)   : Berhasil — pesan teks masuk, [DRY_RUN] balas tercatat di log.
   - Tes 3 (Nomor Asing)       : Berhasil — 7x pesan dari 339…073 ditolak (not_allowed), bot diam dan stabil.
   - Tes 4 (Balasan Sungguhan) : Berhasil — DRY_RUN=false, bot membalas "halo" ke 134…838.
   - Tes 5 (Reconnect Jaringan): Berhasil — backoff jalan saat disconnect (428 / ENOTFOUND), reconnect otomatis pulih.
   - Tes 6 (Restart Proses)    : Berhasil — sesi auth/ terpakai langsung tanpa minta pairing baru.
   - Tes 7 (Pesan Non-Teks)    : Berhasil — image, sticker, audio diproses tanpa crash.

2. **Format JID yang Muncul di Log**:
   - JID Raw   : 134810567708838@lid
   - Sender PN : Ada (628…388) → pemetaan ke allowlist berjalan mulus.

3. **Potongan Log Error**:
   - Tidak ada error fatal (hanya error jaringan 428/408 sementara yang tertangani otomatis oleh reconnection loop).

4. **Ringkasan Output `npm test`**:
   - Total test passed : 67 / 67 (24 suites)
   - Status            : Semua hijau (0 fail, durasi ~1.8s)
```

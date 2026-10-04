# SPEC.md: rancangan agent WhatsApp "Chloe"

Semua angka di dokumen ini adalah **nilai awal**, taruh di `config.js` supaya mudah disetel.

## 1. Gambaran

Agent WhatsApp berkarakter (teman ngobrol + asisten pribadi) dengan ingatan jangka panjang,
mood, jadwal tidur sendiri, delay dan gaya balas yang terasa manusiawi. Berjalan satu proses di Termux.

```
WhatsApp (Baileys)
   │ pesan masuk
   ▼
inbox (DB, due_at) ──► worker (tick 3 dtk) ──► agent (OpenRouter) ──► humanize ──► kirim
                          ▲                        ▲
                     life/mood/sleep          memory/tools
scheduler (reminder) ───────────────────────────────┘ (jalur terpisah, tepat waktu)
```

## 2. Data (tabel / koleksi)

| Tabel | Kolom penting |
|---|---|
| `users` | jid, name, callname, relationship_note, is_owner, allowed, daily_count, daily_date, created_at |
| `messages` | id, jid, dir (in/out), type, text, ts, wa_id (unik), wa_key (JSON key Baileys, untuk read/react), status (queued/answered), batch_id |
| `inbox` | jid, due_at, first_msg_ts, last_msg_ts, gen_id |
| `mood_state` | jid, mood, intensity (1-5), reason, since, last_change, nag_level (0-3), nag_updated |
| `facts` | id, jid, text, ts |
| `summaries` | jid, text, upto_msg_id, ts |
| `notes` | id, jid, title, body, ts |
| `reminders` | id, jid, due_at, text, status (pending/sent), created_at |
| `sleep_plan` | date, type, sleep_at, wake_at, groggy_min, energy |
| `activity` | state (mandi/makan/nonton/tidur_siang/...), until |
| `event_log` | ts, kind, detail (JSON) |
| `jid_map` | lid (PK), number, source (`sender_pn`/`users_json`), updated_at. *Perubahan SPEC (Tahap 1 revisi): pemetaan JID `@lid` → nomor, permanen lintas restart; `users.json` boleh punya field opsional `jid` (`<angka>@lid`) untuk pengikatan manual yang menang atas `sender_pn`.* |

Kondisi hidup Chloe (`sleep_plan`, `activity`, energi) **global**, satu untuk semua user. Mood dan memori **per user**.

## 3. Alur pesan masuk (inbox + debounce)

1. Baileys menerima pesan → **filter** → cek allowlist dan batas harian (reset 00:00 WIB) → simpan di `messages` (status `queued`).
   - Hanya proses `messages.upsert` bertipe `notify`. Abaikan: grup, broadcast/status, pesan dari diri sendiri (`fromMe`).
   - Dedup berdasarkan `wa_id` (Baileys bisa mengirim ulang, dan saat pertama pairing ada history sync lama yang **tidak boleh dibalas**).
   - Pesan lebih tua dari 24 jam diabaikan.
   - Pesan non-teks (gambar, voice note, stiker): simpan sebagai `type` terkait, lalu balas dengan gaya karakter bahwa
     dia belum bisa membukanya. Jangan kirim ke model sebagai teks kosong. (Caption tetap dibaca sebagai teks.)
     Kalimatnya diambil acak dari `examples.md` situasi `media_tidak_bisa`, tanpa memanggil model.
   - Cocokkan allowlist berdasarkan **nomor yang dinormalisasi**. Versi Baileys terbaru bisa memberi JID format `@lid`
     (bukan nomor telepon); agent harus membaca dokumentasi versi terpasang, mencatat JID asli di log saat tes,
     dan memetakan ke nomor di `users`.
2. Hitung `due_at` = sekarang + delay (bagian 5) dan simpan/perbarui di `inbox`.
   - Kalau sudah ada inbox pending untuk JID itu, **pesan baru ikut digabung** dan `due_at` tidak dimajukan.
     Jika pesan baru datang dalam ~2-6 detik (acak) sebelum `due_at`, tunda `due_at` sedikit (user masih mengetik).
3. Subscribe presence (`presenceSubscribe`). Selama user berstatus `composing`, `due_at` ditunda. Ini **best-effort**:
   presence tidak selalu terkirim, jadi debounce berbasis waktu (poin 2) tetap jadi pegangan utama.
4. Worker tiap ~3 detik: untuk inbox dengan `due_at <= now`:
   - Cek fase hidup (bagian 4). Jika tidur → atur ulang (bagian 4.4). Jika sibuk → tunda sesuai aktivitas.
   - Panggil `readMessages` (centang biru), tunggu sebentar (acak), lalu generate balasan.
   - Beri `gen_id` pada generate. **Kalau pesan baru masuk saat generate berjalan dan balasan belum terkirim,
     batalkan balasan itu dan generate ulang dengan semua pesan.**
5. Semua pesan `queued` untuk JID itu digabung jadi satu input, dengan cap waktu ("[02:14] ...").

## 4. Kehidupan Chloe

### 4.1 Rencana tidur harian (`life.js`)

Saat Chloe bangun (atau saat start jika belum ada), buat `sleep_plan` untuk malam berikutnya:

| Tipe | Tidur | Bangun | Peluang dasar |
|---|---|---|---|
| normal | ~00:30 | ~06:00 | 50% |
| sehat | ~21:00 | ~05:00 | 20% |
| berantakan | ~03:00 | ~09:00 | 30% |

- Jam digeser acak ±20-30 menit.
- Pilih tipe dengan **Markov chain**: peluang dipengaruhi tipe kemarin.
  - setelah `berantakan`: `sehat` naik jadi ~40%
  - setelah 3+ hari `normal` berturut: `berantakan` naik jadi ~40%
  - kalau user ngobrol lewat tengah malam kemarin: tidur mundur 15-45 menit
- `groggy_min` = acak 10-15 menit (bisa +5 di hari berantakan).
- Simpan energi harian `energy` ∈ [0.3, 1.0] dengan random walk pelan; hari berantakan menurunkannya.
- Saat start pertama kali (belum ada riwayat), anggap kemarin bertipe `normal` lalu buat rencana untuk malam ini.

### 4.2 Fase dan kesadaran

`getPhase(now)` mengembalikan salah satu fase berikut, dihitung dari `sleep_plan`:
- `tidur`: dari `sleep_at` sampai `wake_at`.
- `bangun` (groggy): dari `wake_at` sampai `wake_at + groggy_min`.
- `larut`: 90 menit sebelum `sleep_at` sampai `sleep_at`.
- `ngantuk_siang`: 13:00-15:00 WIB (kecuali sedang `tidur`/`bangun`).
- `normal`: selain itu.

`sleep_plan.date` = tanggal malam saat tidur dimulai; `wake_at` jatuh di hari berikutnya. Hati-hati dengan perhitungan yang melewati tengah malam.
`getAwareness(now)` mengembalikan 0..1:
- fase `bangun`: naik linear dari 0 ke 1 selama `groggy_min`.
- selain itu: 1 (fase `larut` ~0.8).

Instruksi prompt dari kesadaran:
- <0.3: balasan sangat pendek, ngelantur, kadang salah baca pesan.
- 0.3-0.7: nyambung tapi lambat, kadang lupa di tengah kalimat.
- >0.7: normal.

**Typo disuntik oleh kode** (`humanize.js`): peluang typo per kata = (1 - awareness) × 0.15; jenis: tukar huruf, hapus huruf, ganda huruf.
**Jangan pernah** menyuntik typo ke angka, jam, tanggal, nama orang, isi reminder/catatan, atau teks hasil tool. Typo hanya untuk kata obrolan biasa.

### 4.3 Aktivitas acak

Beberapa kali sehari (di luar tidur), Chloe punya aktivitas: mandi (10-25 mnt), makan (15-30), nonton (30-120),
tidur siang dadakan (30-90, hanya di hari berantakan atau energi rendah). Selama aktivitas, `due_at` ditunda sampai selesai,
dan aktivitas dimasukkan ke prompt agar dia bisa menceritakan ("tadi lagi mandi").

### 4.4 Saat pesan masuk ketika tidur

- Pesan masuk antrean, tidak dibaca (tanpa centang biru).
- Tiap pesan menambah peluang **kebangun**: p = 0.04 + 0.03 × jumlah pesan (maks 0.35). Jika kebangun, awareness mulai dari 0
  dan balasan dibuat kesal dan ngantuk, lalu dia "tidur lagi" (sisa tidur dilanjutkan). `due_at` balasan saat kebangun = sekarang + acak 1-6 menit.
- Jika tidak kebangun: `due_at` = `wake_at` + acak 1-20 menit (condong ke awal, supaya balasan pertama sering jatuh di masa setengah sadar). Pesan menumpuk dibalas sekaligus.
- **Reminder tidak ikut diblok** (bagian 8).

### 4.5 Teguran jam tidur user

- Jendela "user larut" = 23:30-05:00 WIB (config).
- `nag_level` (per user, di `mood_state`) naik 1 (maks 3) tiap kali Chloe membalas user di dalam jendela itu.
  Reset ke 0 kalau user tidak chat ≥ 2 jam, atau saat lewat 05:00.
- `nag_level` dikirim ke prompt di KONDISI SAAT INI: 0 = jangan menegur, 1 = lembut, 2 = ngomel tegas, 3 = menyerah dengan drama atau pura-pura tidur.
- Opsional di level 3: pura-pura tidur, `due_at` ditunda 30-90 menit (kecuali ada permintaan fungsional).
- Permintaan fungsional (reminder, catatan, pertanyaan nyata) tetap dikerjakan di semua level.

## 5. Delay balasan (`humanize.js`)

`delay = exp(mu + sigma × N(0,1)) × faktor`, dalam detik, dengan `faktor = (1.5 - energy) × DELAY_SCALE` (rentang ≈ 0.5-1.2). Jika `DELAY_SCALE=0`, lewati semua batas dan delay = 0.

| Fase | Median | Sigma | Batas |
|---|---|---|---|
| normal | 20 dtk | 0.9 | 3 dtk - 8 mnt |
| bangun | 180 dtk | 0.7 | 60 dtk - 15 mnt |
| ngantuk_siang | 70 dtk | 0.8 | 15 dtk - 12 mnt |
| larut | 240 dtk | 0.8 | 40 dtk - 20 mnt |
| tidur | lihat 4.4 | - | - |

Modifier:
- Kata kunci darurat ("urgent", "penting", "darurat", dll.): delay dibagi 5, abaikan tidur ringan (tetap kesal).
- Mood `ngambek`: delay ×1.5. Mood `manja`/`ceria`: ×0.7.
- Sesekali (≈8%): dibaca doang lalu dibalas belakangan; (≈5%): hanya reaksi emoji pada pesan.
  Dua variasi ini **tidak dipakai** kalau pesan user berisi permintaan fungsional atau pertanyaan, atau kalau balasan model berisi `actions`/`query`.

### Tampilan ngetik

Setelah delay: `readMessages` → jeda 0.5-3 dtk → `composing` dengan durasi ∝ panjang balasan (≈ 40-80 ms per karakter, acak),
sesekali berhenti (`paused`) lalu `composing` lagi. Balasan multi-pesan dikirim satu-satu dengan jeda 0.8-4 dtk.

## 6. Mood (`mood.js`)

State per user: `mood`, `intensity (1-5)`, `reason`, `since`.

Sumber perubahan:
1. **Isi pesan** → model mengusulkan lewat field `mood` di outputnya (`{name, delta, reason}`). **Kode yang memutuskan**:
   - perubahan intensitas maksimal ±1 per balasan, ganti jenis mood hanya jika intensitas lama ≤ 2 atau usulan kuat berulang;
   - tidak boleh pindah dari mood ekstrem ke ekstrem sebaliknya dalam 1-2 pesan.
2. **Aturan kode** (tanpa model):
   - saat user chat lagi setelah jeda >6 jam (jeda tidur malam 00:00-06:00 tidak dihitung) → `ngambek` ringan atau `murung`; jeda >24 jam → intensitas naik
   - jam larut → `males`/`ngantuk` ; baru bangun → `ngantuk`
   - dibujuk setelah ngambek → turun 1-2 tingkat
3. **Decay**: tiap 20-40 menit tanpa kejadian, intensitas turun 1; di 0 kembali ke `santai`.
4. **Variasi harian**: tiap hari 15% peluang mood awal "tanpa alasan" (misal males). Dicatat di `event_log`.
5. **Mode serius**: kalau model menandai `serious: true`, mood negatif dimatikan sementara untuk balasan itu.
6. **Batas ngambek**: intensitas `ngambek`/`murung` yang dipicu karena user lama tidak chat dibatasi **maksimal 3**.
   Ngambek harus reda otomatis maksimal 30 menit setelah user membalas, atau 1-2 pesan bujukan.

Nama mood yang valid: `santai, ceria, manja, ngambek, males, dongkol, lembut, salting, murung, ngantuk`. Nama lain ditolak kode.
`delta` (-1, 0, +1) = perubahan intensitas untuk mood yang diusulkan. Kalau `name` sama dengan mood sekarang → intensitas ± delta.
Kalau beda dan aturan di atas mengizinkan → mood berganti dengan intensitas awal 1-2.

Pemicu isi pesan (tabel lengkap ada di `persona.md` bagian 4; diajarkan ke model lewat prompt): pujian → senang/salting; curhat → lembut;
diledek → pura-pura sebal; disuruh-suruh kasar → males/dongkol; dibandingkan dengan bot lain → cemburu/ngambek;
janji dilanggar → ngambek ringan; diajak begadang → males tapi manja; kejutan/tebak-tebakan → ceria.

## 7. Prompt dan output model (`prompt.js`, `agent.js`)

### Susunan system prompt (urutan penting)

1. `persona.md` (placeholder `{{name}}` = `CHARACTER_NAME` dari `.env`, `{{callname}}`, `{{relationship_note}}` diisi dari config/`users`; `examples.md` memakai placeholder yang sama).
   `relationship_note` sendiri memuat `{{callname}}`, jadi substitusi dua tahap: `{{relationship_note}}` dulu, baru `{{callname}}` dan `{{name}}`.
   Baris berawalan `>` di bagian awal `persona.md` dan `examples.md` adalah komentar: buang sebelum dipakai. Placeholder yang tidak dikenal harus memunculkan galat saat start, bukan lolos diam-diam.
2. **KONDISI SAAT INI**: waktu WIB (hari, tanggal, jam), fase, kesadaran, mood + intensitas + alasan,
   rencana tidur Chloe hari ini, aktivitas terakhir, energi, `nag_level` user
3. **Fakta tentang user** (maks N terbaru/relevan)
4. **Ringkasan percakapan lama**
5. **Contoh dialog**: 3-5 dipilih acak dari `examples.md` sesuai mood/fase/situasi, diawali kalimat "hanya gaya, jangan disalin"
6. **Aturan output** (di bawah)

Lalu: 20-30 pesan terakhir sebagai riwayat, diikuti pesan baru (digabung, ber-cap waktu).

### Format output (JSON saja)

```json
{
  "messages": ["pesan 1", "pesan 2"],
  "reaction": null,
  "mood": { "name": "ngambek", "delta": 1, "reason": "dicuekin seharian" },
  "serious": false,
  "actions": [
    { "type": "add_reminder", "time": "2026-10-04T07:00:00+07:00", "text": "bayar listrik" },
    { "type": "save_note", "title": "belanja", "body": "sabun" },
    { "type": "save_fact", "text": "suka teh tanpa gula" }
  ],
  "query": null
}
```

- Pakai kontrak JSON (bukan native tool calling) karena model gratis tidak seragam. Kalau model mendukung tool calling,
  boleh ditambahkan nanti sebagai optimisasi.
- `query` untuk aksi yang butuh hasil (`search_notes`, `list_reminders`): jalankan, tambahkan hasil ke konteks,
  panggil model lagi. **Maksimal 2 putaran.**
- Parsing toleran: buang pagar ```json, perbaiki koma ekstra; jika tetap gagal, pakai teks mentah sebagai satu pesan.
- Validasi di kode: tanggal reminder harus valid dan di masa depan; `messages` maks 4 dan tidak kosong.
- Kalau ada `action` yang gagal validasi, kode memanggil model **sekali lagi** dengan pesan galat supaya balasan tidak mengaku berhasil.
  Kalau waktu reminder tidak jelas ("nanti sore"), model harus bertanya, bukan menebak.
- Temperature ~0.7. `max_tokens` dibatasi.

### Memori jangka panjang (`memory.js`)

- **Ringkasan:** kalau pesan yang belum diringkas > 40, ambil 20 pesan tertua, minta model membuat ringkasan singkat
  (gabungkan dengan ringkasan lama, maks ~300 kata), simpan, tandai `upto_msg_id`. Jalankan di latar belakang, bukan saat user menunggu.
- **Fakta:** hanya disimpan lewat `save_fact`. Cek duplikat sederhana (kemiripan teks), batas jumlah per user (misal 100);
  fakta lama dengan konflik diganti yang baru. Fakta yang dikatakan user tentang **orang lain atau hal sensitif** (kesehatan, alamat, dll.)
  tidak disimpan kecuali user memintanya.
- **Anggaran token:** persona + kondisi + fakta + ringkasan + contoh + riwayat dijaga di bawah batas (config). Kalau melebihi,
  potong riwayat terlama dulu, lalu fakta paling lama.

### Kegagalan model

- Kalau semua model gagal (429, timeout, JSON rusak setelah 1 retry): pesan **tetap `queued`**, `due_at` diundur dengan backoff
  (30 dtk → 2 mnt → 10 mnt, maks 1 jam). Jangan kehilangan pesan dan jangan diam selamanya.
- Setelah gagal ≥ 3 kali berturut-turut, kirim satu pesan singkat bergaya karakter, sekali saja. Pesan sistem seperti ini
  (gagal model, batas harian, media tidak bisa dibuka) **diambil acak dari `examples.md`** (situasi `sistem_gagal`,
  `sistem_batas_harian`, `media_tidak_bisa`) tanpa memanggil model.
- Opsional: gunakan `response_format: json_object` jika model mendukung; jangan bergantung padanya.

### Anti-pola (`humanize.js`)

- Simpan 8 balasan terakhir. Hitung kemiripan pembukaan, emoji, dan akhiran. Jika terlalu sering sama
  (misal "~" di 4 balasan berturut-turut), kode menambahkan petunjuk "jangan pakai X kali ini" ke prompt, atau
  minta regenerasi 1 kali.
- Jumlah pesan per balasan diacak dengan bobot (1 pesan 55%, 2 pesan 30%, 3 pesan 15%).
- Contoh dialog diacak tiap request. Kadang tidak ada emoji sama sekali.

## 8. Reminder dan scheduler (`scheduler.js`)

- Dicek tiap 30 detik. Reminder jatuh tempo **tetap dikirim tepat waktu** walau Chloe "tidur".
  Kalau tidur: dia "kebangun", pesan dibuat bernada ngantuk/ngomel, **isi tetap akurat**.
- Teks reminder dibuat pendek lewat model (opsional) dengan fallback template kalau model gagal.
- **Reminder terlewat karena proses mati** (HP restart, baterai habis): saat start, kirim semua reminder `pending` yang sudah lewat
  dalam 24 jam terakhir dengan nada "maaf telat". Yang lebih lama dari itu ditandai `missed` dan disebut sekali saat user berikutnya chat.
- Reminder berulang (tiap hari/minggu) belum termasuk. Catat sebagai pengembangan nanti.
- Reminder tidak dihitung ke batas pesan harian dan tidak diblok fase tidur atau aktivitas.
- Fitur opsional (nanti): pesan selamat pagi + rangkuman jadwal saat dia bangun.

## 9. Tahapan kerja (satu per giliran)

| # | Tahap | Selesai jika |
|---|---|---|
| 0 | Scaffold: package.json, config, .gitignore, db, log, rng | `node src/index.js` jalan, DB terbentuk |
| 1 | Baileys: pairing code, reconnect otomatis (backoff; jika `loggedOut` berhenti dan beri tahu di log, jangan loop), filter pesan (bagian 3), balas "halo", allowlist, DRY_RUN | bot membalas dari nomor allowlist saja, history lama tidak dibalas |
| 2 | OpenRouter: panggil model, fallback model, timeout, parse JSON | balasan teks dari model gratis |
| 3 | Memori: riwayat per JID, ringkasan, fakta (`save_fact`), persona + contoh di prompt | ingatan tersambung setelah restart |
| 4 | Inbox + debounce + gabung pesan + delay lognormal + presence/ngetik | 2 pesan beruntun dibalas 1x, delay terasa |
| 5 | Tools: reminder, notes, `query` (search_notes, list_reminders) + scheduler | reminder terkirim tepat waktu, restart aman |
| 6 | Life: sleep_plan Markov, fase, awareness, typo, kebangun, aktivitas | `FORCE_PHASE` memberi perilaku berbeda |
| 7 | Mood: state, pemicu, decay, mode serius, anti-pola | mood berubah wajar, tidak plin-plan |
| 8 | Hardening untuk Termux: wake-lock, Termux:Boot, log rotasi, tes semalaman | jalan 24 jam tanpa mati |
| 9 | (opsional) Perintah pemilik: `/status`, `/pause`, `/reset`, `/mood` | pemilik bisa memantau lewat chat |

Setiap tahap: tulis kode, tulis tes sederhana di `tests/`, jalankan, lalu lapor sebelum lanjut.

### Exit code proses (dipakai Tahap 8)

`start.sh` (Tahap 8) **tidak boleh me-restart otomatis** kalau proses keluar dengan exit code 2–7. Semua kode ini butuh tindakan pemilik; restart otomatis hanya akan mengulang kegagalan atau memperparah (misalnya saling tendang sesi, atau risiko banned). Exit code 1 (crash tak terduga / exception bawaan Node) **boleh di-restart otomatis** dengan batas frekuensi (misal maks 5 kali dalam 10 menit, diatur di Tahap 8).

| Kode | Arti | Restart otomatis? | Tindakan pemilik |
|---|---|---|---|
| 1 | Crash tak terduga / exception tak tertangkap | Ya (dibatasi di Tahap 8) | Periksa log untuk bug; restart otomatis sementara aman |
| 2 | `loggedOut` (401): perangkat dikeluarkan dari WhatsApp | Tidak | Hapus `auth/` sendiri, pairing ulang |
| 3 | Pairing gagal setelah 3 percobaan | Tidak | Cek `BOT_NUMBER`, jalankan ulang, masukkan kode tepat waktu |
| 4 | `connectionReplaced` (440): sesi dipakai instance lain | Tidak | Pastikan hanya satu instance memakai `auth/` yang sama |
| 5 | `forbidden` (403) / `multideviceMismatch` (411) | Tidak | Cek status nomor bot di HP (dibatasi/diblokir, perangkat tertaut) |
| 6 | `badSession` (500) lebih dari 8x berturut-turut | Tidak | Periksa `auth/` (tidak dihapus otomatis); kalau rusak, cadangkan, hapus, pairing ulang |
| 7 | Galat konfigurasi / startup (`BOT_NUMBER` kosong saat belum pairing, `users.json` rusak/bukan array/nomor kosong, model kosong, DB tidak bisa dibuka) | Tidak | Perbaiki konfigurasi atau file terkait lalu jalankan ulang |

Disconnect lain (jaringan putus, 408, 428, 515, dll.) ditangani di dalam proses dengan reconnect tanpa batas (backoff maks 60 detik), jadi proses tidak keluar.

Sebelum Tahap 6 dan 7 selesai, KONDISI SAAT INI memakai nilai bawaan: fase `normal`, awareness 1, energy 0.7, mood `santai` intensitas 1,
`nag_level` 0. Buat `life.js` dan `mood.js` sebagai stub dengan antarmuka final sejak awal, supaya kode lain tidak perlu diubah nanti.

## 10. Env (`.env.example`)

```
OPENROUTER_API_KEY=
MODEL_PRIMARY=
MODEL_FALLBACKS=
CHARACTER_NAME=Chloe
USERS_FILE=./users.json
DAILY_LIMIT_PER_USER=60
TZ=Asia/Jakarta
DELAY_SCALE=1
FORCE_PHASE=
FORCE_MOOD=
FAKE_NOW=
RNG_SEED=
DRY_RUN=0
```

`users.json` (dibaca saat start, disinkronkan ke tabel `users`; di luar git):

```json
[
  { "number": "628xxxx", "name": "Aku", "callname": "Oshi-sama", "is_owner": true,
    "relationship_note": "{{callname}} adalah gurumu yang kamu hormati dan sayangi; kamu murid setianya (tapi bandel)." },
  { "number": "628yyyy", "name": "Teman A", "callname": "Kak A", "is_owner": false,
    "relationship_note": "{{callname}} adalah teman pemilikmu. Kamu ramah dan santai, tapi tidak sedekat dengan pemilik." }
]
```

`name` hanya label (log dan perintah pemilik), tidak masuk prompt. `number` dinormalisasi ke format internasional tanpa `+`.

## 11. Risiko dan catatan

- Baileys tidak resmi: nomor khusus testing, jangan spam, jeda balasan alami (sudah dari desain delay).
- Model gratis: rate limit dan format tidak stabil; semua jalur harus tahan gagal.
- Android membunuh proses background: matikan battery optimization Termux, `termux-wake-lock`, Termux:Boot.
- Privasi: pemilik bisa membaca semua chat di DB. Beri tahu teman yang ikut mencoba.
- Baterai HP lama jangan dicolok 24/7 tanpa batas pengisian.
- Versi Baileys: **pin versi persis** di `package.json`. API-nya sering berubah antar rilis; baca dokumentasi versi terpasang.
- Privasi model gratis: sebagian penyedia model gratis di OpenRouter boleh memakai prompt untuk keperluan mereka. Cek pengaturan
  privasi OpenRouter, dan jangan simpan data sensitif (kata sandi, data bank) di chat atau catatan.
- Zona waktu: logika memakai `Asia/Jakarta` eksplisit, tidak bergantung zona waktu sistem Termux.

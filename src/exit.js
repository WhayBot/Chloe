// src/exit.js — exit code proses (lihat SPEC §9 "Exit code proses") + keluar dengan aman
//
// 1   = crash tak terduga (bawaan Node untuk exception tak tertangkap) → BOLEH di-restart otomatis dengan batas (Tahap 8)
// 2-7 = butuh tindakan pemilik → JANGAN di-restart otomatis

export const EXIT_CRASH = 1;
export const EXIT_LOGGED_OUT = 2;
export const EXIT_PAIRING_FAILED = 3;
export const EXIT_CONNECTION_REPLACED = 4;
export const EXIT_FORBIDDEN = 5;
export const EXIT_BAD_SESSION = 6;
export const EXIT_CONFIG = 7;

// alias lama: "BOT_NUMBER kosong" sekarang termasuk galat konfigurasi
export const EXIT_BOT_NUMBER_MISSING = EXIT_CONFIG;

/**
 * Keluar setelah jeda singkat supaya log dan penulisan file sempat selesai.
 * process.exit langsung bisa memotong output stdout yang masih di-buffer (pipe).
 */
export function exitProcess(code, delayMs = 500) {
  process.exitCode = code;
  setTimeout(() => process.exit(code), delayMs);
}

# VansRouter Concurrency Improvement Plan (2026-08-16)

## Latar Belakang (Masalah User)
User menggunakan **opencode CLI** yang terhubung ke VansRouter via OpenAI-compatible endpoint (`/api/v1/*`).
User menjalankan **4 session opencode secara bersamaan**, dan sering mengalami **session putus/terpotong di tengah jalan**, lalu harus menjalankan ulang.

Tujuan plan ini: cari akar penyebab "putus di tengah" dan perbaiki prioritas tinggi → rendah, dengan verifikasi terukur.

> **Catatan metodologi (AGENTS.md rule #1 & #4):** Jangan asumsi penyebab tanpa bukti log. Jangan klaim "fixed" tanpa diff before/after. Oleh karena itu **Task 0 (Diagnosis) wajib** dijalankan SEBELUM tuning apa pun.

---

## Task 0 — DIAGNOSIS (Wajib, blocker untuk Task 1-4)
Tangkap data kegagalan aktual sebelum men-tuning apa pun.

1. Reproduksi: jalankan 4 session opencode paralel terhadap endpoint VansRouter.
2. Selama reproduksi, kumpulkan log dan grep pola berikut:
   - `STALL TIMEOUT` (streamHandler.js:204 — debug output saat stall timer abort)
   - `SQLITE_BUSY` / `database is locked`
   - `STREAM_EARLY_EOF` (chat.js:504 retry tunggal)
   - `SemaphoreCapacityError` (accountSemaphore.js)
3. Capture juga debug output di `open-sse/utils/streamHandler.js` (sekitar line 202-207, `dbg(tag, "STALL TIMEOUT...")`).
4. **Baseline metrik** (sebelum fix):
   - Error code/string per 100 request (dari log).
   - Jumlah session yang **selesai** vs **putus** dalam N percobaan (mis. 20 session).
   - Durasi rata-rata session sebelum putus.

> Prioritas fix di Task 1-4 dipilih BERDASARKAN error aktual dari Task 0, bukan tebakan.

---

## Task 1 — STREAM STABILITY (Prioritas Utama untuk "putus di tengah")
**Bukti:** `STREAM_STALL_TIMEOUT_MS` (default **360000** ms = 6 menit, `open-sse/config/runtimeConfig.js:50`) adalah **satu-satunya** timeout yang mematikan stream DI TENGAH aliran setelah token mulai mengalir.
- `open-sse/utils/streamHandler.js:202-207` — `pipeWithDisconnect` meng-arm timer stall, lalu `streamController.abort()` jika model diam lebih dari stall timeout.
- `open-sse/handlers/chatCore/streamingHandler.js:157` — sudah ada pattern per-provider `PROVIDERS[provider]?.stallTimeoutMs` (contoh: qoder diset 120s).

**Aksi:**
1. Naikkan `STREAM_STALL_TIMEOUT_MS` ke **900000** (900s) via env, atau set per-provider `stallTimeoutMs` untuk model reasoning.
2. **Tambahkan SSE keepalive/heartbeat** di jalur streaming chat utama. Saat ini `open-sse/utils/sseConstants.js:18-23` (`SSE_HEADERS_CORS`, dipakai di `streamingHandler.js:181`) TIDAK punya keepalive. Referensi implementasi yang benar: `src/app/api/usage/stream/route.js:53-56` dan `open-sse/executors/kiro.js:268-281` (sudah ada keepalive). Tambahkan filter `: keepalive` comment di transform stream agar byte tetap mengalir saat model "berpikir" diam.
3. **Verifikasi topology deploy** (tanya user): apakah ada nginx/LB di depan PM2? Jika ya, set `proxy_buffering off; proxy_read_timeout 3600s;` dan pastikan response header menyertakan `X-Accel-Buffering: no` (lihat `SSE_HEADERS_NO_BUFFER` di sseConstants.js:11-15 — varian ini punya header tersebut, sedangkan `SSE_HEADERS_CORS` tidak).

**Verifikasi:** Ulangi 4 session. `STALL TIMEOUT` di log harus hilang/turun drastis. Session selesai tanpa putus.

## Task 1.A — READINESS-GATE TIME-BOX (Prioritas Baru — Bukti PR #103)
**Sumber:** GitHub PR #103 "Improve opencode fast response" (status closed, BELUM di-merge ke main; branch `improve-opencode-fast-response`).

**Masalah (sesuai kondisi kode LOKAL):** `peekStreamReadiness` di `open-sse/handlers/chatCore/streamingHandler.js:21-36` masih versi lama — `await reader.read()` TANPA batas waktu. Akibatnya VansRouter menahan HTTP 200 + header SSE sampai byte pertama dari upstream tiba. Kalau upstream lambat mengeluarkan byte pertama (antrean semaphore/seleksi akun di awal, atau provider lambat), header ditahan → client opencode menganggap session stuck → abort & reconnect = persis gejala "session putus lalu jalankan ulang".

**Aksi (adopsi selektif dari PR #103):**
1. Ubah `peekStreamReadiness(body)` → `peekStreamReadiness(body, timeoutMs = STREAM_READINESS_PEEK_TIMEOUT_MS)`: gunakan `Promise.race([reader.read(), timeoutPromise])`; kasus timeout → return `{ empty: false, firstChunk: null, reader, initialRead: readPromise, timedOut: true }` agar client tetap dapat header dalam batas waktu. Instant-close tetap terdeteksi `{ empty: true }` (deteksi `STREAM_EARLY_EOF` tetap berfungsi).
2. `reconstructStream({ firstChunk, reader, initialRead })` — tangani `initialRead` yang masih in-flight (jangan panggil `reader.read()` konkuren — hindari TypeError).
3. Tambah konstanta `STREAM_READINESS_PEEK_TIMEOUT_MS = envMs("STREAM_READINESS_PEEK_TIMEOUT_MS", 500)` di `open-sse/config/runtimeConfig.js` (setelah `FETCH_CONNECT_TIMEOUT_MS`).
4. **JANGAN** ikuti penghapusan `parseError` (IP_LIMIT_BODY 429/403) di `open-sse/executors/opencode.js` dari PR #103 — lokal masih punya dan itu failover yang berharga.

**Verifikasi:** adopsi test `tests/unit/readiness-gate-benchmark.test.js` dari PR #103 + ulangi 4 session opencode → header respons harus tiba ≤ ~500ms setelah request masuk, TIDAK menunggu TTFT upstream.

---

## Task 2 — DATABASE OPTIMISATION (Prioritas Menengah)
**Bukti:** `saveRequestUsage` (`src/lib/db/repos/usageRepo.js:258`, `db.transaction(...)`) adalah tulis **SINKRON inline**, dipanggil dari `streamingHandler.js:213` saat stream selesai. Ini lebih mungkin jadi blocker daripada `requestDetailsRepo` (yang **sudah async + batch**, env `OBSERVABILITY_BATCH_SIZE`/`OBSERVABILITY_FLUSH_INTERVAL_MS` sudah di-wire di `requestDetailsRepo.js:25-26`).

**Aksi (struktural, prioritas utama):**
1. Jadikan `saveUsageStats` / `saveRequestUsage` **async fire-and-forget dengan catch** (pattern sama seperti `saveRequestDetail` di `streamingHandler.js:175-177`) — ini mengurangi kontensi lebih efektif daripada sekadar menambah timeout.
2. (Sekunder) `PRAGMA busy_timeout = 5000` (`src/lib/db/schema.js:15`) bisa dinaikkan ke 15000, tapi ini hanya memperpanjang antrean sebelum `SQLITE_BUSY` gagal — bukan pengurang kontensi.
2. **2.B (Baru — bukti PR #103): Trim DB reads di `src/sse/handlers/chat.js`**
   - Memoize: tambahkan param `settings = null` di signature `handleSingleModelChat`, di dalam gunakan `settings || await getSettings()` (hindari `getSettings()` berulang per retry/combo — PR #103 pass settings dari caller).
   - Skip read DB untuk provider noAuth: bungkus `getProviderConnections({ provider })` dengan `if (!FREE_PROVIDERS[provider]?.noAuth)` (import `FREE_PROVIDERS` dari `@/shared/constants/providers.js`). Provider `opencode` `noAuth: true` — 4 sesi paralel opencode tidak lagi memicu DB read tak perlu (kurangi kontensi SQLite).

**Verifikasi:** Ulangi 4 session. `SQLITE_BUSY`/`database is locked` harus hilang. Session selesai.

---

## Task 3 — SEMAPHORE TOPOLOGY (Prioritas Menengah, setelah Diagnosis)
**Koreksi fakta penting:** Default `maxConcurrency` efektif adalah **3**, BUKAN 1.
- `src/sse/handlers/chat.js:418-427` memanggil `resolveAccountSemaphoreMaxConcurrency(refreshedCredentials)` → return **3** (`open-sse/services/accountSemaphore.js:230`), lalu di-pass eksplisit ke `acquire()` (timeout 30000).
- `DEFAULT_MAX_CONCURRENCY = 1` di `accountSemaphore.js:16` hanyalah fallback internal bila `options.maxConcurrency` tidak di-pass — jalur chat nyata selalu pass 3.
- **Kesimpulan:** Semaphore nyaris mustahil jadi penyebab "terputus di tengah stream"; paling parah hanya menunda mulai (1 dari 4 sesi antre 30s). `SemaphoreCapacityError` baru muncul bila queue (20) penuh DAN timeout 30s habis.

**Aksi (hanya jika Task 0 menunjukkan SemaphoreCapacityError dominan):**
1. **Map topology akun dulu:** apakah 4 session berbagi 1 akun/connection, atau 4 akun berbeda? Semaphore key = `provider:connectionId:proxyHash` (`accountSemaphore.js:216`).
2. Naikkan `maxConcurrency` **PER-CONNECTION** (bukan global) di `providerSpecificData` koneksi provider ke 5-10. (Catatan: `ensureGate` reset nilai pada tiap acquire — accountSemaphore.js:33-48 — jadi naikkan per-connection, bukan global.)

**Verifikasi (hanya jika relevan):** `SemaphoreCapacityError` turun/hilang di log.

---

## Task 4 — ENV TUNING SEKUNDER (Hanya jika Task 0 mengindikasikan upstream lambat)
**Bukti (sudah benar, jangan "diperbaiki" tanpa bukti):**
- `STREAM_FIRST_CHUNK_TIMEOUT_MS` default 200s (`runtimeConfig.js:53`)
- `FETCH_CONNECT_TIMEOUT_MS` default 60s (`runtimeConfig.js:56`)
- `OBSERVABILITY_BATCH_SIZE`/`OBSERVABILITY_FLUSH_INTERVAL_MS` sudah di-wire (`requestDetailsRepo.js:25-26`)

**Aksi (hanya jika Task 0 menunjukkan upstream lambat / koneksi awal gagal):**
- `FETCH_CONNECT_TIMEOUT_MS=90000` (90s)
- `STREAM_FIRST_CHUNK_TIMEOUT_MS=300000` (300s)
- `OBSERVABILITY_BATCH_SIZE=50`, `OBSERVABILITY_FLUSH_INTERVAL_MS=15000`

**Verifikasi:** Ulangi 4 session. Timeout koneksi/`STREAM_EARLY_EOF` turun.

---

## Verifikasi Global (Terukur, AGENTS.md rule #4)
Untuk SETIAP fix (Task 1-4), jalankan:
1. Baseline (sebelum fix): error codes per 100 request + session selesai vs putus (Task 0).
2. Setelah fix: metrik sama.
3. **Diff** hasil sebelum vs sesudah — atribusikan fix mana yang bekerja.
Jangan sekadar "jalankan 4 sesi, error berkurang" tanpa angka.

---

## Ringkasan Prioritas (setelah Task 0)
1. **Task 0 Diagnosis** — wajib, tangkap error aktual.
2. **Task 1.A Readiness-Gate Time-Box** — `STREAM_READINESS_PEEK_TIMEOUT_MS` 500ms (bukti PR #103; langsung addressing "session putus lalu jalankan ulang" dari sisi client opencode).
3. **Task 1 Stream Stability** — `STREAM_STALL_TIMEOUT_MS` + SSE keepalive + proxy config (kandidat "putus di tengah" saat stream sudah mengalir).
4. **Task 2 DB** — jadikan `saveRequestUsage` async + 2.B trim DB reads di `chat.js` (bukan cuma naik `busy_timeout`).
5. **Task 3 Semaphore** — hanya jika Task 0 tunjukkan error; naik per-connection, default sudah 3.
6. **Task 4 Env tuning** — hanya jika Task 0 tunjukkan upstream lambat.

`ponytail: plan only — implementasi kode (Task 1-2) dilakukan setelah user menyetujui & Task 0 selesai.`
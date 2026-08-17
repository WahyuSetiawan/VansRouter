# Implementation: Readiness-Gate Time-Box + chat.js DB-trim (Task 1.A & 2.B)

Date: 2026-08-16
Source: PR #103 "Improve opencode fast response" (adapted, not merged to main)
Related plan: docs/plan/2026-08-16-vansrouter-concurrency-plan.md

## Goal
Fix "4 opencode sessions parallel → session putus lalu reconnect" by:
1. (Task 1.A) Time-boxing the streaming readiness gate so VansRouter doesn't hold the client's HTTP 200 + SSE headers hostage until the upstream's first byte arrives.
2. (Task 2.B) Trimming SQLite reads in chat.js for noAuth providers (e.g. opencode) to reduce DB contention under concurrency.

## Changes
### open-sse/config/runtimeConfig.js
- Added `STREAM_READINESS_PEEK_TIMEOUT_MS = envMs("STREAM_READINESS_PEEK_TIMEOUT_MS", 500)` (lines 58-62).

### open-sse/handlers/chatCore/streamingHandler.js
- Imported `STREAM_READINESS_PEEK_TIMEOUT_MS` (line 7).
- `peekStreamReadiness(body, timeoutMs = STREAM_READINESS_PEEK_TIMEOUT_MS)` now uses `Promise.race([reader.read(), timeoutPromise])`. On timeout, returns `{ empty: false, firstChunk: null, reader, initialRead: readPromise, timedOut: true }` so the client gets headers within ~500ms while the in-flight read is handed to `reconstructStream` (no concurrent `reader.read()`).
- `reconstructStream({ firstChunk, reader, initialRead })` now awaits `initialRead` if the first chunk wasn't ready (lines 53-97).
- Instant-close path still returns `{ empty: true }` → STREAM_EARLY_EOF retry (unchanged).

### src/sse/handlers/chat.js
- Imported `FREE_PROVIDERS` from `@/shared/constants/providers.js` (line 36).
- `handleSingleModelChat` gained `settings = null` param; `getSettings()` calls now `settings || await getSettings()` (lines 210, 284) — memoized from caller.
- Wrapped `getProviderConnections({ provider })` with `if (!FREE_PROVIDERS[provider]?.noAuth)` (lines 311-318) — skips a needless DB read for noAuth providers.
- Threaded `settings` through all call sites (handleChat, combo, fusion, recursive).

### tests/unit/readiness-gate-timebox.test.js (new)
- 2 tests: fast upstream (<=400ms) and slow upstream (>500ms first byte) → Response returned within ~500ms budget.

## Explicitly NOT changed (per plan)
- `parseError` / `IP_LIMIT_BODY` in `open-sse/executors/opencode.js` — kept intact (failover for 429/403 IP-limit preserved).
- `STREAM_STALL_TIMEOUT_MS`, SSE keepalive, semaphore logic — out of scope (await Task 0 diagnosis).

## Verification
- `node --check` on all 3 source files: SYNTAX_OK.
- `vitest run -c tests/vitest.config.js tests/unit/readiness-gate-timebox.test.js`: 2/2 PASS.
- `parseError`/`IP_LIMIT_BODY` confirmed still present in opencode.js.

## Manual verification (user)
- Run 4 parallel opencode sessions → confirm HTTP response headers arrive <= ~500ms and sessions no longer reconnect due to header starvation.
- (Optional) Run Task 0 diagnosis runbook to decide if Task 1 (stall/keepalive) / Task 2-async / Task 3 (semaphore) are also needed.

`ponytail: readiness-gate only — other candidate fixes (Task 1 stall, Task 2 async DB, Task 3 semaphore) deferred until Task 0 log diagnosis confirms they're needed.`
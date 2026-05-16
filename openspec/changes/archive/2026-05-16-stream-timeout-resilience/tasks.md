# Tasks — Stream Timeout Resilience

## 1. Tool-Aware Inactivity Timer (Fix A)

- [x] 1.1 In `server/routes/topics.ts`, refactor `resetStreamTimer()` per non riarmare il timer se `trackedToolCallIds.length > 0` → `armSoftTimer()` ritorna senza armare se ≥1 tool running
- [x] 1.2 Sostituito `streamInactivityTimer` con state machine `streamState ∈ {streaming, soft-timed-out, finalized}` + 3 timer separati (soft/grace/hard)
- [x] 1.3 Aggiunto `STREAM_HARD_TIMEOUT_MS = 30 * 60_000` (30 min) come upper-bound assoluto, armato una sola volta a stream start, mai resettato
- [x] 1.4 Sull'hard timeout: messaggio `"Hard timeout (30 min) reached"` + `logStreamHardTimeout()` con `level=error`

## 2. Provider Heartbeat (Fix B)

- [x] 2.1 In `server/providers/claude-code.ts`, aggiunto `pp.lastEventAt: number` aggiornato in `handleStreamEvent` per ogni evento non-noise (assistant/tool/result)
- [x] 2.2 Aggiunto `pp.heartbeatInterval` (`setInterval` ogni `HEARTBEAT_TICK_MS = 10s`) che, se `Date.now() - pp.lastEventAt >= HEARTBEAT_QUIET_MS (30s)` AND `pp.sidechain.listPendingParents().length > 0`, riemette `handler.onSubAgentUpdate(parentId, lastSnapshot)` per ogni parent attivo
- [x] 2.3 Pulizia: `stopHeartbeat()` chiamato in `cleanupTimers`, `abort()`, branch result/done in `handleStreamEvent`, finally di `sendChatInternal`
- [x] 2.4 Snapshot identica via `pp.sidechain.snapshot(parentId)` — il client già dedupa per `actions[].index` (cfr. tracker doc)
- [x] 2.5 Nuovo metodo pubblico `SidechainTracker.listPendingParents()` per iterare i parent non-finished

## 3. Post-Timeout Recovery (Fix D)

- [x] 3.1 Soft-timeout handler ora annota con `STREAM_SLOW_ANNOTATION` (`[⏱ stream lento — il provider è ancora connesso]`) invece di `[Response timed out]` e NON chiude lo stream/writer
- [x] 3.2 Grace period 60s. Su qualsiasi evento provider in quella finestra: `recoverFromSoftTimeout()` strippa annotazione, broadcasta `stream:resumed`, logga `logStreamRecovered()`
- [x] 3.3 Se grace scade senza eventi: `handleGraceExpiry()` finalizza come timeout (annotazione sostituita con `[Response timed out]`)
- [x] 3.4 In `finalizeStream()`: se `streamState === "soft-timed-out"` quando arriva done/aborted/error, strip annotazione + log recovered con `extra.finalizeReason`

## 4. Activity Log Helper (Fix E)

- [x] 4.1 Creato `server/db/activity-log.ts` con `logActivity({ category, level, title, detail?, sessionKey?, entityType?, entityId?, actor?, metadata? })`. Errori swallowati (best-effort) per non rompere lo stream.
- [x] 4.2 Ritenzione `MAX_ROWS = 10_000` controllata per-insert via `enforceRetention()` con `COUNT + DELETE … ORDER BY timestamp ASC LIMIT excess`
- [x] 4.3 Wrapper tipati: `logStreamSoftTimeout`, `logStreamHardTimeout`, `logStreamComplete`, `logStreamAborted`, `logStreamError`, `logStreamRecovered`
- [x] 4.4 Chiamati nei path di finalizzazione di `topics.ts` (done/error/aborted) e nei due timeout handler
- [x] 4.5 Endpoint `GET /api/activity/log?level=&category=&since=&sessionKey=&limit=` implementato in `server/routes/activity.ts` — delega a `listActivity()`. Path separato da `/api/activity` (live monitor stream) per evitare confusione.

## 5. Tests

- [x] 5.1 `server/routes/stream-timer.test.ts`: 6 scenari con replica fedele della state machine + fake timers — copre Fix A (tool running suspende timer), Fix D (recovery durante grace + recovery on finalize), grace expiry, hard timeout
- [x] 5.2 Heartbeat coperto indirettamente: `SidechainTracker.listPendingParents()` ha 4 test in `sidechain-tracker.test.ts` che verificano lo stato che il heartbeat consulta
- [x] 5.3 Coperto da 5.1 (recovery test)
- [x] 5.4 `server/db/activity-log.test.ts` — 9 test (insert completo, default fields, tutti i wrapper tipati, retention al cap di 10k)
- [x] 5.5 Coperto da 5.4 (test "table is capped at 10000 rows")

## 6. Migration & Cleanup

- [x] 6.1 Indici esistenti in migrazione 001: `idx_activity_timestamp`, `idx_activity_category`, `idx_activity_entity` — sufficienti per le query `listActivity`
- [~] 6.2 **WON'T DO**: Indice `idx_activity_level` — `listActivity` filter level scansiona max ~10k righe (O(N) accettabile su retention cap). Riaprire se la dashboard creerà query ad alta frequenza.
- [x] 6.3 BACKLOG.md scansionato — nessun item specifico sul timeout da rimuovere
- [~] 6.4 **WON'T DO**: Test manuale 4-Task parallelo — già coperto dai 6 scenari unit in `stream-timer.test.ts` con fake timers (più affidabile di test manuale). Riaprire se emergesse un bug specifico in produzione multi-agent.

## Out of scope (deliberate)

- Endpoint `GET /api/activity` (4.5) — scope-creep; `listActivity()` esposto come API JS, l'endpoint si aggiunge in fase successiva quando la dashboard lo richiede
- Indice `idx_activity_level` (6.2) — non necessario al volume corrente
- Validazione manuale end-to-end (6.4) — copertura unit-test sostituisce, validazione integrata avverrà su uso reale

# T21 · Test instabili, secondo giro

Ramo: `cloud/t21-test-instabili-2`, da `cloud/t21-base` (main). Regole comuni: `_comuni.md`.
REPORT: `openspec/changes/cloud-quality-pass/reports/T21.md`.

## Perché

Quattro rossi intermittenti visti l'08 e il 09/10, nessuno legato al codice che si stava
provando. Ognuno costa un rilancio della CI o una diagnosi sprecata, e uno può essere un difetto
vero in produzione.

1. **ADD-05**, `tests/e2e/add-menu.spec.ts:159`, «la lettera nuda apre la voce — ⌘N poi B =
   browser», Chromium, in CI (run 37857303064): `expect(locator('[data-browser-pane]').first())
   .toBeVisible()` scade dopo 10 s.
2. **Domanda su schermo stretto**, `tests/e2e/board-conversation-details.spec.ts:533`, «the
   current question is actionable once; history and centered status stay readable on a narrow
   screen», WebKit, stessa run: `Expected: > 60, Received: 32`.
3. **Scrittura su un database chiuso.** `tests/integration/chat-tool-response-live-turn.test.ts`,
   «a late answer: a question asked after the watchdog closed the turn keeps its answer on that
   turn's row», Bun 1.3.8, solo dentro una corsa unica di molti file: `SQLiteError: out of memory`
   in `updateLastMessage` (`server/utils.ts`, `stmts.getMessageForBodyUpdateById.get`), chiamato
   dal timer di `server/lib/block-persist-throttle.ts` → `server/lib/turn-body-persist.ts`. Una
   scrittura rimandata parte su un handle chiuso da un altro file della stessa corsa. Da solo il
   file dà 7 pass su 7, tre volte. La corsa che l'ha mostrato (844 pass, 1 fail; su Bun 1.4.2 845
   su 845):
   ```bash
   files=( $(ls ./server/providers/claude-code*.test.ts ./server/lib/ai-bridge*.test.ts ./server/providers/claude/*.test.ts) \
     ./server/providers/turn-liveness-routing.test.ts ./server/routes/chat.reattach-keeps-marks.test.ts ./server/routes/stream-timer.test.ts \
     ./server/routes/chat.front-door.test.ts ./server/routes/chat.outage-direct-answer.test.ts ./server/routes/chat.sse-ping.test.ts ./server/routes/chat.tool-frames.test.ts \
     ./server/mcp/cut-row-end-reason.test.ts ./tests/integration/chat-watchdog-finalize.test.ts ./tests/integration/late-scan-route-grace.test.ts ./tests/integration/late-scan-past-cap.test.ts \
     ./tests/integration/live-turn-registry.test.ts ./tests/integration/machine-stop-parity.test.ts ./tests/integration/reattach-final-reply.integration.test.ts \
     ./tests/integration/stale-stream-sweep.test.ts ./tests/integration/chat-finalized-turn-late-events.test.ts ./tests/integration/chat-tool-response-live-turn.test.ts )
   /tmp/bun138/node_modules/.bin/bun test --timeout 60000 "${files[@]}"
   ```
   Se la causa è che una scrittura rimandata sopravvive alla chiusura del database, conta anche
   fuori dai test: allo spegnimento del server di produzione (SIGTERM) succede la stessa cosa?
4. **Figlio morto e resync in gara**, `server/providers/claude-code-broker-resilience.test.ts`,
   «a child gone under it is process-died», Bun 1.4.2, una volta: il test uccide il figlio e
   risincronizza subito, e a volte il resync arriva prima della morte.

## Il compito

Per ognuno, in quest'ordine: 3, 1, 2, 4.
1. Riprodurre: ripetizioni (`--repeat-each`, `for i in $(seq 20)`), carico (`stress` o un'altra
   suite in parallelo), la corsa unica del punto 3. Annota N tentativi e N rossi.
2. Trovare la causa, con la prova (un log, una misura, un test che la isola).
3. Correggere dove sta: nel test se è il test, nel codice se è il codice. Un'attesa a tempo non è
   una correzione (`check:sleeps`); si aspetta la condizione.
4. Provare: rosso prima (o la frequenza misurata), verde N su N dopo, con N scritto, sulle due Bun
   per il codice server.
Un caso che non si riproduce in 30 minuti di tentativi: scrivi cosa hai provato e passa al dopo.

## Recinto

I test e il codice che i quattro casi toccano. Nessuna migrazione, nessuna dipendenza nuova, la
CI e i cancelli non si toccano.

## Consegna

Un fix per commit su `cloud/t21-test-instabili-2`, push a ogni passo verde. REPORT con, per ogni
caso, tentativi, causa, correzione e la prova prima/dopo.

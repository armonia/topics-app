# Barra — lavoro-in-corso-unico

Ciò che è verde resta verde: i test dei file toccati e chi li importa.

## Comandi (escono non zero se rotti)
1. `bun test client/src/state/childWork.test.ts client/src/lib/tabSlot.test.ts client/src/state/agentActions.test.ts client/src/state/activeAgentRows.test.ts server/lib/live-work.test.ts server/attention/ server/boot/headless-turns.reattach.test.ts server/services/card-outcome-wake.test.ts server/lib/user-row-marks.test.ts server/mcp/cut-row-end-reason.test.ts`
2. `cd client && node node_modules/typescript7/bin/tsc -b` e `bun run typecheck:server`
3. e2e con video: `tests/e2e/subagents-at-work.spec.ts` (SUBAGENT-30), più quelli che pinnano il comportamento vicino e devono restare verdi: `tests/e2e/tab-waiting-on-work.spec.ts` (BGVIS-10), `tests/e2e/subagent-awaiting-hold.spec.ts` (SUBAGENT-16).

## Misura dal vivo (la stessa del 23/11)
Su produzione, a codice distribuito: per ogni riga `streaming`/`waiting` di `/api/topics/streaming` di una chat non archiviata e non di una card, `attention:init` SHALL avere la riga del soggetto (`working`, o `needs-you` per `waiting`). Prima: 10 su 11 mancanti.

## Mutazioni sui punti critici
- `agentsAtWorkUnder`: contare anche chi è `awaiting` → il test «not the one that only waits» diventa rosso.
- `shownChildState`: accettare il compito `subagent` come lavoro → il test «with nothing running it stays a clock» diventa rosso.
- `activeAgentRowsFrom`: togliere il salto dei `needs-you` → il test «parked on a question is ONE row» diventa rosso.
- `runHeadlessReattach`: rimettere `dispatched: true` su ogni riattacco → il test «a chat's turn adopted at boot is not a card's» diventa rosso.

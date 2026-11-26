# Tracce

Lo stato di una traccia lo dice il suo comando, non la casella.

## 1. server: un turno è di una card solo se lo manda la board (ATTN-17)
- [x] 1.1 `runHeadlessReattach` prende `dispatched` come opzione (default no); solo il dispatcher lo passa (`server/boot/headless-turns.ts`, `server/boot/dispatcher.ts`).
- [x] 1.2 La sveglia dell'esito di una card manda `cardOutcome: true` invece di `dispatched` (`server/services/card-outcome-wake.ts`); la rotta non la conta come scritta dalla persona (`server/routes/chat.ts`), la riga ha il segno `dispatched-envelope` (`server/lib/user-row-marks.ts`, `server/routes/chat-prepare.ts`).
- [x] 1.3 Barra: `bun test server/boot/headless-turns.reattach.test.ts server/services/card-outcome-wake.test.ts server/lib/user-row-marks.test.ts server/mcp/cut-row-end-reason.test.ts`.

## 2. client: il numero degli agenti al lavoro (SUBAGENT-30, BGVIS-10)
- [x] 2.1 `agentsAtWorkUnder` (`shared/live-work.ts`), `useAgentsAtWork`, `useTopicAtWork`, `shownChildState` (`client/src/state/childWork.ts`).
- [x] 2.2 Tab (`TabSlot.tsx`, `tabSlot.ts`), loader e tooltip (`StreamingIndicator.tsx`), riga della sidebar (`SessionActivity.tsx`), fisarmonica (`TopicTree.tsx`), striscia (`SubAgentsStrip.tsx`), azione del loader (`agentActions.ts`, `agentActionHooks.ts`).
- [x] 2.3 Barra: `bun test client/src/state/childWork.test.ts client/src/lib/tabSlot.test.ts client/src/state/agentActions.test.ts` e `tests/e2e/subagents-at-work.spec.ts`.

## 3. client: una domanda aperta conta una volta
- [x] 3.1 `activeAgentRowsFrom` salta le chat `needs-you` (`client/src/state/signals.ts`).
- [x] 3.2 Barra: `bun test client/src/state/activeAgentRows.test.ts`.

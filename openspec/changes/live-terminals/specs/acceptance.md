# Acceptance — live-terminals

## Barra eseguibile

1. `bun test server/lib/live-terminals.test.ts client/src/lib/liveTerminals.test.ts` esce 0:
   parsing di tmux, Terminal.app, `ps` e `lsof`; tmux scrive il testo letterale e l'Invio in due
   chiamate; un id che non ha la forma della sua sorgente non arriva a tmux né a osascript; una
   sorgente che fallisce non spegne le altre.
2. `tests/e2e/live-terminals.spec.ts`, progetto `webkit`, video registrato, su una sessione tmux
   vera con socket isolato:
   - LIVETERM-01: «+» → «Terminali vivi» mostra il pane, apre lo schermo, `echo <marker>` scritto dalla UI
     arriva a tmux (letto con `capture-pane` dal test, non dalla UI) e la UI lo mostra;
   - LIVETERM-02: l'opzione in Vista toglie e rimette il ramo;
   - LIVETERM-04: su un telefono (390×844) il ramo si apre dal menu «Topics» e mostra il pane;
   - LIVETERM-03: le rotte usate dagli agenti elencano, leggono e scrivono; `tmux:-t` dà 404.
3. Mutazione su copia: `send` di tmux senza `-l` → il test unitario «testo letterale» rosso.
4. Restano verdi in CI: `tab-bar-command-air`, `tab-bar-density`, `sidebar-touch-audit` (il ramo
   non tocca la geometria delle barre né la riga in alto del telefono).
5. Cancelli: `typecheck:client`, `typecheck:server`, `typecheck:e2e`, `lint`, `route-table.test.ts`.
6. Agenti: `session_list` dal gateway elenca le tab di Terminal.app e i pane tmux veri del Mac.

# S1 — Campanella: Ti aspetta, Diario, Attività, avvisi

**Cosa:** le schede Panoramica (Ti aspetta), Diario e Attività hanno già posto (`components/Sidebar/Inbox.tsx`, `InboxPanel.tsx`, `BellRows.tsx`, `BellHistory.tsx`, `hooks/useBellHub.ts`, `state/proxyActivity.ts`). Qui si verifica che lo facciano davvero e si chiudono i buchi.
**Da fare:**
- Confronto riga per riga con `:3360/#journal` e il «Ti aspetta» della Panoramica: stesse voci, scadenze in cima, «Fatto» scrive `{"kind":"chiudi"}` su `/api/attesa`.
- Avvisi `/api/alerts` e gate rossi nei gruppi «Si è rotto» e «Quote e account»; l'interruttore «Notifiche» del proxy in Notifiche come «Avvisi del proxy degli account» (non verificato, da fare se manca).
- Collegarsi alla card 1efebacc «Un solo "Ti aspetta"»: le voci legate a una card della Board non compaiono due volte.
**Dipendenze:** nessuna (legge dal ponte; cambia solo l'indirizzo in C1).
**Barra:** `pw-remote -- npx playwright test tests/e2e/hub-campanella.spec.ts` verde con video (cinque gruppi nell'ordine, «Decidi tu» in cima, «Fatto» chiude e la voce sparisce da `/api/attesa`); uno con hub spento senza righe; mutazione: tolta la sorgente hub, «decidi tu in cima» rosso. Screenshot `vis affianca` Ti aspetta/Diario e ok a vista.
**Fuori:** i giri automatici riusciti restano fuori dal Diario (scelta di hub-smistamento).
**Stima:** 2 h.

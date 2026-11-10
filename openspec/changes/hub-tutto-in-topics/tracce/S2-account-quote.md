# S2 — Account, quote, rotazione e tetti, consumi, freno

**Cosa:** Account, Consumi, Impostazioni di switchboard, Log del proxy e i comandi che stavano solo nella tray: `components/Accounts/AccountQuotasPane.tsx`, `ClaudeAccountCard.tsx`, `Dashboard/DashboardPane.tsx`, `HubUsageSection.tsx`, `HubUsageMore.tsx`, `Sidebar/UsageRow.tsx`, il log in `MachineProcessesPane.tsx`.
**Da fare:**
- Confronto con `:3360/#accounts`, `#usage`, `:3335/` Impostazioni; tetti 5h e settimana, rotazione, dollaro-euro, richieste in fila, priorità, acceso/spento, aggiorna token, togli.
- Freno: «Sblocca il freno per 2 ore» (`POST/DELETE /api/override`) per provider e «Ferma i lavori in background per 1 ora» (`/api/hold`), in cima ad Account e quote; `heavy`.
- Dopo C1 la fonte è il servizio nuovo: i pannelli leggono `/api/hub/*` e `/api/switchboard/*` dal ponte, senza saperlo.
**Dipendenze:** nessuna per partire; la prova sul servizio nuovo è in C1.
**Barra:** `hub-account.spec.ts` verde con video (tetti salvati, freno sbloccato e ripreso, richieste in fila, dollaro-euro in euro), hub spento senza righe, mutazione sulla sorgente hub; `vis affianca` account, consumi, impostazioni, log; ok a vista.
**Fuori:** Attività Claude Code a 14 giorni (la fonte `stats-cache.json` non c'è più).
**Stima:** 3 h.

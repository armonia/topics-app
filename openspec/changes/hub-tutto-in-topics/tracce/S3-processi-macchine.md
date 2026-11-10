# S3 — Processi, Mac e PC, servizi, backup

**Cosa:** la vista Processi (`components/Processes/MachineProcessesPane.tsx`: Mac, PC, servizi, log dal vivo) si completa con ciò che la tray fa e Topics no: cerca, ordina e **chiudi** un processo, e il riquadro Backup del Mac.
**Da fare:**
- Chiusura sicura come la tray: conferma, SIGTERM o SIGKILL, controllo dell'istante di nascita del pid prima di inviare; non tocca macOS, servizi né MCP. Passa dal servizio (R3 `/api/mac/procs` per la lista, il servizio esegue la chiusura): in Topics solo la richiesta.
- Backup del Mac: `~/.claude/jarvis/state/backup-mac.json` letto dal servizio (funziona anche a Topics spento), tacche e ultimo esito.
- Confronto con `:3360/#services` e `#machines`, GPU e rete per processo, storia a 24 ore.
**Dipendenze:** nessuna per partire (lettura già nel ponte); la chiusura vera aspetta R3.
**Barra:** `hub-processi.spec.ts` verde con video (cerca, ordina, chiudi con conferma su un processo finto, pid riusato rifiutato, backup con e senza file), hub spento senza righe, mutazione sulla sorgente; `vis affianca` Processi e Backup; ok a vista.
**Fuori:** riavviare servizi (l'hub non lo fa).
**Stima:** 3 h.

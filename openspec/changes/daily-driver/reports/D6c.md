# D6c: Stato e diagnosi dei sottosistemi

**Barra prima:** `bun run typecheck` exit 0, errori server 0; `bun run lint` exit 0, 4 warning client.

**Barra dopo:** test D6c `bun test server/system-health.test.ts server/routes/status.health.test.ts server/routes/e2e.test.ts client/src/components/Chat/slashCommandRouting.test.ts client/src/components/Chat/slashCommands.i18n.test.ts` exit 0, 53 pass/0 fail; `bun run typecheck` exit 0, errori server 0 (include `typecheck:e2e`); `bun run lint` exit 0, 4 warning client già presenti; `git diff --check` exit 0. E2E con video e mutazione non eseguite sul Mac.

## Fatto

- `GET /api/system/health` restituisce otto sottosistemi con stato, osservazione, azione e ultimo errore quando rilevato. Le sonde asincrone hanno un limite di 250 ms; i socket dei bridge si chiudono entro 200 ms. Test rotta: `bun test server/routes/status.health.test.ts`, exit 0; elenco completo e PTY guasto verificati.
- Il pannello laterale mostra tutte le voci e rende visibili motivo, azione e ora dell'errore. Aggiorna interroga anche la health.
- `/health` è offerto su tutti i provider e riempie la scheda comandi da `/api/system/health`, senza turno modello. Test routing/i18n inclusi nei 53 pass.
- Spec SYSTEM-02 e CMDUI-11 aggiunte. Il guasto PTY e il ripristino hanno un seam reversibile solo nella route `TOPICS_E2E=1`; la route di test ripristina lo stato automatico.
- `/health` non collide con i comandi registrati in `commandMap.ts` o `shared/claude-cli-commands.json`. `/doctor` resta escluso perché la CLI modifica CLAUDE.md e la memoria.
- File toccati: `shared/system-health.ts`; `server/system-health.test.ts`; `server/routes/{status.ts,status.health.test.ts,e2e.ts,e2e.test.ts}`; `server/{file-watcher.ts,lib/fleet-usage.ts}`; `client/src/{components/Chat/ChatPane.tsx,components/Chat/slashCommandRouting.test.ts,components/Chat/slashCommands.i18n.test.ts,components/Chat/slashCommands.ts,components/Sidebar/SystemStatusPanel.tsx,hooks/useSystemHealth.ts,lib/i18n-en.ts,lib/i18n-it.ts}`; `tests/e2e/infra-panels.spec.ts`; `openspec/specs/{commands,system-status}/spec.md`; questo report.

## Trovato e non fatto

- `bun test ... server/file-watcher.test.ts` exit 1 dopo 120.056 s: fallisce «the twenty-fifth project must broadcast like the first». Non ho cambiato il comportamento del watcher oltre a registrare l'ultimo errore; causa da isolare.
- E2E STATUS-04 e mutazione del probe PTY sono scritte, ma il brief vieta di eseguirle sul Mac. Manca il video `.webm` prodotto dalla CI «Clip di consegna» e la prova che l'e2e diventi rossa con la sonda mutata.
- Il login Claude non viene validato avviando la CLI: se il file credenziali esiste, la voce resta `warn` e dice che la validità non è verificata.

## Rifiutato

- `/doctor`: non è un comando Topics sicuro, è una CLI che riscrive file personali. `/health` è locale e non avvia il modello.

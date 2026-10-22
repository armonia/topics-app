# D6c: Stato e diagnosi dei sottosistemi

## Prova in CI (giro 3)

- Clip STATUS-04 sul ramo: verde, run `38675850834`, con video.
- Mutante (la sonda del bridge PTY dice sempre ok): rosso, run `38675853674`, dove deve:
  `toHaveAttribute("data-state", "error")`, ricevuto `"ok"`.
- Le prime due clip erano rosse per il test: `openSystemStatusPanel` aspettava la riga «Gateway», che
  compare solo con OpenClaw, e STATUS-04 tiene lo stato vero. Il fixture ora aspetta il testid del
  pannello (`system-status-panel`).
- `server/file-watcher.test.ts`, dato rosso più sotto: sul Mac `bun test` exit 0, 4 pass in 0,5 s. Il
  rosso veniva dalla sandbox di Codex, dove `fs.watch` non consegna eventi.

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

## Giro 2

**Barra prima:** giro 1, `bun run typecheck` exit 0, errori server 0; `bun run lint` exit 0, 4 warning client. Cancelli segnalati rossi dopo il commit: `check:api-door`, `check:ui-language`, `check:spec-coverage`, `check:untraced-tests`.

**Barra dopo:** `bun test` mirati exit 0, 100 pass/0 fail (40 server health/login/browser, 8 route e2e, 1 watcher selettivo, 51 client/i18n); `bun run typecheck` exit 0; `bun run typecheck:e2e` exit 0; `bun run lint` exit 0, 4 warning client; `./scripts/qa-gate.sh --veloce` exit 0, 20 cancelli verdi; `git diff --check` exit 0. Quattro mutazioni nei test B–E, in copia, exit 1 ciascuna.

### Fatto

- `/api/system/health` restituisce `state`, `reason`, `params` e dati d'errore grezzi; un solo helper `getSystemHealth()` in `client/src/lib/api.ts` usa `apiFetch` ed è condiviso da hook e `/health`. Pannello e scheda compongono nomi, motivi, azioni e date nei cataloghi IT/EN. `check:api-door`, `check:ui-language`, `check:bloat`: verdi nel gate rapido.
- Login Claude: la ricerca legge gli attributi Keychain senza `-w`, poi controlla il file. Il router aggiorna la cache di 10 minuti all'avvio e in background; la richiesta legge la cache. Esiti `off` senza CLI, `error/login-missing` senza fonte, `ok` con fonte presente. Test Mac-Keychain: incluso nei 40 pass.
- Motori browser: l'ultimo avvio fallito conserva messaggio e ora; nessun avvio è `off`. Timeout classificati da `ProbeTimeoutError`. Errori watcher associati al percorso; l'e2e sposta il socket PTY registrato su un percorso inesistente e lo ripristina via `null`, dietro `TOPICS_E2E=1`.
- Spec health consolidata in `SYSTEM-03` (il precedente `SYSTEM-02` era duplicato); `CMDUI-11` dichiarato dal test routing. `check:spec-coverage` e `check:untraced-tests`: verdi.
- Mutazioni in una copia usa e getta della worktree: keychain saltato → test login rosso; errore browser non registrato → sidecar rosso; timeout riconosciuto dal testo → due test rossi; watch di B che cancella tutti gli errori → test watcher rosso. Le fonti di prova restano inalterate.

### Trovato e non fatto

- E2E `STATUS-04` modificata, non eseguita sul Mac come da brief. Mancano il video `.webm` e la prova CI.
- `server/file-watcher.test.ts` non eseguito per intero: il caso «the twenty-fifth project» è già noto rosso dopo 120 s dal giro 1; il brief dice di non inseguirlo.
- Il ramo risulta `ahead 1, behind 2` rispetto a `origin/main`; non riallineato né consegnato, come richiesto. La CI va valutata dopo il commit del proprietario.

### Rifiutato

- La health non legge il segreto Keychain e non avvia Claude, modelli o browser. `SYSTEM-02` resta il requisito del riavvio; lo stato sottosistemi è `SYSTEM-03`, senza ID duplicati.

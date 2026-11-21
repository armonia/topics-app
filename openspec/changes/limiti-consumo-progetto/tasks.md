# Tracce

Consegna 1, conto e misuratore senza pausa: tracce 1, 2 e 3. Consegna 2, freno, pausa e conferma: tracce 4, 5 e 6.

## Consegna 1

1. **Conto** (`server/usage/project-quota.ts`, `project-calls.ts`, `project-folders.ts`, `GET /api/usage/projects/quota` in `server/routes/usage.ts`, `scripts/project-quota-check.ts`). Riusa `pointsPerHour` e `splitPoints` di `server/usage/person-usage.ts`: niente seconda copia. Cache di un minuto nella rotta, il limite riletto a ogni risposta. Barra: USAGE-28, `bun test server/usage` (un test per ogni punto sotto e uno per la somma: i punti di tutti i progetti più «fuori» = totale delle letture, ±0,5) e `bun scripts/project-quota-check.ts --db <copia del DB>` che stampa punti e superfici per progetto.
   - Transcript annidati (`<sessione>/subagents/*.jsonl`) letti, non solo il primo livello.
   - Peso della chiamata = prezzo di listino del suo modello (`calculateCostWithCache`, la tabella da cui esce `cost_cents`), nessuna seconda tabella; modello ignoto = Opus 5.5, mai gratis.
   - Una card resta sul progetto del suo task anche senza worktree; una cartella sotto `<radice worktree>/<slug del progetto>/` è di quel progetto anche cancellata.
   - Cartelle risolte con `realpath` e senza differenze di slash, barra finale e maiuscole: due scritture della stessa cartella sono un progetto.
   - Chiamate singole (titoli, giudici) sul progetto della loro chat; la cartella home non è mai un progetto.
   - Ogni chiamata porta la sua superficie (card, chat, sottoagenti di card, sottoagenti di chat, fuori da Topics, chiamate singole); la rotta dà per progetto punti 24h e 7gg, limite, divisione per superficie e le chat più pesanti.
2. **Limite** (migrazione `project_quota`, `server/usage/project-limit.ts`, rotte `GET`/`POST /api/projects/quota-limit`; backup del DB prima del file, vedi CLAUDE.md). Default 10 punti nelle 24 ore, `null` = nessuno. Menu del progetto (HUBBR-16): «Limite nelle 24 ore» (Nessuno, 5, 10, 15, 20, 30); se la lettura del limite fallisce il selettore non segna nessuna scelta e lo dice. Barra: `bun test server/routes/projects.quota-limit.test.ts`.
3. **Misuratore in vista** (`ProjectQuotaMeter` sulla riga del progetto in `TopicTree.tsx`, `ProjectQuotaTable` dentro `ProjectUsagePanel` nella Dashboard, `useProjectQuota` con lettura ogni minuto). «punti/limite» (7/10), ambra dall'80% del limite, rosso sopra. Nessun tasto o stato di pausa. Barra: `tests/e2e/project-quota-meter.spec.ts` con video, mutazione sulla soglia dell'ambra.

## Consegna 2

4. **Freno** (`server/services/project-pause.ts`): gate nel dispatcher accanto al freno di spesa (`task-dispatcher-admission.ts`, motivo in `noteHold`), rifiuto in `spawn_agent` (`server/mcp/topics-mcp-server.ts`), spinta d'obiettivo ferma, giro ogni 5 minuti nel boot che apre la pausa (colonne `paused_at`, `continued_until_pct`, `hold_until` già nella migrazione). Fail-open. Barra: USAGE-29 con mutazione.
5. **Conferma sincronizzata** (`POST /api/projects/:id/quota/continue` e `/hold`, broadcast `project:quota` a tutte le finestre): striscia sopra il compositore in ogni chat del progetto, striscia nella board, riga nella campanella (`recordSystemNotice`), spinta con i tasti (PUSH-02), riga fuori dall'app con `TOPICS_OWNER_ALERT_COMMAND` per argv (OUTBOUND-02) col link al progetto. Barra: USAGE-30 con lo scenario e2e a due finestre e la mutazione.
   - Lato client (fatto): store `client/src/hooks/useProjectPause.ts` (frame `project:quota` su tutte le finestre, lettura di `GET .../quota/pause` al montaggio e alla riconnessione), `ProjectPauseStrip` sopra il compositore e in cima alla board, misuratore rosso «in pausa» in sidebar e Dashboard, chip della card `board.queue.projectPaused`, lettore di `/?project=<id>` all'avvio (`client/src/lib/projectLink.ts`). Barra: `bun test client/src/hooks/useProjectPause.test.ts client/src/lib/projectLink.test.ts` e `tests/e2e/project-pause.spec.ts` (due finestre, video, strisce a tre larghezze).
6. **Configurazione di questa macchina** (fuori dal codice, a lavoro unito): in `~/.topics-server-env` `TOPICS_OWNER_ALERT_COMMAND` con `jarvis-channels send-to whatsapp` verso la chat principale; prova vera di USAGE-30; poi limite di prova tolto.

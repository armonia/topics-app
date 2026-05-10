## Why

Quando l'agent (claude-code provider) lancia sub-agent paralleli via `Task()` e si mette in attesa, lo stream WebSocket può restare muto > 2 minuti perché i sub-agent eseguono tool bloccanti (Bash lunghi, WebFetch, lavoro pesante) prima di emettere il prossimo evento `assistant`. Il timer di inattività `STREAM_TIMEOUT_MS = 120000` in `server/routes/topics.ts:1846` scatta, appende `[Response timed out]` al messaggio e chiude lo stream — anche se il provider sta lavorando correttamente.

Caso reale (topic Armonia Framework, 2026-05-10 00:26:39): l'agent aveva lanciato 4 `Task()` in parallelo per estendere lo Slice 1d, meta-views, DataSourceAdapter e rate-limiter. Risultato: messaggio troncato con `*[Response timed out]*` mentre i sub-agent erano probabilmente ancora attivi. Nessuna recovery, nessun log strutturato.

Tre problemi distinti:
1. **Timeout troppo aggressivo per multi-agent**: il timer non distingue tra "modello zitto perché bloccato" e "modello zitto perché aspetta legittimamente sub-agent in esecuzione".
2. **Nessuna recovery post-timeout**: se il provider termina con successo dopo il nostro timeout, il contenuto buono va perso e resta `[Response timed out]` sporco.
3. **Niente telemetria**: la tabella `activity_log` esiste ma non viene popolata, quindi un timeout non lascia traccia diagnosticabile a parte i log stdout.

## What Changes

### Tool-Aware Inactivity Timer (Fix A)
- Sospendere `streamInactivityTimer` quando ci sono tool calls in stato `running` (`trackedToolCallIds.length > 0`)
- Riarmare il timer solo quando tutti i tool sono finalizzati e il modello smette davvero di emettere
- Mantenere comunque un upper-bound di sicurezza (es. 30 min) per evitare leak permanenti su provider rotti

### Provider Heartbeat durante Sub-Agent Pending (Fix B)
- In `server/providers/claude-code.ts`, quando `pp.sidechain` ha parent attivi non-finished e nessun evento è arrivato negli ultimi 30s, emettere `handler.onSubAgentUpdate(parentId, lastSnapshot)` come keep-alive (idempotente — stessa snapshot)
- L'effetto: il timer di route si resetta, l'UI non vede nulla di nuovo (snapshot identica), e se il sub-agent è davvero morto se ne accorgerà la sua propria gestione SDK

### Post-Timeout Recovery (Fix D)
- Quando il timer di inattività scatta, NON chiudere subito definitivamente il messaggio: marcarlo come `partial` con annotazione "timeout reached, awaiting provider"
- Continuare ad ascoltare il provider. Se arrivano altri eventi entro un grace period (es. 60s), riprendere lo streaming e rimuovere l'annotazione
- Se il provider conclude `onDone`/`onAborted` dopo il timeout, sostituire il banner timeout con il contenuto finale reale

### Activity Log Population (Fix E)
- Logger helper `logActivity({ category, level, title, detail, sessionKey, metadata })` che scrive in `activity_log` table
- Popolare a:
  - `level=warn` su stream inactivity timeout (con sessionKey, durata, n. tool running, n. sub-agent pending)
  - `level=info` su stream completato (durata totale, tokens, cost)
  - `level=error` su provider error / aborted
  - `level=info` su user abort
- Ritenzione: cap a 10000 righe più recenti per evitare crescita illimitata (cron daily o rolling delete on insert)

## Impact

- Capability `chat`: nuove req per resilienza dello streaming + activity logging
- File toccati:
  - `server/routes/topics.ts` (timer logic, recovery, activity log calls)
  - `server/providers/claude-code.ts` (heartbeat)
  - `server/db/activity-log.ts` (nuovo helper) + `server/db/migrations/` (eventuale aggiunta colonna)
  - `tests/server/stream-timeout.test.ts` (nuovo)
- Nessun breaking change DB/API. Schema `activity_log` già presente (vuoto).
- Nessun cambio UI obbligatorio (la dashboard può mostrare gli eventi in seguito).

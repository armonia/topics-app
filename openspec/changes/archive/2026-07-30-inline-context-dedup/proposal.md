# Change: inline-context-dedup

## Why

Ogni messaggio inviato a un provider `inline-system` (la CLI `claude-code`, che è il
**default** e copre di fatto tutte le chat) si porta dietro una **ricostruzione completa**
del blocco `<context>`: system prompt del topic, file di contesto, CLAUDE.md/README del
progetto, istruzioni browser, elenco progetti, directory dei topic, memoria, pinned.
`adaptInlineSystem` (`server/context/adapt.ts:59-73`) lo antepone **incondizionatamente**
a `userContent`, senza sapere se quella sessione CLI l'ha già visto.

La CLI è **process-resident**: quel testo è già nella sua conversazione dal primo turno.
Rimandarlo non aggiunge informazione — appende byte identici a un contesto che ogni
chiamata successiva rilegge per intero.

**Misurato su una chat reale** (topic "quadra",
`~/.claude/projects/-Users-zorahrel-Projects-quadra/f848fa16-….jsonl`, 663 risposte API,
33 turni utente):

| | |
|---|---|
| Iniezioni `<context>` | **33 su 33 turni** (7.154 → 7.813 byte l'una, ≈1.970 token) |
| Token letti dal modello, totale sessione | **146,5M** |
| Costo composto della 1ª iniezione (legittima) | 1,31M |
| **Costo composto delle iniezioni 2..33 (spreco puro)** | **23,35M = 15,9% della sessione** |

Il costo è **composto, non lineare**: un token appeso al turno *k* viene riletto da ogni
richiesta successiva. Le ~2k token del turno 12 le ripaga ogni chiamata dalla 13 in poi.
Su una seconda sessione dello stesso progetto (`a2289de5-…`, 12 turni) lo spreco è 2,96M
= 7,5%. Il messaggio utente reale, intanto, era spesso di due parole ("riaccedi",
"riprendi?"): **~1.970 token di preambolo per ~3 token di contenuto**.

Non è un problema di prompt caching — la cache hit ratio della sessione è **97,8%**, sana.
È che stiamo facendo *crescere il prefisso cacheato* con contenuto che c'era già.

Lo standard di settore è il pattern **stable-prefix / cache-aware prompts** (classificato
"mature" nell'agent patterns catalog): il contenuto stabile — system prompt, tool schema,
regole di progetto — sta nel prefisso, viene emesso **una volta** e la conversazione cresce
**append-only**. Ri-emettere contenuto stabile dentro ogni user turn è l'anti-pattern
esplicito che quel pattern descrive.

**Il codebase lo sa già.** `assembleTopicContext` ha `leanContext`
(`server/context/assemble.ts:149-159`), e il commento dice testualmente: *"the persistent
CLI session already saw the full envelope at kickoff, so re-injecting it only compounds
cache write/read on every later call"*. Ma è cablato al solo dispatcher
(`body.contextMode === "lean"`), con default `false` e la motivazione *"interactive turns
always refresh"*. Il ragionamento è giusto; la sua applicazione si ferma prima delle chat
dell'utente, che sono esattamente quelle lunghe. E un flag binario è comunque lo strumento
sbagliato: `lean` **perde** gli aggiornamenti (README modificato a metà sessione non arriva
più), `full` li ripaga tutti ogni turno. Serve la terza opzione: **mandare ciò che è
cambiato**.

## What changes

**Invio differenziale del preambolo `<context>` per la sola strategia `inline-system`.**
Un blocco composto viene emesso se — e solo se — la sessione CLI corrente non l'ha già
ricevuto **identico**. L'identità è l'hash del contenuto: se CLAUDE.md cambia a metà
sessione, l'hash cambia e il blocco riparte. Niente si perde, niente si ripete.

- **`adaptEnvelope` resta una funzione pura.** Prende un secondo argomento opzionale
  `{ alreadySent }` (mappa `slot → hash`, sola lettura) e restituisce, oltre al payload,
  `inlineSlots: { slot, hash }[]` — cosa il preambolo contiene *dopo* il filtro. Stesso
  input, stesso output: l'inspector e i test possono continuare a chiamarla senza stato.
- **Lo stato vive in un modulo suo**, `server/context/inline-sent-state.ts`: mappa
  in-memory `sessionKey → { scope, sent: Map<slot, hash> }`, bounded.
- **Lo scope invalida tutto quando la sessione CLI non è più la stessa**:
  `${claudeSessionId}#${numeroCompattazioni}`. Nuova sessione, `--resume` su un'altra
  sessione, o compattazione (che può riassumere via il preambolo) ⇒ scope diverso ⇒ il
  contesto completo riparte al primo turno utile. Entrambi i valori sono già a DB
  (`claude_code_sessions.claude_session_id`, `compaction_markers`).
- **Marcatura ottimistica con rollback**: `chat.ts` marca gli slot come inviati subito
  dopo `adaptEnvelope` (così un secondo messaggio accodato non li riemette) e li
  **ripristina nel `.catch` di `sendChat`**, perché un turno fallito non ha consegnato
  niente alla CLI.
- **Gli slot modali non si deduplicano**: `plan-mode` viaggia sempre quando attivo. È
  piccolo, ed è uno *stato*, non un documento.
- **Ritiro esplicito.** Se uno slot inviato in precedenza sparisce (plan mode spento, file
  di contesto rimosso, pinned tolto), il preambolo porta una riga secca
  `Context no longer in effect: <slot>, <slot>`. Oggi non succede: il modello resta a
  credere di essere in plan mode dopo che è stato disattivato — **un bug che esiste già**
  e che questa change chiude di conseguenza.
- **Osservabilità**: `adaptationNotes` (già renderizzate dall'inspector) elencano gli slot
  saltati e i token risparmiati, così il comportamento è ispezionabile e non magico.
- **Kill switch**: `TOPICS_INLINE_CONTEXT_DEDUP=0` ripristina il comportamento attuale
  senza rollback del codice.

**Bug trovato strada facendo: l'obiettivo del topic non arriva mai al modello.**
`assemble.ts` produce il blocco `synthetic:goal` (`pushGoalBlock`) con
`injectedByTopicsApp: true` e `countInBudget: true` — l'ispettore lo mostra e lo conta nel
budget — ma `composeSystemMessages` non lo raccoglie in nessuno dei nove slot, quindi
**viene scartato in silenzio**. Verificato: `composeSystemMessages([goalBlock])` restituisce
`[]`. La funzione `goals.ts` è viva, il blocco è assemblato correttamente, e non è mai
uscito. Preesistente, non introdotto da questa change, e si chiude aggiungendo lo slot
mancante — che questa change deve comunque enumerare.

**Prompt caching sui provider SDK (allargamento richiesto).** `grep -rn "cache_control"
server/` non trova **nulla**. `server/providers/claude.ts` costruisce i params in tre punti
(`sendChat` L115-127, `streamHTTP` L228-240, `complete` L303-315), sempre con lo stesso
schema `splitSystemMessage` → `{ system, messages }`, e non marca **un solo** breakpoint di
cache. Ogni turno ripaga l'intero prefisso a prezzo pieno invece di 0,1x.

L'ordine del prefisso Anthropic è `tools → system → messages`, quindi tre breakpoint
`{ type: "ephemeral" }` coprono tutto ciò che si ripete:

1. **ultimo tool** — congela gli schemi dei tool;
2. **fine del `system`** — congela il preambolo di sistema;
3. **ultimo messaggio** — chiude la conversazione fin qui, così il turno successivo la
   rilegge dalla cache invece di riprefillarla.

Un helper unico `server/providers/prompt-cache.ts` applica i marker in-place ai tre
call-site, così non esistono due modi di costruire i params.

## Impact

- **Specs (delta)**: `context/` — ADDED `CTX-DEDUP-01` (invio differenziale),
  `CTX-DEDUP-02` (invalidazione dello scope), `CTX-DEDUP-03` (ritiro degli slot).
  `chat/` — ADDED `CHAT-CACHE-01` (breakpoint di prompt caching sui provider SDK).
  Nessun requisito esistente modificato.
- **Provider**: nuovo `server/providers/prompt-cache.ts`, applicato ai tre call-site di
  `server/providers/claude.ts`.
- **Server**: `server/context/adapt.ts` (firma + filtro + note), nuovo
  `server/context/inline-sent-state.ts`, `server/routes/chat.ts` (lettura scope, mark,
  rollback), `shared/context-envelope.ts` (`ProviderPayload.inlineSlots`).
- **Test**: `server/context/adapt.test.ts` (esteso), nuovo
  `server/context/inline-sent-state.test.ts`. La regressione byte-per-byte in
  `regression.test.ts` continua a valere con `alreadySent` vuota — che è il caso del
  primo turno.
- **Nessuna migration.** Lo stato è in memoria: perderlo dopo un riavvio del server costa
  **una** re-iniezione, contro le 32 di oggi, e si ricostruisce da solo.
- **Provider non toccati**: `history-aware` (claude SDK, openai, codex) e
  `gateway-stateful` (openclaw) restano identici.

## Out of scope

- La crescita del contesto *dentro* la CLI (p90 = 407k token/richiesta su questa sessione,
  massimo 459k): è la conversazione stessa, la governa l'auto-compact della CLI, non
  Topics.
- L'overhead fisso di ~48k token alla prima risposta (system prompt CLI + schema dei tool
  MCP montati). Merita una misura a sé: è una tassa su *ogni* richiesta di *ogni* sessione.
- Deduplicare la history dei provider `history-aware`.

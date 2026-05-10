## Why

Il contesto che il provider LLM riceve (system blocks + chat history + user turn) e quello che il **Context Inspector** mostra all'utente sono prodotti da **due implementazioni indipendenti**:

- **Provider path**: `streamEditResponse` in `server/routes/topics.ts:2517-2559` costruisce inline `finalMessages` + `ephemeralSystems` + `dbHistory` (via `buildProviderHistory`) e li passa a `provider.sendChat`.
- **Inspector path**: `GET /api/context/analyze` in `server/routes/openclaw-context.ts:136-362` ricostruisce **da zero** la lista delle source (file system + topic config + DB) per stimare il budget.

Conseguenze già osservabili (e potenziali) di questa doppia source-of-truth:

1. **Drift garantito ad ogni cambio**: aggiungere/rimuovere una source in uno dei due path lascia l'altro disallineato finché qualcuno non lo nota.
2. **Inspector non vede la chat history reale**: mostra solo le source statiche (system prompt, file, memoria, pinned) ma non i turn user/assistant post-`stripMarkers` post-`limit=100`. Se un topic ha 150 turn, l'inspector mostra "tutto ok" mentre il modello riceve solo gli ultimi 100.
3. **Markers strippati invisibili**: `stripMarkers()` rimuove `{{BROWSER:…}}`, `{{TOPIC_SWITCH:…}}`, `{{TOPIC_NEW:…}}` prima dell'invio. L'inspector mostra il messaggio "originale" dell'utente, non quello visto dal modello.
4. **Multi-provider asimmetrico**: `claude-code` inlina tutti i system block in `<context>…</context>` dentro lo user turn (no capability `history`); `openclaw` dichiara `history` ma il gateway può ignorare il field e usare session-state interno; `claude`/`openai`/`codex` ricevono history pulita. L'inspector è agnostico al provider attivo, quindi mostra la stessa cosa per tutti — falso.
5. **Niente snapshot di "ultimo invio"**: se il modello sembra "dimenticare", non possiamo verificare cosa abbia davvero ricevuto. Diagnostica cieca.

Il problema non è una bug puntuale, è **strutturale**: manca un envelope canonical condiviso tra "send" e "inspect".

## What Changes

### Canonical Context Envelope (Modulo `server/context/`)

Introduciamo un modulo dedicato che diventa l'unica funzione che produce "il contesto di un topic":

- `assembleTopicContext(sessionKey, providerName, opts)` → `ContextEnvelope`
- `ContextEnvelope` = `{ systemBlocks[], history[], userMessage, providerStrategy, diagnostics }`
- `diagnostics` espone: `totalTokens`, `budgetPercent`, `droppedHistoryTurns`, `historyEntries[].strippedMarkers`, `historyEntries[].excludeReason`, `warnings[]`, `assembledAt`.
- Stessa funzione, stesso input, stesso output — usata da **provider path** e **inspector path**.

### Provider Strategy & Adapter

- Aggiungiamo `provider.contextStrategy: "history-aware" | "inline-system" | "gateway-stateful"` come campo dichiarativo nei provider.
  - `claude`, `openai`, `codex` → `history-aware`
  - `claude-code` → `inline-system` (compatibile con behavior attuale: nessun cambio funzionale)
  - `openclaw` → `gateway-stateful` (history inviata come fallback, gateway può ignorare)
- `adaptEnvelope(envelope) → ProviderPayload` produce il payload concreto (`userContent`, `history?`, `options?`, `adaptationNotes[]`) in base alla strategy. È la **sola funzione** che decide se inlinare o passare history.
- `streamEditResponse` smette di avere logica "se supportsHistory else inline" inline: chiama `assembleTopicContext` poi `adaptEnvelope`.

### Inspector Allineato

- Nuovo endpoint `GET /api/topics/:id/context-preview?provider=<name>` ritorna l'envelope **completo** che sarebbe inviato adesso, incluse le diagnostics.
- Endpoint legacy `GET /api/context/analyze?topicId=…` diventa thin wrapper: chiama `assembleTopicContext` e proietta il vecchio shape (`{sources, totalTokens, budgetLimit, budgetPercent, warnings}`) per compatibilità con il client esistente.
- L'UI dell'inspector guadagna:
  - **System blocks** (categoria, label, tokens, enabled, preview) — già oggi
  - **History** reale (count + turns con markers strippati evidenziati)
  - **Adaptation notes** (es. "claude-code: 7 system blocks inlinati nel user turn")
  - **Provider name** visibile in alto

### Last-Sent Snapshots (Diagnostica)

- Ring buffer in-memory per topic (default 5 envelope), in `server/context/snapshots.ts`.
- Push automatico in `streamEditResponse` immediatamente prima di `provider.sendChat`.
- Endpoint `GET /api/topics/:id/context-snapshots` ritorna gli snapshot più recenti.
- UI inspector: tab "Last sent" che mostra l'envelope dell'ultimo turn realmente inviato + delta visivo con "Preview" se differisce (es. file di context modificato dopo).

## Impact

### Capability impactate (specs delta)

- `chat` — nuove req: canonical envelope, provider strategy, snapshot ring.
- `context` — req modificate/aggiunte: l'inspector deve riflettere l'envelope reale (history inclusa, markers strippati, provider-aware), endpoint preview/snapshots.

### File toccati

**Nuovi (server)**
- `server/context/envelope.ts` — tipi (`ContextEnvelope`, `SystemBlock`, `ProviderPayload`, `ProviderContextStrategy`, diagnostics).
- `server/context/assemble.ts` — `assembleTopicContext()`.
- `server/context/adapt.ts` — `adaptEnvelope()`.
- `server/context/snapshots.ts` — ring buffer + push/get/clear.
- `server/context/index.ts` — re-exports.
- `server/routes/context-preview.ts` — endpoint `/api/topics/:id/context-preview` + `/api/topics/:id/context-snapshots`.
- Test: `server/context/assemble.test.ts`, `adapt.test.ts`, `snapshots.test.ts`, `server/routes/context-preview.test.ts`.

**Modificati (server)**
- `server/routes/topics.ts` — `streamEditResponse` lines ~2517-2559 sostituite da `assembleTopicContext` + `adaptEnvelope` + `pushSnapshot`. Comportamento payload identico.
- `server/routes/openclaw-context.ts` — `/api/context/analyze` diventa proiezione di `assembleTopicContext` (back-compat shape).
- `server/providers/types.ts` — aggiunta `contextStrategy?: ProviderContextStrategy`.
- `server/providers/{claude,openai,codex,claude-code,openclaw}.ts` — dichiarano `contextStrategy`.
- `server/server.ts` (o entrypoint router) — wire del nuovo router context-preview.

**Modificati (client)**
- `client/src/lib/api.ts` — `contextPreviewApi.fetch(topicId, provider)`, `contextSnapshotsApi.list(topicId)`.
- `client/src/hooks/useContextInspector.ts` — opzionalmente consuma il nuovo endpoint quando disponibile (feature-detect), fallback a `analyze` per back-compat.
- `client/src/components/.../ContextInspector*.tsx` — nuova sezione "History" + "Adaptation notes" + tab "Last sent". Modifica non-breaking (sezioni nuove sotto le esistenti).

### Compat & rischi

- **Zero behavior change** sul payload realmente inviato ai provider (regression test garantisce stesso output).
- **Back-compat API** per `/api/context/analyze` mantenuta: client esistente continua a funzionare senza modifiche.
- **Inspector UI**: aggiunte sezioni nuove, nulla rimosso. Roll-back possibile semplicemente nascondendo nuove sezioni.
- Snapshot ring è in-memory: nessun impatto disk, ~5 KB/topic max.
- Performance: `assembleTopicContext` rilegge file system come fa oggi `analyze`. Cache 15s già esistente in `openclaw-context.ts` riusabile.

### Out of scope (deliberate)

- Persistenza snapshot su disco (in-memory sufficiente per debug live; aggiungibile in futura phase).
- Refactor di `topics.ts` per spezzare il monolite 3493-righe (questa change tocca solo le ~40 righe del context assembly).
- Cambio strategia per `claude-code` (resta `inline-system`, come da decisione utente).
- Tokenizer accurato per provider (resta `len/4` come stima; upgrade a `tiktoken`/Anthropic counter è una phase separata).

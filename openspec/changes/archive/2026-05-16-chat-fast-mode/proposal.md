## Why

Oggi ogni topic chat usa il modello "principale" del provider attivo: `claude-sonnet-4-6` per `claude-code`, `gpt-5-codex` per `codex`, `claude-sonnet-4-20250514` per `claude` API, `gpt-4o` per `openai`. È la scelta giusta per il 70% dei turn — code edits, planning, ragionamenti pesanti — ma per il restante 30% (parafrasi, riassunti, "spiegamelo veloce", risposte one-liner) paghiamo latenza + token in eccesso senza che il piccolo bonus di qualità del modello grande conti.

Manca un modo a **un click** di dire "rispondi veloce" senza:

1. Aprire il `ProviderModelPicker` ogni volta, scegliere un modello fast, ricordarsi di ripristinare quello forte alla fine — friction alto, errore probabile (rimani in fast per ore).
2. Cambiare provider — overkill, perde history (i provider stateful tipo `claude-code` non condividono la session).
3. Forzare `--haiku` via slash command — il provider claude-code lo supporta ma è una stringa magica non discoverable.

Il pattern `planMode` esistente (toggle binario per topic, persistito su `Topic.planMode`, button ClipboardList nella action bar di `ChatInput`) è il template naturale: **un toggle ⚡ binario per topic** che, quando ON, dice ai provider di usare il loro modello "fast" nativo.

## What Changes

### Client — toggle ⚡ Fast nella action bar di ChatInput

- Nuovo bottone `Zap` (lucide-react) posizionato **tra Plan mode e Context ring** in `ChatInput.tsx` (action bar, sezione "left tools").
- Stato `fastMode: boolean` mirror di `planMode`: hoistato in `ChatPane`, persistito su `localStorage` (`fastMode:${topic.id}`), inviato come `fastMode` in `/api/chat`.
- **Compatibile con plan mode**: i due toggle sono indipendenti (utente può attivare entrambi; Plan struttura la risposta, Fast usa il modello fast).
- Stile: quando ON → giallo/amber (`text-amber-500 bg-amber-500/10`), distinto dall'indigo di Plan mode.
- Tooltip: `"Fast model ON — using {providerName}'s fast model"` quando ON, `"Fast mode OFF — using {modelName}"` quando OFF.

### Server — risoluzione modello fast per provider

- Nuovo helper `getFastModelFor(providerName: string): string | null` in `server/providers/fast-models.ts`. Mappatura statica per provider, autorità singola:
  - `claude-code` → `"claude-haiku-4-5"` (Haiku 4.5, supportato dal CLI via `--model haiku`)
  - `claude` → `"claude-haiku-4-5-20251022"` (id Anthropic SDK ufficiale)
  - `codex` → `"gpt-4o-mini"` (Codex CLI supporta `--model gpt-4o-mini`)
  - `openai` → `"gpt-4o-mini"`
  - `openclaw` → `null` (gateway sceglie internamente; vedi sotto)
- Se `body.fastMode === true` E `body.model` non è esplicito (utente non ha forzato un modello dal picker), il route handler in `server/routes/topics.ts` sostituisce `overrideModel` con `getFastModelFor(provider.name)`.
- **Priorità di selezione modello** (dal più forte al più debole):
  1. Per-message picker override (`body.model`) — wins always.
  2. Fast mode flag (`body.fastMode === true`) → `getFastModelFor(provider.name)`.
  3. Topic-persisted model (`matchedTopic.model`).
  4. Provider default.
- Se il modello fast restituito non è nella `snap.providers[].models` list (es. CLI non aggiornato), il guard esistente al line 1689-1697 di `topics.ts` lo droppa e logga warning — fallback al modello default. Niente regressione silenziosa.

### Server — flag fastMode visibile nell'envelope diagnostics

- `ContextEnvelope.diagnostics` guadagna campo opzionale `fastMode?: boolean`.
- `assembleTopicContext()` accetta `opts.fastMode?: boolean` e lo propaga in `diagnostics.fastMode`.
- L'inspector context (read-only) può così mostrare nel preview "Fast mode: ON — modello effettivo: claude-haiku-4-5" senza re-leggere lo state client.
- **Zero effetto su systemBlocks/history**: fast mode NON taglia context. Solo il modello cambia.

### Persistence — Topic.fastMode

- Schema `Topic` (sia client che server) guadagna `fastMode?: boolean`.
- `PUT /api/topics/:id` accetta `fastMode` per persistenza cross-window (allineato al pattern di `planMode` già supportato).
- Cross-window sync via WebSocket `topic:updated` broadcast — utente che attiva Fast in una window vede il toggle aggiornato anche nelle altre.

## Impact

### Capability impactate (specs delta)

- `chat` — nuove req: composer espone toggle Fast; route `/api/chat` accetta `fastMode`; risoluzione modello rispetta priorità definita.
- `topics` — req aggiornata: `Topic` può portare `fastMode`, persistito in DB, sincronizzato cross-window.

### File toccati

**Nuovi (server)**
- `server/providers/fast-models.ts` — mappatura `providerName → fast model id` + helper `getFastModelFor()`.
- `server/providers/fast-models.test.ts` — test su mappatura + fallback `null` per provider sconosciuti.

**Modificati (server)**
- `server/routes/topics.ts` — `/api/chat` legge `body.fastMode`, applica `getFastModelFor()` quando `body.model` non è impostato (~10 righe, dopo il blocco "Resolve provider"). `PUT /api/topics/:id` accetta `fastMode`.
- `server/db/topics.ts` (o equivalente, da rintracciare) — colonna `fast_mode INTEGER DEFAULT 0` nella tabella `topics`. Migration sicura (default OFF, retro-compat).
- `server/context/envelope.ts` — `ContextDiagnostics.fastMode?: boolean`.
- `server/context/assemble.ts` — propaga `opts.fastMode` in `diagnostics.fastMode`.
- `server/context/assemble.test.ts` — test che `fastMode: true` finisce in diagnostics.

**Modificati (client)**
- `client/src/types/index.ts` — `Topic.fastMode?: boolean` (sotto `planMode`).
- `client/src/components/Chat/ChatInput.tsx` — nuovo prop `fastMode?: boolean` + `onToggleFastMode?: () => void`. Bottone `Zap` icon tra Plan mode (line ~840) e Context ring (line ~852). Stile amber.
- `client/src/components/Chat/ChatPane.tsx` — state `fastMode` con localStorage init/persist mirror di `planMode` (line ~114). Passa flag al server in `handleSendMessage` (line ~430). Sync ottimistico a `PUT /api/topics/:id` per persistenza cross-window.
- `client/src/hooks/useChat.ts` — `ChatRequest.fastMode?: boolean` + propagazione in `chatRequest` (line ~722).
- `client/src/lib/api.ts` — `ChatRequest` type guadagna `fastMode?: boolean`.

### Compat & rischi

- **Default OFF**: nessun comportamento cambia per topic esistenti. Migration aggiunge colonna con default 0.
- **Picker manuale wins**: se l'utente ha già scelto un modello specifico dal `ProviderModelPicker`, Fast mode è ignorato (priorità definita). Evita conflitti silenziosi tra due input dell'utente.
- **Provider override = `null`** (openclaw): gateway decide il proprio fast model — il route NON sovrascrive. Logga un info-level che fast mode è stato richiesto ma delegato.
- **Plan mode compatibile**: i due toggle sono indipendenti. Plan + Fast = "rispondi veloce ma con plan output". Test integrazione verifica.
- **Tests**: regression test su provider mapping (nuovo) + esistente regression test su `assembleTopicContext` (deve continuare a passare con/senza `fastMode`).

### Out of scope (deliberate)

- Auto-detect "messaggio leggero → suggerisci Fast" — non ora, evita magia silenziosa.
- Indicatore visibile nel `MessageBubble` "questo turn ha usato fast mode" — phase futura (richiede storage del modello effettivo per message).
- Modelli fast per provider non listati sopra (es. Gemini se aggiunto) — aggiungibili alla mappatura quando entrano.
- Token-cost telemetria fast vs slow — phase futura.

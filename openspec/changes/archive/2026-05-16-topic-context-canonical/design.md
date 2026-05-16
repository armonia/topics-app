# Design — Canonical Topic Context Envelope

## Goals

1. **Single source of truth** per il contesto di un topic. Provider e inspector chiamano la stessa funzione.
2. **Solidità**: zero behavior change sul payload inviato (regression test).
3. **Trasparenza**: l'inspector mostra cosa il provider riceve davvero (history strippata, blocchi inlinati, dropping per limit).
4. **Multi-provider**: la strategia di adattamento (history-aware, inline-system, gateway-stateful) è dichiarativa nel provider, non sparsa nel route handler.
5. **Diagnostica**: snapshot in-memory degli ultimi 5 invii per topic, ispezionabili da UI.

## Non-Goals

- Cambiare il behavior funzionale di `claude-code` (resta inline). Confermato dall'utente.
- Migrare il tokenizer (`len/4` resta).
- Spezzare `topics.ts` o riscrivere il flow streaming.

## Architettura

```
                ┌──────────────────────────────────────┐
                │  server/context/                     │
                │                                      │
   FS+DB ──►    │  assembleTopicContext()              │  ──► ContextEnvelope
                │       │                              │      ├ systemBlocks[]
                │       ▼                              │      ├ history[]
                │  • read FS sources (topic config,    │      ├ userMessage
                │    SOUL.md, memory, templates)       │      ├ providerStrategy
                │  • read DB messages                  │      └ diagnostics{…}
                │  • apply disabledContextSources      │
                │  • buildProviderHistory()            │
                │  • compute tokens, dropped, warnings │
                └──────────────────────────────────────┘
                          │                │
              ┌───────────┘                └────────────┐
              ▼                                          ▼
      adaptEnvelope(env)                       (envelope as-is)
        ProviderPayload                                  │
        ├ userContent                                    │
        ├ history?                                       │
        ├ options{model, tools}                          │
        └ adaptationNotes[]                              │
              │                                          │
              ▼                                          ▼
   provider.sendChat(...)                        Inspector UI
   (streamEditResponse)                          (preview + last-sent)
              │
              ▼
   pushSnapshot(env)
   ring buffer (5/topic)
```

## Tipi

```typescript
// server/context/envelope.ts

export type SystemBlockCategory =
  | "openclaw"     // SOUL.md, AGENTS.md, TOOLS.md, IDENTITY.md, USER.md, MEMORY.md (+memory tree)
  | "memory"       // global, topic-specific
  | "prompt"       // topic.systemPrompt
  | "template"     // CLAUDE.md, README.md, .cursorrules, AGENTS.md from project
  | "file"         // topic.contextFiles uploads
  | "pinned"       // topic.pinnedMessages aggregated
  | "synthetic";   // future: project-awareness, plan-mode, browser-tool instructions

export type ProviderContextStrategy =
  | "history-aware"       // claude, openai, codex — history field rispettato
  | "inline-system"       // claude-code — system blocks inlinati nel user turn
  | "gateway-stateful";   // openclaw — history inviata come fallback, gateway può ignorare

export interface SystemBlock {
  /** Stable id es. "openclaw:SOUL.md", "memory:topic", "prompt:system", "template:CLAUDE.md", "file:/abs/path", "pinned:messages" */
  id: string;
  label: string;
  category: SystemBlockCategory;
  content: string;
  tokens: number;
  /** Reflects topic.disabledContextSources */
  enabled: boolean;
  /** Whether this counts in the budget bar (memory tree e.g. is reference-only) */
  countInBudget: boolean;
  /** Optional file system path for editor */
  sourceUri?: string;
  /** Read-only (templates, openclaw) vs editable (memory, prompt) */
  editable: boolean;
}

export interface HistoryEntryDiagnostic {
  storedMessageId: string;
  role: "user" | "assistant";
  /** Markers found in the original content (for visibility) */
  strippedMarkers: string[];
  /** Bytes removed during stripping */
  bytesDropped: number;
  /** True if this entry is NOT in the final `history[]` */
  excluded: boolean;
  excludeReason?: "limit" | "context-message" | "partial" | "empty-after-strip" | "duplicate-last-user";
}

export interface ContextDiagnostics {
  totalTokens: number;
  budgetLimit: number;
  budgetPercent: number;
  /** Number of historic turns dropped because over `limit` */
  droppedHistoryTurns: number;
  /** One entry per StoredMessage considered, in chronological order */
  historyEntries: HistoryEntryDiagnostic[];
  warnings: { type: string; detail: string }[];
  assembledAt: number; // epoch ms
}

export interface ContextEnvelope {
  topicId: string;
  sessionKey: string;
  providerName: string;
  providerStrategy: ProviderContextStrategy;
  systemBlocks: SystemBlock[];
  history: ChatMessage[]; // post stripMarkers, post limit
  userMessage: { content: string; messageId?: string };
  diagnostics: ContextDiagnostics;
}

export interface ProviderPayload {
  userContent: string;
  history?: ChatMessage[];
  options?: { model?: string; tools?: Tool[] };
  /** Human-readable explanation of how the envelope was adapted */
  adaptationNotes: string[];
}
```

## `assembleTopicContext`

Firma:

```typescript
function assembleTopicContext(
  ctx: AppContext,
  args: {
    sessionKey: string;
    providerName: string;
    /** Se passato, il "user turn corrente" — usato per inspector preview ("se mandassi questo adesso, ecco cosa vedrebbe il provider"). Default: ultimo turn user dal DB. */
    userMessageOverride?: { content: string; messageId?: string };
    /** Default 100, allineato a buildProviderHistory */
    historyLimit?: number;
    /** Per inspector: se true, NON escludere l'ultimo user turn (mostra l'envelope da inviare); se false, escludi (matches streamEditResponse). Default true. */
    includeLastUserInHistory?: boolean;
    /** Default = topic.disabledContextSources. Override permesso per "what-if". */
    disabledSources?: string[];
  }
): ContextEnvelope
```

Algoritmo (mirroring esatto di logica esistente in `topics.ts` + `openclaw-context.ts`):

1. Carica topic da `loadTopics()`.
2. Costruisci `systemBlocks[]` nell'ordine:
   - 6 OpenClaw workspace files (SOUL.md, MEMORY.md, AGENTS.md, TOOLS.md, IDENTITY.md, USER.md) — `category: openclaw`, `editable: false`, sempre `enabled: true`, `countInBudget: true`.
   - OpenClaw memory tree (singolo block aggregato, `countInBudget: false`).
   - Global memory `_global.md` se esiste — `editable: true`.
   - Topic memory `${topicId}.md` se esiste — `editable: true`.
   - System prompt da `topic.systemPrompt` se non vuoto — `editable: true`.
   - Project templates: project-awareness sintetico + CLAUDE.md / README.md / .cursorrules / AGENTS.md / .claude/CLAUDE.md fallback — `editable: false`.
   - Context files (`topic.contextFiles`) — `editable: false`.
   - Pinned messages aggregati — `editable: false`.
3. Per ogni block, `enabled = !disabledSources.includes(block.id)`. `tokens = round(content.length / 4)`.
4. Carica messaggi da `loadLocalMessages(sessionKey)`. Per ogni messaggio costruisci `HistoryEntryDiagnostic`:
   - Trova markers presenti (`{{BROWSER:…}}`, `{{TOPIC_SWITCH:…}}`, `{{TOPIC_NEW:…}}`).
   - Calcola `bytesDropped` = `original.length - stripped.length`.
   - Determina `excludeReason` tra `partial`, `context-message`, `empty-after-strip`, `duplicate-last-user` (se `includeLastUserInHistory=false` e questo è l'ultimo user), `limit` (se oltre `limit`).
5. `history[]` = filtra esclusi, mappa a `ChatMessage[]` (con `stripMarkers + trim`).
6. `userMessage` = `userMessageOverride` se passato; altrimenti = ultimo user turn nel DB (necessario per preview senza POST in corso).
7. Calcola diagnostics: `totalTokens` = somma tokens degli enabled `countInBudget`; `budgetLimit = 200000`; `budgetPercent`; `warnings` (budget > 80%, large source > 10000 tokens).
8. `providerStrategy` = `getProviderStrategy(providerName)` (lookup nel registry).
9. Ritorna `ContextEnvelope`.

## `adaptEnvelope`

```typescript
function adaptEnvelope(envelope: ContextEnvelope): ProviderPayload {
  const enabledBlocks = envelope.systemBlocks.filter(b => b.enabled);

  switch (envelope.providerStrategy) {
    case "history-aware": {
      const systemMessages = enabledBlocks.map(b => ({ role: "system" as const, content: b.content }));
      return {
        userContent: envelope.userMessage.content,
        history: [...systemMessages, ...envelope.history],
        adaptationNotes: [
          `${enabledBlocks.length} system block(s) prepended as 'system' messages to history`,
          `${envelope.history.length} historic turn(s) included (after strip+limit)`,
          envelope.diagnostics.droppedHistoryTurns > 0
            ? `${envelope.diagnostics.droppedHistoryTurns} older turn(s) dropped due to limit`
            : null,
        ].filter(Boolean) as string[],
      };
    }
    case "inline-system": {
      const inlinePreamble = enabledBlocks.length === 0
        ? ""
        : `<context>\n${enabledBlocks.map(b => b.content).join("\n\n---\n\n")}\n</context>\n\n`;
      return {
        userContent: inlinePreamble + envelope.userMessage.content,
        // No history — provider keeps its own session state (CLI process-resident).
        adaptationNotes: [
          `${enabledBlocks.length} system block(s) inlined into user turn as <context> preamble`,
          `Provider does NOT receive history field — CLI session preserves prior turns`,
          `Inspector History tab shows what the CLI session has accumulated, not what we send this turn`,
        ],
      };
    }
    case "gateway-stateful": {
      const systemMessages = enabledBlocks.map(b => ({ role: "system" as const, content: b.content }));
      return {
        userContent: envelope.userMessage.content,
        history: [...systemMessages, ...envelope.history],
        adaptationNotes: [
          `${enabledBlocks.length} system block(s) sent as fallback (gateway typically uses internal session state)`,
          `History sent for rehydrate-on-restart only`,
        ],
      };
    }
  }
}
```

## Provider strategy registry

In `server/providers/types.ts`, estendiamo `Provider`:

```typescript
export interface Provider {
  // ... existing fields
  readonly contextStrategy?: ProviderContextStrategy;
}
```

Ogni provider la dichiara (default fallback se assente: `history-aware` se `capabilities.has("history")`, altrimenti `inline-system`).

```typescript
// claude.ts
readonly contextStrategy = "history-aware";

// openai.ts
readonly contextStrategy = "history-aware";

// codex.ts
readonly contextStrategy = "history-aware";

// claude-code.ts
readonly contextStrategy = "inline-system";

// openclaw.ts
readonly contextStrategy = "gateway-stateful";
```

Helper centralizzato:

```typescript
// server/context/provider-strategy.ts
export function getProviderStrategy(provider: Provider): ProviderContextStrategy {
  if (provider.contextStrategy) return provider.contextStrategy;
  return provider.capabilities.has("history") ? "history-aware" : "inline-system";
}
```

## Snapshots

```typescript
// server/context/snapshots.ts
const RING_SIZE = 5;
const snapshots = new Map<string, ContextEnvelope[]>();

export function pushSnapshot(envelope: ContextEnvelope): void {
  const key = envelope.topicId;
  const arr = snapshots.get(key) ?? [];
  arr.push(envelope);
  while (arr.length > RING_SIZE) arr.shift();
  snapshots.set(key, arr);
}

export function getSnapshots(topicId: string): ContextEnvelope[] {
  return [...(snapshots.get(topicId) ?? [])];
}

export function clearSnapshots(topicId?: string): void {
  if (topicId) snapshots.delete(topicId);
  else snapshots.clear();
}
```

Wire-in in `streamEditResponse`:

```typescript
const envelope = assembleTopicContext(ctx, {
  sessionKey,
  providerName: topicProvider.name,
  userMessageOverride: { content: lastUser, messageId: lastUserMsg?.id },
  includeLastUserInHistory: false, // matches "user turn passed via userContent, not duplicated"
});
pushSnapshot(envelope);
const payload = adaptEnvelope(envelope);

topicProvider.sendChat(
  sessionKey,
  payload.userContent,
  handler,
  { ...payload.options, history: payload.history, model: overrideModel, tools: ... }
);
```

## Endpoint preview

`server/routes/context-preview.ts`:

- `GET /api/topics/:id/context-preview?provider=<name>` (provider opzionale, default = topic provider corrente)
  - Ritorna: `{ envelope: ContextEnvelope, payload: ProviderPayload }`.
  - Inspector può mostrare entrambi: envelope normalizzato + payload effettivo.
- `GET /api/topics/:id/context-snapshots`
  - Ritorna: `{ snapshots: ContextEnvelope[] }` (chronological, oldest first).
- `DELETE /api/topics/:id/context-snapshots` (opzionale, debug)
  - Pulisce il ring per il topic.

## Compat layer

`/api/context/analyze` esistente in `openclaw-context.ts` → riscritto come:

```typescript
const envelope = assembleTopicContext(ctx, { sessionKey: topic.sessionKey, providerName: topic.provider, includeLastUserInHistory: true });
return json({
  sources: envelope.systemBlocks.map(b => ({
    id: b.id, label: b.label, category: b.category,
    tokens: b.tokens, enabled: b.enabled, editable: b.editable,
    preview: b.content.slice(0, 200), countInBudget: b.countInBudget,
  })),
  totalTokens: envelope.diagnostics.totalTokens,
  budgetLimit: envelope.diagnostics.budgetLimit,
  budgetPercent: envelope.diagnostics.budgetPercent,
  warnings: envelope.diagnostics.warnings,
});
```

Cache 15s preservata (chiave: `topicId` + `providerName`).

## Testing strategy

### Unit

- `assemble.test.ts`: 8+ scenari (topic minimo, tutti i source on, alcuni disabled, project con CLAUDE.md alternativo `.claude/CLAUDE.md`, pinned, contextFiles, history > 100 → drop, marker stripping).
- `adapt.test.ts`: una matrice completa (3 strategy × scenari con/senza system blocks, con/senza history). Verifica `adaptationNotes` formate correttamente.
- `snapshots.test.ts`: ring di 5, push 7 → tieni ultimi 5, clear, isolation per topic.

### Regression (golden)

- `assemble-regression.test.ts`: per un fixture topic, snapshot dell'envelope output. Cattura il behavior corrente prima del refactor, confronta dopo.
- `topics-route-payload.test.ts` (integration): mock provider, esegui un POST `/api/topics/:id/message`, verifica che il `sendChat` riceva esattamente lo stesso `userContent` + `history` di prima del refactor.

### E2E (light)

- `context-preview.test.ts`: GET preview ritorna envelope, snapshots crescono dopo POST message, count ≤ 5.

## Migration plan (ordine commit)

1. **Commit 1**: Add types `server/context/envelope.ts` + tests scaffold (no consumers). Build verde.
2. **Commit 2**: Add `assembleTopicContext` + golden test su fixture esistente. Inspector e route NON la usano ancora.
3. **Commit 3**: Add `adaptEnvelope` + provider strategy field + tests. Provider non lo usano ancora.
4. **Commit 4**: Refactor `streamEditResponse` per usare `assembleTopicContext` + `adaptEnvelope`. Regression test conferma payload identico.
5. **Commit 5**: Refactor `/api/context/analyze` come thin wrapper.
6. **Commit 6**: Add snapshots + endpoint `context-preview` + `context-snapshots`.
7. **Commit 7**: Client UI inspector — nuova sezione "History" + "Adaptation notes" + tab "Last sent". Feature-detect endpoint nuovo.
8. **Commit 8**: Cleanup — rimuovi codice morto, aggiorna docs.

Ogni commit è atomico e test-verde. Roll-back possibile a qualsiasi punto.

## Decisioni chiuse

- **Strategia claude-code**: resta `inline-system`. Confermato (zero behavior change).
- **Workflow**: openspec change formale (questo doc).
- **Multi-provider scope**: tutti e 5 (claude, openai, codex, claude-code, openclaw).
- **Snapshot persistence**: solo in-memory (5/topic), niente disk.
- **Tokenizer**: stays `len/4`. Upgrade in phase separata.

## Decisioni aperte (da discutere durante esecuzione)

- **D1 — Default `historyLimit`**: 100 (status quo) vs. provider-aware (es. 200 per claude opus, 100 per altri)? Proposta: stay 100 in questo change, parametrizzare in phase futura.
- **D2 — Snapshot include il payload o solo l'envelope?** Proposta: solo envelope (il payload è derivabile via `adaptEnvelope`). Riduce memoria.
- **D3 — Inspector mostra il payload finale o solo l'envelope?** Proposta: entrambi (tab "Envelope" canonico + tab "Provider payload" con `userContent`/`history` adattato). UI a fisarmonica.

## Decisioni emerse durante l'esecuzione

- **DR1 — `streamEditResponse` (server/routes/topics.ts:645) NON rifattorizzato**: la funzione separata che gestisce l'edit-stream di un messaggio ha un suo mini-assembly inline (~70 righe) con un *sottoinsieme* dei system blocks (solo systemPrompt + contextFiles + projectTemplates — NESSUNO di memory/pinned/markers/topic-switch/plan). Refactorarla per usare `assembleTopicContext` cambierebbe il behavior dell'edit-stream aggiungendo blocks che oggi non riceve, in violazione della garanzia "zero behavior change". Decisione: rifattorizzazione in una phase separata, eventualmente con un parametro `blocksMode: "full" | "edit-stream"` su `assembleTopicContext`. Per questa change l'edit-stream resta intatto.

- **DR2 — OpenClaw informational blocks scopati a provider=openclaw**: la `/api/context/analyze` legacy mostrava i 6 file workspace OpenClaw (SOUL/MEMORY/AGENTS/TOOLS/IDENTITY/USER + memory tree) per *qualsiasi* topic, ma il gateway openclaw è l'unico componente che li inietta nel system prompt. Mostrarli per topic con provider claude/openai/codex/claude-code è informazione falsa (il modello non li riceve). Decisione: `assembleTopicContext` chiama `pushOpenClawInformationalBlocks` SOLO se `providerName === "openclaw" || providerStrategy === "gateway-stateful"`. Cambio rispetto al legacy ma giustificato — l'inspector ora dice la verità.

- **DR3 — `sessionMeta` aggiunto al `ContextEnvelope`**: campo opzionale con `topicName / modelName / projectPath / workingDir / worktreeId / totalStoredMessages / planMode`. Non parte di ciò che il modello vede, ma necessario all'inspector per dare il quadro completo della sessione (richiesta utente: "mostra il contesto della sessione completo e dettagliato"). Renderizzato in alto nella tab Preview di `<ContextEnvelopeView>`.

- **DR4 — Helper `affectsTopic`/`affectsAnyTopic` in `useContextInspector.ts`**: il pattern `(msg.type === 'topic:updated' && msg.topic?.id === topicId)` non si type-narrowing pulitamente nella discriminated union `WSMessage`. Estratto in helper con cast esplicito isolato; il pattern legacy in `useMultiContextPercent` è stato anche aggiornato per consistenza.

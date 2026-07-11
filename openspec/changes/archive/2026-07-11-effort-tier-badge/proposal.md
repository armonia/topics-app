## Why

Topics forza silenziosamente il tier di effort massimo per le sessioni **Claude Code**:
`resolveClaudeEffort()` (`server/lib/topics-agent-prompt.ts:29-70`) risolve
`TOPICS_CLAUDE_EFFORT` → `CLAUDE_EFFORT` → default `"xhigh"` e passa `--effort xhigh`
esplicito allo spawn (`server/providers/claude-code.ts:1003`, `server/routes/terminal.ts:917`).
Questo replica il comportamento "ultracode" di una shell Warp (che esporta
`CLAUDE_EFFORT=xhigh`), reso necessario dal fatto che sotto launchd l'ambiente del server
non porta quella env var e l'`effortLevel` globale dell'utente in `settings.json` è
`"low"` di default. **Nella CLI `claude` stessa il tier di effort è un concetto di primo
piano** (flag `--effort`, tier `low/medium/high/xhigh/max`) — ma in Topics questo valore
forzato non è mai esposto in UI: l'utente lo scopre solo leggendo i commenti del codice
server, non ha modo di vedere a colpo d'occhio a quale tier sta girando una sessione.

**Codex non ha alcun meccanismo equivalente.** `server/providers/codex.ts` (`sendChat()`,
righe 280-334) spawna `codex exec --json --skip-git-repo-check` con override `-c
mcp_servers.topics.*` per il bridge MCP, ma nessun override sul reasoning effort: la
sessione eredita qualunque default sia in `~/.codex/config.toml` dell'utente (spesso
`medium`), incoerente con l'approccio "top capability by default" che Topics applica a
Claude Code. Il Codex CLI espone lo stesso meccanismo di override `-c key=value` già usato
per il bridge MCP; è verosimile che la chiave `model_reasoning_effort` in
`~/.codex/config.toml` sia raggiungibile allo stesso modo, ma questo va confermato contro
il binario reale prima di cablarlo (vedi design.md D1 e Phase 0 di tasks.md).

## What Changes

1. **Codex ottiene un resolver di reasoning-effort mirror di Claude.** Una nuova funzione
   `resolveCodexReasoningEffort()` in `server/lib/topics-agent-prompt.ts` (stesso file,
   stesso pattern di `resolveClaudeEffort()`) SHALL risolvere un tier per le sessioni Codex
   con lo stesso ordine di precedenza (override Topics → mirror env → default), e SHALL
   essere iniettata come override `-c model_reasoning_effort=<tier>` sia in
   `codex.ts:sendChat()` sia nello spawn PTY equivalente di Codex in `terminal.ts` — solo
   dopo che Phase 0 di tasks.md ne conferma la chiave/i valori validi contro il CLI
   installato.

2. **Il tier risolto SHALL essere esposto nella snapshot dei provider**, non nascosto
   server-side. `ProviderSnapshotEntry` (`shared/types.ts:115-128`, tipo unico condiviso
   client/server) guadagna un campo opzionale `effortTier?: string`, popolato in
   `snapshot-manager.ts:refreshOne()` (righe 118-129) chiamando `resolveClaudeEffort()` per
   l'entry `claude-code` e `resolveCodexReasoningEffort()` per l'entry `codex`. Nessun nuovo
   endpoint: il canale esiste già (`/api/providers/snapshot` + WS), `ProviderModelPicker`
   lo consuma già via `useProvidersSnapshot()`.

3. **Badge visibile nel picker.** `ProviderModelPicker.tsx` SHALL mostrare il tier come
   badge testuale quando `effortTier` è presente: (a) accanto al nome modello nel bottone
   collassato (righe 146-159), (b) nella riga di gruppo del popover, accanto — non al posto
   — del pill "Default" esistente (righe 270-277). Nessun controllo: sola lettura, il tier
   resta una policy server-side.

4. **Fallback silenzioso se Codex non supporta l'override.** Se Phase 0 rivela che il CLI
   Codex installato rifiuta `model_reasoning_effort` (chiave sbagliata o CLI troppo vecchio),
   il sistema SHALL non bloccare l'avvio della sessione (stesso pattern try/catch già usato
   per l'iniezione del bridge MCP in `codex.ts:320-326`) e `effortTier` per `codex` SHALL
   restare `undefined` — il badge semplicemente non compare, invece di mostrare un valore
   mai realmente applicato.

**Non-goal:** nessun controllo UI per CAMBIARE il tier per-sessione da Topics (resta una
policy server-side "sempre il massimo disponibile", coerente con l'approccio attuale su
Claude Code); nessuna modifica al comportamento se il Codex CLI non è installato o non
supporta l'override (fallback silenzioso, mai un errore bloccante); nessun badge sulle
righe dei singoli tool-call — il tier è una proprietà del provider/sessione, non del
singolo turno.

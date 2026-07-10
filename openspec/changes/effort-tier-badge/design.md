## Context

Verifica sul codice vivo:
- `resolveClaudeEffort()` (`server/lib/topics-agent-prompt.ts:29-70`) — ordine
  `TOPICS_CLAUDE_EFFORT` → `CLAUDE_EFFORT` → default `"xhigh"`; `VALID_CLAUDE_EFFORTS =
  {low, medium, high, xhigh, max}`; consumata da `claude-code.ts:1003` e
  `terminal.ts:917` per passare `--effort` allo spawn.
- `codex.ts:sendChat()` (righe 280-334) — nessun override di reasoning-effort oggi. Usa già
  il pattern `-c key=value` per il bridge MCP (righe 320-326:
  `-c mcp_servers.topics.command=...`, `-c mcp_servers.topics.args=...`), con
  `JSON.stringify` sul valore (parsing TOML-compatibile per stringhe/array). Il commento a
  righe 301-303 spiega che `--model` è forwarded solo se esplicito per non rompere account
  ChatGPT-bound che leggono `~/.codex/config.toml` — stesso principio si applica a un
  eventuale override di reasoning-effort: deve essere additivo, non deve rompere setup
  esistenti.
- `ProviderSnapshotEntry` è definito **una sola volta** in `shared/types.ts:115-128` e
  ri-esportato sia server (`server/providers/types.ts:459`) sia client
  (`client/src/types/index.ts`) — un solo punto di modifica per il nuovo campo.
- `snapshot-manager.ts:refreshOne()` (righe 111-141) costruisce l'`entry` una volta per
  refresh, in parallelo con `diagnose()`/`listModels()`; è l'unico punto che assembla i
  campi dell'entry prima di `this.entries.set(name, entry)`.
- `ProviderModelPicker.tsx`: bottone collassato righe 146-159 (`<Zap/>` + `buttonLabel`,
  nessuno slot badge oggi); riga di gruppo nel popover righe 270-277 (pill "Default" con
  `ml-auto`, quindi spinto tutto a destra — un badge aggiuntivo va posizionato PRIMA
  dell'`ml-auto` per non essere spinto anch'esso a destra e sovrapporsi).

## Decisions

### D1 — Reasoning-effort Codex: probe prima di cablare, poi mirror di Claude
`resolveCodexReasoningEffort()` in `server/lib/topics-agent-prompt.ts`, stesso file e
stesso pattern testuale di `resolveClaudeEffort()`: ordine `TOPICS_CODEX_REASONING_EFFORT`
→ `CODEX_REASONING_EFFORT` (mirror env) → default. **Il nome esatto della chiave TOML
(`model_reasoning_effort` è l'ipotesi di partenza) e i tier validi (verosimilmente
`minimal/low/medium/high`, senza il `xhigh`/`max` di Claude) SHALL essere confermati con un
probe manuale contro il Codex CLI installato PRIMA di scrivere il resolver** (Phase 0 di
tasks.md) — non esiste nel repo alcun riferimento pregresso a questa chiave, a differenza
di `--effort` per Claude che è già documentato e verificato. Se il probe fallisce, il
default scelto è comunque il tier più alto **confermato funzionante**, non un valore
inventato.
Iniettato come `-c model_reasoning_effort=<tier>` in `codex.ts:sendChat()` (dopo il blocco
try/catch del bridge MCP, righe ~320-327) e nello spawn PTY Codex equivalente in
`terminal.ts` (mirror del punto già esistente per Claude a riga 917).
Alternativa scartata: leggere/riscrivere `~/.codex/config.toml` invece di usare `-c`
override — invasivo (tocca un file utente fuori dal controllo di questa sessione),
scartato per lo stesso motivo per cui Claude usa `--effort` esplicito invece di riscrivere
`settings.json`.

### D2 — Esposizione via `ProviderSnapshotEntry`, nessun nuovo endpoint
`effortTier?: string` aggiunto a `shared/types.ts:115-128` (unico punto, propagato
automaticamente a client e server via i re-export esistenti). Popolato in
`snapshot-manager.ts:refreshOne()` dentro l'`entry = {...}` di successo (righe 118-129):
`effortTier: name === "claude-code" ? (resolveClaudeEffort() ?? undefined) : name ===
"codex" ? (resolveCodexReasoningEffort() ?? undefined) : undefined`. Nessuna nuova rotta,
nessun nuovo evento WS: `useProvidersSnapshot()` e `ProviderModelPicker` già consumano
questo canale.
Alternativa scartata: endpoint dedicato `/api/providers/effort` — frammenterebbe lo stato
provider in due fetch invece di uno, senza benefici (il dato è piccolo e cambia alla stessa
cadenza dello snapshot).

### D3 — Badge minimale, sola lettura, coesiste col pill "Default"
Badge testuale statico (es. `xhigh`), stesso stile del pill "Default" esistente
(`text-[11px]`, sfondo tenue, angoli arrotondati) ma colore distinto per non confondersi.
Due punti di inserimento:
- Bottone collassato (`ProviderModelPicker.tsx:146-159`): badge accanto a `buttonLabel`
  quando il provider attivo (`effective.provider`) è `claude-code` o `codex` e ha
  `effortTier`.
- Riga di gruppo nel popover (righe 270-277): badge inserito **prima** dello span
  `ml-auto` del pill "Default", cosicché entrambi possano comparire sulla stessa riga senza
  sovrapporsi (il pill Default resta spinto a destra dall'`ml-auto`).
`title`/tooltip esplicativo su entrambi (es. "Reasoning effort: xhigh (forzato da Topics)").
Alternativa scartata: badge su ogni riga di `ToolCallRow`/sessione — rumoroso e ridondante,
l'effort è una proprietà del provider/sessione non del singolo tool call (coerente con
Non-goal #3 della proposal).

### D4 — Fallback silenzioso se Codex rifiuta l'override
Se il probe di Phase 0 rivela che il CLI Codex installato non accetta la chiave scelta (o
se in produzione lo spawn con `-c model_reasoning_effort=...` fallisse per una versione CLI
diversa), il sistema SHALL loggare un warning una tantum e NON bloccare l'avvio della
sessione — stesso pattern try/catch già in uso per l'iniezione del bridge MCP
(`codex.ts:320-326`). In questo scenario `resolveCodexReasoningEffort()` ritorna `null`,
l'override `-c` non viene iniettato, ed `effortTier` per l'entry `codex` resta
`undefined` → il badge Codex semplicemente non compare, mai un valore falso.

## Verifica
- **Phase 0 (blocca il resto):** probe manuale `codex exec --json --skip-git-repo-check -c
  model_reasoning_effort=high "ping"` (o equivalente da `codex --help`/schema di
  `~/.codex/config.toml`) per confermare chiave e tier validi PRIMA di scrivere qualunque
  codice di Phase 1+.
- Unit (`bun:test`): `resolveCodexReasoningEffort()` — stesso set di casi già coperti (o da
  coprire) per `resolveClaudeEffort()`: override esplicito, mirror env, default, valore non
  riconosciuto → `null`.
- Verifica manuale UI: aprire `ProviderModelPicker` su una sessione `claude-code` e una
  `codex` (se Phase 0 riesce), confermare che il badge mostri il tier corretto in entrambi i
  punti di inserimento e non si sovrapponga al pill "Default".
- tsc client + server verdi (il campo `effortTier` è opzionale, nessuna rottura dei
  consumer esistenti di `ProviderSnapshotEntry`).

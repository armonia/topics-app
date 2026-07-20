# Tasks — chat-tool-experience

Convenzione: `[ ]` da fare, `[x]` fatto+verificato.

> STATO: **completo e verificato LIVE.** Smoke sul dev server :3333 (turno reale
> claude-code, CLI 2.1.215): Write annunciato con `arguments:"{}"` all'inizio della
> generazione input, stesso id ri-broadcastato con args completi al block stop,
> `startedAt/endedAt` persistiti (durata reale 8.76s vs ~0.2s visibile prima).
> 17 unit test verdi, 6+11+6 E2E verdi (tool-call-ui / rendering+real / provider),
> tsc client+server 0 errori.

## Phase 0 — Transport sync (CHAT-TOOL-01)
- [x] 0.1 `claude-code.ts`: `--include-partial-messages` tra gli argv del CLI.
- [x] 0.2 `handleCLIEvent`: ramo `stream_event` → `handlePartialStreamEvent`
  (content_block_start tool_use → onToolStart anticipato; input_json_delta →
  accumulo; content_block_stop → parse + finalizeToolArgs). Skip sidechain
  (`parent_tool_use_id`); buffer ripuliti su `result`/nuovo turno.
- [x] 0.3 Snapshot assistant: path "late-args" per tool già annunciati
  (finalizeToolArgs idempotente via `argsFinalized`; detectUserInputForTool spostato
  in helper; `SidechainTracker.updateParentInput` back-filla i Task registrati early).
- [x] 0.4 Route handler: `onToolArgsUpdate` → updateToolCallFields + updateBlockTool +
  re-broadcast `stream:tool_call` (upsert client per id). `startedAt` in onToolStart,
  `endedAt` su TUTTI i path di settlement (onToolResult, finalize-loop, dispatch
  browser_*/control) via param `extra` di `updateToolCallResult`.
- [x] 0.5 Tipi: `startedAt`/`endedAt` su ToolCall (server + client + WS result msg),
  `onToolArgsUpdate?` su StreamHandler.

## Phase 1 — ToolGroupRow (CHAT-TOOL-02)
- [x] 1.1 `toolGrouping.ts`: partitionToolGroup + summarizeToolGroup + GROUP_MIN(3) +
  toolCallDigest/highlights (comandi shell, basename file, pattern, host — "cosa è
  stato fatto", non solo quante volte) + formatter durate.
- [x] 1.2 `toolGrouping.test.ts` (bun:test): 17 verdi.
- [x] 1.3 `ToolGroupRow.tsx`: header sintesi (conteggi, durata span, badge errori,
  spinner live, riga highlights quando collassato), expand/collapse, live = sintesi
  completate + call attive montate col body caldo.
- [x] 1.4 `MessageContent.tsx`: gruppi `kind:'tools'` E legacyTools → GroupedToolRows
  (il path inline con contentOffset resta per-riga).

## Phase 2 — Anti-flash (CHAT-TOOL-03)
- [x] 2.1 `ToolCallRow.tsx`: auto-open ritardato 250ms + dwell minimo 1.5s, toggle
  utente sempre prevalente. Header ristilato alla Claude Code — `Shell(bun test)`,
  summary in secondary (non più muted) + durata per-call (elapsed live / span finale).

## Phase 3 — Highlighting (CHAT-TOOL-04)
- [x] 3.1 `lib/syntaxHighlight.ts`: `langFromPath()` (estensione → fence lang, alias
  esistenti; Dockerfile/Makefile speciali).
- [x] 3.2 `ToolCards.tsx`: HighlightedPre condiviso (stesso facade lazy di CodeBlock,
  HTML sicuro by-construction: hljs escapa il sorgente); wiring su Read/Write/Edit
  before-after/Shell command. Palette `.tool-card-code` theme-aware in index.css
  (One-Light in light, One-Dark sotto `.dark` — i fence restano sempre-dark).

## Phase 4 — Verifica
- [x] 4.1 E2E: +3 test in tool-call-ui.spec.ts (gruppo con conteggi/durata/errori/
  highlights, solo sub-agent, highlight hljs); rendering/real/provider invariati verdi.
- [x] 4.2 tsc -b client 0 err, typecheck:server 0 err (baseline 0); 17 unit verdi.
- [x] 4.3 Smoke live su :3333 (vedi STATO sopra) — topic usa-e-getta poi eliminato.

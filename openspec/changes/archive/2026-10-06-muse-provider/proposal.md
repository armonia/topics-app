# Change: muse-provider

## Why

Topics parla con claude-code, codex, jcode/gemini (ACP), API Anthropic/OpenAI e il runtime nativo — ma non con Muse, il CLI che su questa macchina è già installato, autenticato (OAuth Meta, token in keychain) e più economico da usare. Chi lavora in Topics oggi non può scegliere Muse in nessun picker, nessun default, nessun task di board. Verificato: `muse exec --json --session-id` crea/riprende sessioni reali (2 turni, memoria OK) e lo stdout è JSONL puro line-buffered con delta (`run.output.delta`) + terminale (`run.terminal.*`) — la stessa forma che `CodexProvider` già consuma.

## What changes

1. **Nuovo provider `muse`** (`server/providers/muse.ts` + `muse/args.ts`, `muse/models.ts`), specchio di `CodexProvider`: one-shot `muse exec --json` per turno, resume via `--session-id` persistito per Topics session (tabella `muse_sessions`), mapping JSONL→`StreamHandler`, abort, usage, `diagnose`/`listModels`/`effortTier`/`defaultModel`. Capabilities: `streaming, coding-tasks, tools, sessions, abort, history`; `contextStrategy` esplicita.
2. **Registry**: `case "muse"` in `createProvider`, blocco detect+register in `initProviders` (via nuovo `server/lib/muse-bin.ts`), `muse` in `PROVIDER_PREFERENCE_ORDER` dopo `codex` (mai default rubato), `MuseProviderConfig` nella union, `museModel` in app-settings (+migration, `FIELD_RULES`), `muse` in `CLI_AGENT_IDS`/`CLI_AGENT_BIN_NAMES`/`detectAgents`.
3. **Catalogo/modelli**: da `~/.local/share/muse/model-catalog/*.json` (solo visible) + default da `settings.json`; fallback statico `muse-spark-1.3-contributor`. Finestre contesto in `shared/context-window.ts` o dichiarate via snapshot.
4. **UI parità (non-terminale)**: riga in `PROVIDER_ORDER` + `provider-labels.ts`, `modelMaker.ts` (`RUNTIME_PREFIXES`/`ENGINE_MAKERS`), `modelLabel.ts` (regex `muse:`), `task-coding-models.ts` (filtro modelli), `useModelCatalog.ts` (`signInCommand` = `muse login`), `ProviderDetail.tsx` solo se servono righe dedicate. Il resto (section, panel CLI, picker chat, popover, modal, snapshot store, i18n) è generico e a cambio zero — verificato sui corpi.
5. **Task/dispatch**: muse entra nel catalogo task via capability `coding-tasks`; mapping effort `topics→--reasoning-effort`; fork resta `db-history` (nessun fork nativo).
6. **Terminale PTY**: ramo spawn in `routes/terminal.ts` + valore `muse` nel CHECK `terminal_sessions.type` (+migration, `shared/terminal-session-types.ts`, gate test).

## Out of scope

- **Default automatico**: l'ordine resta claude-code-first; muse è eleggibile ma non preferito. Nessun nuovo `agentRuntime`.
- **MCP bridge** verso muse (`topicsMcpBridgeSpec`): muse non espone mount MCP documentato — il provider gira senza bridge finché non emerge un flag.
- **Orchestrator globale** (resta pinnato a codex), **runtime subagent** (enum `topics|claude-code` invariato), **slash side-channel**, **usage-limit parser** (nessun wall identificabile → nessun hold tracking).
- Fork nativo: si usa il path generico `db-history`.

## Risks

- **Wire shape di meta non vista**: lo sweep ha mappato solo echo (1 delta, nessun evento tool/usage). Mitigazione: task 0 cattura un turno meta reale con tool e fissa il mapping; parser difensivo, eventi ignoti ignorati (come codex).
- **Drift CLI**: muse è giovane e rompe argv spesso. Mitigazione: argv pura + snapshot test (stessa regola di `codex/args.ts`).
- **SQLite/CHECK drift**: ogni CHECK toccato ha il suo gate test rosso-senza-migration.
- **PR238** (subagent-nativi, 87 file, merge congelato): overlap solo su 4 file additivi (`providers/types.ts`, `shared/types.ts`, `routes/providers.ts`, i18n) — rebase a merge avvenuto.

## Impact

- **Server**: +`providers/muse.ts`, `providers/muse/{args,models}.ts`, `lib/muse-bin.ts`; edit `providers/{index,types}.ts`, `services/app-settings.ts`, `routes/{app-settings,providers,terminal}.ts`, `lib/{agent-bin-paths,detect-agents,topics-agent-prompt}.ts`, `shared/{provider-labels,task-coding-models,modelMaker,context-window,terminal-session-types}.ts`, `context/provider-strategy.test.ts` (caso muse).
- **Client**: edit `Settings/providersModel.ts`, `ModelSelector/useModelCatalog.ts`, `lib/modelLabel.ts`, `Settings/ProviderDetail.tsx` (se knob propri).
- **DB**: 2 migration (`muse_sessions`, `terminal_sessions.type` +muse).
- **Tests**: `bun:test` su parser/args/models/bin/resolver + fixture fake-muse per l'integrazione; Playwright sul picker.

## Deciso da me

Trasporto one-shot+resume (non `muse serve`/MSP: nuovo client protocollo per zero benefici oggi); posizione default dopo codex; catalogo da cache CLI; fork db-history; niente MCP bridge; niente runtime quarto. Nessuna decisione per Attilio: nessuna spesa, nessun dato personale, tutto reversibile su branch.

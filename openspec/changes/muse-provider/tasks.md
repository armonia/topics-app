# Tasks: muse-provider

Una traccia = una barra. Stato da git/test, non da caselle. Ordine: 0 → 1 → 2 → 3 → 4 → 5.

## 0. Cattura wire meta reale (blocca il mapping)

- Esegui 2 turni meta via CLI: uno con tool (chiedi di leggere un file) e uno con errore; salva stdout JSONL + exit code in `server/providers/muse/fixtures/`.
- Individua eventi tool/usage reali (echo non li ha); se manca l'usage su stdout, documenta la fonte scelta (durable log? assente?).
- Barra: fixture committate + tabella eventi in `server/providers/muse/WIRE.md` (≤80 righe).

## 1. Provider + bin + args + models

- `server/lib/muse-bin.ts` (`resolveMuseBin`, cache reset; override Settings → `MUSE_BIN` → `Bun.which` → CANDIDATES + Windows).
- `server/providers/muse/args.ts` (argv pura + snapshot) e `models.ts` (catalogo da cache CLI + fallback statico + finestre).
- `server/providers/muse.ts` (specchio codex: sendChat one-shot+resume, routeMuseEvent, abort owner-scoped, usage, `diagnose/listModels/effortTier/defaultModel/contextWindows`, probe owns/isAlive).
- Test: `muse.test.ts` (mapping/usage/errori/resume-fallback), `muse/args.test.ts`, `muse/models.test.ts`, `lib/muse-bin.test.ts`, `muse-integration.test.ts` (fake-muse fixture).
- Barra: BAR-1 + BAR-7 (mutazione: commenta la riga `onTextDelta` nel mapper → BAR-1 rosso; ripristina).

## 2. Registry + settings + snapshot

- `providers/types.ts` (`MuseProviderConfig` + union), `providers/index.ts` (case, blocco init, `PROVIDER_PREFERENCE_ORDER`, `detectMuseCli`).
- `services/app-settings.ts` + `routes/app-settings.ts` (`museModel` in interfaccia/EMPTY/Row/rowToSettings/COLUMNS/FIELD_RULES + migration), `lib/agent-bin-paths.ts`, `lib/detect-agents.ts`, `lib/topics-agent-prompt.ts` (effort muse), `shared/context-window.ts`, `context/provider-strategy.test.ts` (caso muse).
- Barra: BAR-2 (sottoinsieme server) + BAR-3; snapshot `/api/providers` mostra muse con modelli su macchina con CLI.

## 3. Task/dispatch + hold + modelMaker

- `shared/task-coding-models.ts` (filtro modelli muse), `shared/modelMaker.ts` (RUNTIME_PREFIXES/ENGINE_MAKERS), `shared/provider-labels.ts`, `client/src/lib/modelLabel.ts` (regex `muse:`).
- Nessun hold tracking (deciso: nessun wall identificabile).
- Barra: BAR-2 (sottoinsieme shared) + board task eseguibile con modello muse (manuale o e2e esistente con override modello).

## 4. UI settings/picker + spec-flow

- `Settings/providersModel.ts` (PROVIDER_ORDER + set/kind + cardFact se subscription), `ModelSelector/useModelCatalog.ts` (ENGINE_ACTIONS/signIn se diversi), `ProviderDetail.tsx` (righe dedicate solo se knob propri).
- Scenario `spec-flow/muse-provider-picker.feature` + esecuzione con video.
- Barra: BAR-6 + BAR-2 (sottoinsieme client).

## 5. Terminale PTY + smoke live + chiusura

- `routes/terminal.ts` (ramo spawn muse) + migration CHECK `terminal_sessions.type` + `shared/terminal-session-types.ts`.
- `scripts/smoke-muse-provider.ts` (BAR-5); esecuzione manuale, output incollato nel report.
- Barra: BAR-4 + BAR-5; `git push` branch + PR; `/opsx:archive` dopo merge.

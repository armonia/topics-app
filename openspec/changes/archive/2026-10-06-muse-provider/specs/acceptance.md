# Acceptance: muse-provider

Barra eseguibile: ogni riga esce 0 a change completa. Cwd: `~/Projects/topics-app`, branch `topics/muse-provider`.

## BAR-1 — test nuovi verdi

```sh
bun test --timeout 30000 \
  server/providers/muse.test.ts \
  server/providers/muse/args.test.ts \
  server/providers/muse/models.test.ts \
  server/lib/muse-bin.test.ts \
  server/providers/muse-integration.test.ts
```

`muse-integration.test.ts` guida `MuseProvider` con un binario fake-muse (fixture che rigioca JSONL catturato, come `acp/fake-agent.fixture.ts`):
un turno con delta+tool+terminale arriva tutto a `StreamHandler`, resume riusa il sid, abort chiude, exit≠0 → `onError`.

## BAR-2 — regressioni delle aree toccate

```sh
bun test --timeout 30000 \
  server/providers/default-resolution.test.ts \
  server/providers/runtime-default-safety.test.ts \
  server/providers/topic-provider-resolver.test.ts \
  server/routes/chat.provider-selection.test.ts \
  server/context/provider-strategy.test.ts \
  server/db/terminal-session-types.test.ts \
  shared/task-coding-models.test.ts \
  shared/modelMaker.test.ts \
  client/src/components/Settings/providersModel.test.ts \
  client/src/components/Shared/ModelSelector/useModelCatalog.test.ts
```

## BAR-3 — typecheck + lint + gate repo

```sh
bun run typecheck && bun run lint && bun run check:comment-language && bun run check:test-skips
```

## BAR-4 — ciò che è verde resta verde

```sh
bun run test:unit
```

Esce 0 come su main (confronto contro `origin/main` se qualcosa è rosso: o fix o prova che era rosso anche lì).

## BAR-5 — smoke live (manuale, 1 turno meta reale)

```sh
bun run scripts/smoke-muse-provider.ts "rispondi con esattamente: dattero"
```

Lo script istanzia `MuseProvider`, manda un turno su topic effimera e asserisce: delta ricevuti, `onDone` con testo `dattero`,
sid persistito in `muse_sessions`, secondo turno sullo stesso sid senza rispedire history. Costa 2 chiamate meta. Non in CI.

## BAR-6 — UI (spec-flow + video)

Scenario `spec-flow/muse-provider-picker.feature`: Impostazioni→Provider mostra card Muse con stato; ModelSelector scope chat
elenca i modelli muse; scelta modello muse su topic → topic risponde. Video `.webm` dell'esecuzione in `videos/`.

## BAR-7 — mutazione sul punto critico

Rompere il mapping `run.output.delta`→`onTextDelta` (o `run_terminal`→`onDone`) in `muse.ts`: BAR-1 deve diventare rosso.
Comando di verifica documentato in `tasks.md` (traccia 1).

## Requisiti funzionali

- MUSE-01: con `muse` installato+loggato, il provider si registra e `connected=true`; senza binario o senza login, non si registra (nessuna voce morta nel picker).
- MUSE-02: un turno chat su provider muse streamma testo+tool e chiude con usage/durata; abort mid-turn chiude pulito.
- MUSE-03: il resume riusa il sid (`muse_sessions`); sid orfano (log muse sparito) → fallback fresh una volta + forget.
- MUSE-04: Impostazioni→Provider: card Muse (stato, program path, default model); ModelSelector: modelli muse in chat e task.
- MUSE-05: default automatico invariato (claude-code-first); `muse` eleggibile come default esplicito e per-topic.
- MUSE-06: pane terminale `muse` (PTY interattivo) funzionante come codex/kimi.

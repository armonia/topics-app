# Wire `muse exec --json` (catture meta reali, 2026-10-06)

Sorgente: `fixtures/meta-{tool,simple,fail}.*` (CLI 1.4.3, provider meta).
Echo sweep: `/tmp/muse-proto/PROTOCOL.md`. Busta stabile:
`payload_type` + `payload.kind`; `run_stream.id == command_id`.

## Turno con tool — `meta-tool.jsonl` (35 righe, exit 0)

| # | payload_type | mapping provider |
|---|---|---|
| 1 | `runtime.command.accepted` | ignorato |
| 2 | `session.run.linked` | ignorato |
| 3 | `run.model.configured` | modello effettivo (`model_id`) |
| 4 | `turn.input.user` | ignorato (eco del prompt) |
| 5 | `run.lifecycle.started` | ignorato |
| 6,15,24 | `task.stream.linked` | ignorato |
| 7,16,25 | `task.lifecycle.proposed` | se `task_kind` = `tool.<nome>` → registra task_id→nome |
| 8,17,26 | `task.lifecycle.accepted` | ignorato |
| 9,18,27 | `task.lifecycle.scheduled` | ignorato |
| 10,19,28 | `task.lifecycle.side_effect_intent` | `tool:<nome>` + `idempotency_key` = `tool:<call_id>` → lega task_id→call_id |
| 11,20,29 | `task.lifecycle.started` | se task tool → `onToolStart(task_id, nome)` |
| 12,13,30,33 | `task.lifecycle.status` | ignorato (fasi stream, solo diagnostica) |
| 21 | `task.lifecycle.output` | se task tool → accumula `chunk` + `onToolUpdate` |
| 14,22,34 | `task.lifecycle.completed` | se task tool → `onToolResult(task_id, accumulato, false)` |
| 23 | `tool.result` | se call aperta → `onToolResult(id, text, outcome≠success)`; se già chiusa → ignorato (arriva DOPO completed) |
| 31,32 | `run.output.delta` | `onTextDelta(text, cumulato)` (N delta da concatenare) |
| 35 | `run.terminal.completed` | `terminal` + `text` full + `reason` → chiude il turno |

## Turno semplice — `meta-simple.jsonl` (7 righe, exit 0)

Solo accepted/linked/configured/input/started + 1 delta + terminal.
Nessun evento `task.*`: il parser non deve richiederli.

## Fallimento — `meta-fail.jsonl` (0 byte, exit 2)

Stdout vuota, stderr = motivo + riga `usage:`. Stesso per tutti gli
errori CLI/usage. Il provider mappa exit≠0 → `onError` generico,
stderr solo in console (mai in UI: leak di path/token).

## Note

- Usage/token: NESSUN evento su stdout (grep `*usage*|*token*` vuoto su
  35 righe); il durable log ha solo rss/cpu. Il provider riporta durata,
  non usage. Fallimenti run (`run.terminal.failed/cancelled`, kinds in
  `$defs.TurnErrorKind`) non osservati dal vivo: mapping difensivo da
  schema — `failed`/`cancelled` → `onError(reason ?? generico)`.
- `task.lifecycle.failed` (visto su echo) su task tool → `onToolResult(id, reason, true)`; su altri task → ignorato.
- Modello `--model` inesistente: il server fa fallback al default e il
  turno riesce (exit 0) — nessun errore da mappare lì.
- Eventi ignoti → ignorati (forward-compat, come codex).

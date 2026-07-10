# Tasks — effort-tier-badge

Convenzione: `[ ]` da fare, `[x]` fatto+verificato.

> STATO: **implementata e verificata** (2026-07-11). tsc client+server verdi; unit
> resolver 8/8; e2e picker 3/3 (badge group-row + collapsed button); snapshot live
> verificato sul test server isolato (claude-code → `xhigh`; codex con HOME isolata
> → default `xhigh`, in prod legge il config utente).

## Phase 0 — Probe Codex CLI
- [x] 0.1 Confermato su codex-cli **0.144.0-alpha.4** (`/Applications/Codex.app/…/codex`):
  `-c model_reasoning_effort="<tier>"` è accettato e forwarded (probe con valore
  invalido → errore API `[reasoning.effort] invalid_enum_value`, quindi la chiave è
  giusta e arriva al modello). `-c` è flag GLOBALE: vale anche per il TUI e per
  `codex resume` (verificato in `resume --help`).
- [x] 0.2 Tier validi da enum API: `none/minimal/low/medium/high/xhigh`. In più
  **`ultra`** è accettato end-to-end sui modelli ChatGPT-bound correnti (turno
  completato con successo; è il valore che Codex stesso scrive nel config utente).
  Set riconosciuto: i 6 API + `ultra`. Default fissato: **`xhigh`** (massimo
  documentato API) — MA il valore del config.toml utente ha precedenza sul default
  (mai downgradare una scelta esplicita come `ultra`).
- [x] 0.3 Probe riuscito → Phase 2 eseguita. Nessun fallback necessario; il fallback
  D4 resta comunque implementato (resolver → null ⇒ nessun `-c`, nessun badge).

## Phase 1 — Server: resolve function
- [x] 1.1 `server/lib/topics-agent-prompt.ts` — `resolveCodexReasoningEffort()`:
  ordine `TOPICS_CODEX_REASONING_EFFORT` ("off"/"default" disabilita — NON "none",
  che è un tier reale) → `CODEX_REASONING_EFFORT` → `~/.codex/config.toml`
  (`model_reasoning_effort` root-level, lettura best-effort) → `"xhigh"`; valore
  non riconosciuto → null.
- [x] 1.2 `server/lib/topics-agent-prompt.test.ts` — 8 unit (override, disable,
  "none" come tier, mirror env, config wins, chiave in tabella ignorata, default,
  valore invalido → null). Verdi.

## Phase 2 — Server: wiring spawn
- [x] 2.1 `server/providers/codex.ts` `sendChat()` — `-c model_reasoning_effort=<tier>`
  dopo il blocco bridge MCP; null ⇒ nessun push.
- [x] 2.2 `server/routes/terminal.ts` — stessa iniezione nello spawn PTY codex
  (vale anche su `resume`, `-c` è globale).
- [x] 2.3 n/a (probe riuscito).

## Phase 3 — Server: esposizione snapshot
- [x] 3.1 `shared/types.ts` — `effortTier?: string` su `ProviderSnapshotEntry`.
- [x] 3.2 `snapshot-manager.ts` — helper `effortTierFor(name)` che chiama gli stessi
  resolver degli spawn path (badge = ciò che una NUOVA sessione otterrebbe davvero);
  popolato nell'entry di successo di `refreshOne()`.

## Phase 4 — Client: badge
- [x] 4.1 `ProviderModelPicker.tsx` — badge `data-testid="effort-tier-badge"` nel
  bottone collassato (tier del provider effettivo).
- [x] 4.2 Badge di gruppo `data-testid="effort-tier-<name>"` nel popover, PRIMA
  dello span `ml-auto` del pill "Default" (coesistono, nessuna sovrapposizione).
- [x] 4.3 `title` esplicativo su entrambi.

## Phase 5 — Verifica
- [x] 5.1 tsc client + typecheck server verdi (baseline 0).
- [x] 5.2 Snapshot live sul test server isolato: `claude-code ready effortTier=xhigh`.
- [x] 5.3 E2E `picker-keyboard-nav.spec.ts` — "CHAT-EFFORT-01: effort-tier badge
  visible in group row and collapsed button" (badge + pill Default coesistenti +
  badge nel bottone collassato). 3/3 verdi.

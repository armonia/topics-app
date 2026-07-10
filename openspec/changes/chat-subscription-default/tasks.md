# Tasks — chat-subscription-default

Convenzione: `[ ]` da fare, `[x]` fatto+verificato.

> STATO: **core completo e verificato LIVE.** Default provider onesto+subscription-first,
> chat on-by-default, modelli aggiornati, audit pulsanti (tutti cablati). Registry vivo:
> `default=claude-code`, `claude connected=False`. Smoke test reale: topic nuovo →
> risposta `PONG` in 4.7s via claude-code (subscription). 28 unit test verdi, tsc
> client+server verdi.

## Phase 0 — Default provider onesto (sblocca "la chat non risponde")
- [x] 0.1 `server/providers/claude.ts` — `get connected()` → `this.client !== null &&
  Boolean(this.config.apiKey)`.
- [x] 0.2 `server/providers/index.ts` — `recomputeDefault()` PROVIDER_PREFERENCE_ORDER →
  `["claude-code","codex","claude","openai","openclaw"]` (AI_PROVIDER + keep-current invariati).
- [x] 0.3 `server/providers/default-resolution.test.ts` (nuovo): claude keyless non-connected;
  default = claude-code; codex fallback; `AI_PROVIDER` override rispettato. 6 test verdi.
- [x] 0.4 Verifica registry live post-kickstart: `GET /api/providers` → `default=claude-code`,
  `claude connected=False`.

## Phase 1 — Chat on-by-default
- [x] 1.1 `client/src/lib/settings.ts` — `DEFAULT_SETTINGS.enableNewChat = true`.
- [x] 1.2 `client/src/components/Settings/GlobalSettings.tsx` — badge "Paid"→"Subscription",
  copy aggiornata (usa la subscription, nessun costo API). Toggle resta.
- [x] 1.3 Ripple gestito: split di un pane SOLITARIO ora spawna companion chat (onNewChat
  wired). Pinnato `enableNewChat:false` in H22 (`tests/e2e/layout-edge-cases.spec.ts`) che
  testa il fallback "silent solo". D11 (2 pane) non affetto. Nessun altro test dipende dal
  default-off senza settarlo.

## Phase 2 — Modelli aggiornati
- [x] 2.1 `claude-code.ts` `listModels()` + `DEFAULT_MODEL` → modelli correnti
  (`claude-opus-4-8`,`claude-sonnet-5`,`claude-haiku-4-5`,`claude-fable-5`).
- [x] 2.2 `fast-models.ts` `claude-code → claude-haiku-4-5` ancora coerente (verificato).
- [x] 2.3 Snapshot live mostra i nuovi modelli; `getFastModelFor` matcha haiku (test verde).

## Phase 3 — Audit pulsanti composer
- [x] 3.1 `ChatInput.tsx`: attach/plan/fast/context-ring/mic/overflow/send-queue-stop tutti
  cablati con label sensati. Nessun dead.
- [x] 3.2 `ProviderModelPicker.tsx`: filtra a provider `ready`, modelli correnti, reset/override ok.
- [x] 3.3 Slash-command: `/status /clear /reasoning /help /model /project /browser` handled
  client-side; `/agents /pause /resume /assign` handled SERVER-side (chat.ts vs
  agent_profiles). Tutte funzionali — nessuna morta.
- [x] 3.4 Nessuna correzione necessaria (niente morto/stantio oltre ai modelli, già fixati).

## Phase 4 — Verifica end-to-end
- [x] 4.1 Smoke test live reale (scratch): topic nuovo → `POST /api/chat` → risposta
  assistant corretta via claude-code (subscription), 4.7s, cleanup ok.
- [ ] 4.2 (opzionale) E2E Playwright positivo: "entry-point new-chat visibili di default"
  + "topic nuovo invia con mock provider". Il flusso reale è già provato live; questo sarebbe
  solo guard di regressione UI. Da valutare per non entangliare con la branch kanban.
- [x] 4.3 Typecheck client+server verdi; commit pathspec esplicito (no trailer).

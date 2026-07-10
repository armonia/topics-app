## Context

Verifica sul server vivo (`GET /api/providers`, `GET /api/providers/snapshot`):
- `claude` → `connected:true`, `isDefault:true`, ma `status:unavailable` (key assente).
- `claude-code` → `ready` (CLI `2.1.206`, sessione attiva). Subscription-backed.
- `codex` → `ready`.

Billing (luglio 2026): lo split che spostava `--print` su credito metered è **in pausa**;
`claude --print` con login subscription attinge dalla subscription. Quindi `claude-code` è
il path chat "gratis-in-subscription". `claude`/`openai` restano path metered (API key).

## Decisions

### D1 — `connected` onesto sul provider SDK (fix strutturale, non kludge)
`ClaudeProvider.get connected()` diventa `this.client !== null && Boolean(this.config.apiKey)`.
Motivo: `connected` è il segnale che `recomputeDefault()` usa per decidere il default e che
la UI usa per "ready". Un client Anthropic costruito con key vuota non è realmente usabile;
riportarlo connesso è la bugia che tiene il default su un provider morto. Non tocchiamo
`diagnose()` (già corretto: fa il probe e riporta `unavailable`).
Alternativa scartata: filtrare nel `recomputeDefault` con un check ad-hoc su apiKey → sposta
la conoscenza "cosa rende usabile claude" fuori dal provider. Meglio incapsularla nel provider.

### D2 — Ordine di preferenza subscription-first
`recomputeDefault()` PROVIDER_PREFERENCE_ORDER passa a
`["claude-code", "codex", "claude", "openai", "openclaw"]`. Con D1, un `claude` keyless è già
fuori dai giochi; l'ordine garantisce che, anche quando esistono più provider connessi, il
default automatico sia il path subscription (claude-code) invece del metered (claude/openai).
`AI_PROVIDER` esplicito e `topic.provider` per-topic hanno sempre la precedenza (invariato).
Rischio: un utente con una API key vera che si aspettava `claude` come default automatico
otterrà `claude-code`; mitigazione: entrambi sono Claude, la differenza è billing (subscription
< metered è un default migliore), e resta selezionabile dal picker. Documentato.

### D3 — `enableNewChat` default true
Cambio in `client/src/lib/settings.ts` (`DEFAULT_SETTINGS.enableNewChat = true`). Nessuna
migrazione: chi ha già salvato `false` lo mantiene (scelta esplicita rispettata); i nuovi/
default lo vedono `true`. Il badge "Paid" e il testo in `GlobalSettings.tsx` vengono
aggiornati (la creazione chat non è più a pagamento in senso metered). Non rimuoviamo il
gate come meccanismo — resta un interruttore, solo con default invertito e copy corretta —
così chi vuole disattivare le entry-point può ancora farlo.

### D4 — listModels claude-code aggiornata
Lista base → i modelli correnti della CLI. Manteniamo i **full name** (non gli alias
`opus`/`sonnet`) per coerenza con gli altri provider che elencano id completi e con il
guard di `fast-models`/snapshot che matcha su token (`haiku`, ecc.):
`["claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5", "claude-fable-5"]`
(il `config.model` configurato resta messo in testa dalla logica esistente, così `models[0]`
= default effettivo). `fast-models.ts` `claude-code → claude-haiku-4-5` resta valido.
Se in futuro la CLI cambia i nomi, questa è l'unica lista da toccare (documentato inline).

### D5 — Audit pulsanti (nessun cambio se già corretti)
Passata su `ChatInput`/`ProviderModelPicker`/slash-command: verificare handler cablati,
`title`/`aria-label` sensati, e che `/model` + lista picker riflettano lo snapshot reale.
Correzioni solo dove qualcosa è morto/stantio (es. slash-command che puntano a feature
rimosse). Non inventare pulsanti nuovi.

## Verifica
- Unit (`bun:test`) sui moduli puri: `recomputeDefault()` (ordine + demozione claude keyless),
  `getFastModelFor` invariato, `ClaudeProvider.connected`.
- E2E Playwright (server isolato :13334): con solo claude-code/codex ready, un topic nuovo
  invia e riceve una risposta (chat funziona senza toccare Settings); il picker mostra i
  modelli correnti; le entry-point di new-chat sono visibili di default.
- Verifica manuale sull'app viva: un turno chat via claude-code completa (billing subscription,
  costo accettato dal verdetto).

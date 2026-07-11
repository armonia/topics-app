## ADDED Requirements

### Requirement: CHAT-EFFORT-01 — Effort/reasoning tier visibile come badge

Il sistema SHALL esporre nella UI il tier di effort/reasoning che Topics forza per le
sessioni Claude Code e Codex, invece di applicarlo solo silenziosamente lato server.
`ProviderModelPicker` SHALL mostrare un badge di sola lettura con il tier risolto quando il
provider attivo ne ha uno, sia nel bottone collassato sia nella riga di gruppo del popover.

#### Scenario: badge mostrato per una sessione Claude Code
- **GIVEN** il provider `claude-code` è `ready` e il server risolve un effort tier (es.
  `xhigh`) per le sue sessioni
- **WHEN** l'utente apre il ProviderModelPicker
- **THEN** un badge col tier è visibile sia nel bottone collassato sia nella riga di gruppo
  `claude-code` del popover
- **AND** il badge non sostituisce né nasconde il pill "Default" quando entrambi sono
  presenti sulla stessa riga

#### Scenario: nessun badge quando il provider non ha un tier risolto
- **GIVEN** un provider (es. `openai`) per cui il server non risolve alcun effort tier
- **WHEN** l'utente apre il ProviderModelPicker
- **THEN** nessun badge di effort tier è mostrato per quella riga

### Requirement: CHAT-EFFORT-02 — Reasoning-effort forzato anche per Codex

Il sistema SHALL applicare alle sessioni Codex lanciate da Topics lo stesso approccio già
in uso per Claude Code: risolvere un reasoning-effort tier esplicito e passarlo allo spawn
del CLI, invece di ereditare silenziosamente il default di `~/.codex/config.toml`
dell'utente. Se il CLI Codex installato non supporta l'override, il sistema SHALL degradare
in modo silenzioso (nessun errore bloccante, nessun tier applicato) invece di far fallire
l'avvio della sessione.

#### Scenario: reasoning-effort forzato su una nuova sessione Codex
- **GIVEN** il Codex CLI installato supporta l'override del reasoning-effort
- **WHEN** Topics avvia una sessione Codex (via `sendChat()` o via terminale)
- **THEN** lo spawn include l'override esplicito del tier risolto, non il default implicito
  del CLI

#### Scenario: fallback silenzioso su CLI Codex senza supporto all'override
- **GIVEN** il Codex CLI installato non riconosce la chiave di override del
  reasoning-effort
- **WHEN** Topics avvia una sessione Codex
- **THEN** la sessione si avvia comunque, senza errore bloccante
- **AND** nessun badge di effort tier viene mostrato per quella sessione Codex nel
  ProviderModelPicker

# Linea di partenza misurata sul Mac

Le due misure che leggono il database vivo non possono girare nella VM cloud: il database ha
dati di persone vere e non esce dal Mac. Misurate il 07/10/2026 alle 22:42 su una copia presa
con `sqlite3 .backup` (296 MB), portata in `journal_mode=DELETE` e cestinata subito dopo.
Carico del Mac in quel momento: 13,6 (load average a 1 minuto).

## `measure:ui-state-init`

```text
righe ui_state:      486  (per-task: 381)
ui-state:init PRIMA: 314.1 KB
ui-state:init DOPO:  135.1 KB
risparmio:           179.0 KB  (57.0%)
```

Lo script toglie solo le chiavi `task-browser-tabs:` e `task-browser-layout:`. Il server ne
toglie di più (`UI_STATE_INIT_EXCLUDED_PREFIXES` in `server/routes/ui-state.ts`: anche
`topic-browser:` e i risultati delle sonde), quindi il frame che parte oggi a ogni
riconnessione pesa al massimo 135,1 KB.

## `measure:task-tabs`

```text
── di chi sono le righe `task-browser-*` ──
  done                 in board     381 righe / 143246 byte

PRIMA                  ui_state  486 righe /  273949 byte   ·   task-browser 381 righe / 143246 byte (52.3%)
DOPO il ripasso        ui_state  486 righe /  273949 byte   ·   task-browser 381 righe / 143246 byte (52.3%)
  → 0 chiave/i via, 0 byte, 0 task, 0 contesti da rilasciare
```

Tutte le 381 righe per-task appartengono a task in «done» non archiviati: il ripasso
`sweepArchivedTaskBrowserState` tocca solo gli archiviati, quindi oggi non ne libera nessuna.

## Non misurato

`probe:boot-memory` si misura solo su macOS (`vmmap`, `phys_footprint`) e non è stato lanciato:
il Mac era sotto carico e il numero non sarebbe stato confrontabile.

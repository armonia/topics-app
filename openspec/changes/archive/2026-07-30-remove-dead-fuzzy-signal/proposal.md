# Proposal — remove-dead-fuzzy-signal

## Why

Il classificatore di modello auto (`server/services/task-model-picker.ts`) chiedeva
all'LLM una seconda parola — la *chiarezza* `ok|fuzzy` — e la restituiva come flag
`fuzzy` in `PickModelResult`. Quel flag era **codice morto end-to-end**: l'unico
consumatore è il dispatcher (`pickAutoModel`), che dal deprecamento dell'auto-plan-first
legge **solo** `picked.model` e scarta `fuzzy` (`task-dispatcher.ts:400-401`, con la nota
esplicativa a `:409-412` — "plan-first è opt-in, l'auto-flip su task fuzzy è stato tolto
per richiesta"). La doc del dep (`task-dispatcher.ts:73-75`) era addirittura **fuorviante**:
diceva ancora *"which the dispatcher turns into auto plan-first"*, comportamento che non
esiste più.

Risultato: un campo calcolato e restituito ma ignorato, una doc che mente, un prompt del
classifier più grosso del necessario (due parole invece di una) e una batteria di test che
verificano un output inutilizzato. Il sistema deve dire la verità ed essere snello.

## What Changes

Rimozione pulita del segnale `fuzzy`, senza cambi di comportamento osservabile (il
classificatore sceglie gli stessi modelli di prima):

- `task-model-picker.ts`: prompt a **una sola parola** (il modello); via `parseFuzzy`,
  `PickModelResult` e la variante `pickTaskModelDetailed`. `pickTaskModel` diventa l'API
  primaria (ritorna l'id del modello, `fallback` su qualsiasi problema). `parseTier`
  tollera comunque una seconda parola residua (robustezza sull'output del giudice).
- `task-dispatcher.ts`: il dep `pickAutoModel` ritorna `{ model: string | null }`; doc
  corretta (niente più menzione di plan-first). La nota storica a `:409-412` resta: spiega
  perché un task vago NON forza il plan-first.
- `server.ts`: il wiring usa `pickTaskModel` (model-only), avvolto in `{ model }`.
- Test aggiornati: `task-model-picker.test.ts` (via i test `parseFuzzy`/`pickTaskModelDetailed`,
  la copertura dell'execution-floor spostata su `pickTaskModel`), `task-dispatcher.test.ts`
  (mock a `{ model }`; il test "un task vago non forza plan-first" resta, senza il campo).

## Non-Goals

- **Reintrodurre l'auto-plan-first**: resta opt-in per decisione (Attilio). Questa change
  non tocca quella scelta, la rende solo coerente nel codice.
- **Toccare la selezione del tier**: la logica opus-first + execution-floor
  (`floorTier`/`tierToAvailableModel`) è invariata.
- **Lo slicing del "ragionamento" nel drawer**: l'indagine ha stabilito che il thread
  curato (`task_comments`) e il transcript grezzo (`SessionSlice`) sono due store legittimi
  fusi a read-time, NON una sovrastruttura ridondante; lo slicing per timestamp è corretto
  sui dati attuali (ISO UTC su entrambi). Nessun cambio necessario.

## Impact

- `server/services/task-model-picker.ts`, `server/services/task-dispatcher.ts`, `server.ts`
  (+ i due file di test). Nessuna migration, nessun cambio client, nessun cambio di
  comportamento osservabile. **Nessuno spec delta**: non cambia nessun requisito — è un
  refactor che allinea il codice alla decisione già presa.

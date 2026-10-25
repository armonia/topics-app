# Acceptance: prezzo memoria delle card senza check

## Barra eseguibile

`OFFLOAD=local taskpolicy -b bun test server/services/task-dispatcher-admission.test.ts`

## Scenario comportamentale

- **GIVEN** swap pieno, 4,8 GB liberi e un agente vivo su una board con check che
  aspetta solo la CI remota
- **AND** la board candidata non configura `review_checks`
- **WHEN** il dispatcher valuta la card candidata
- **THEN** la card parte usando il prezzo minimo di 4 GB del solo agente
- **AND** con gli stessi campioni una board candidata con check resta trattenuta
  dal pavimento di 6 GB con il motivo attuale

Il test è in `server/services/task-dispatcher-admission.test.ts` e dichiara
`@covers KANBAN-75`. Non cambia UI; la prova comportamentale è il test del
dispatcher richiesto.

## Mutazione

Sostituendo il prezzo della card senza check con `agentMemPrice()`, lo stesso
comando deve fallire sul numero di card partite: nessuna card candidata parte.

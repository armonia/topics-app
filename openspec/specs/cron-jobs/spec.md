# cron-jobs Specification

## Purpose
TBD - created by archiving change complete-spec-coverage. Update Purpose after archive.
## Requirements
### Requirement: CRON-01 — Job Management

The Jarvis jobs SHALL be managed from «Automazioni» (HUBBR-14), the hub's view that took the place of the Cron panel: the sidebar panel and its pane type are withdrawn, so the same jobs are not in two places. The Jarvis rows of that view SHALL be the jobs `jarvis-channels` lists through `GET /api/cron/jobs`, joined to the hub's cards by their id (`cron:<id>`), including the jobs switched off, which the hub leaves out of its model. Each SHALL carry «Esegui ora» (`POST /api/cron/jobs/:id/run`), a switch that turns it on and off (`PATCH /api/cron/jobs/:id` with `{ enabled }`) and «Elimina» after a confirmation (`DELETE /api/cron/jobs/:id`), after which the list SHALL be read again from `jarvis-channels`. When the list does not come (the scheduler does not answer) the commands SHALL be off and the view SHALL say so.

#### Scenario: The jobs and their commands in Automazioni
- **GIVEN** `jarvis-channels` lists two jobs on and one off
- **WHEN** «Automazioni» opens
- **THEN** the Jarvis section SHALL list the three, the switched-off one marked off, each with run, switch and delete

#### Scenario: Deleted after the confirmation
- **GIVEN** a job in the Jarvis section
- **WHEN** «Elimina» is pressed and confirmed
- **THEN** the server SHALL receive `DELETE /api/cron/jobs/:id` and the row SHALL leave the list read again

### Requirement: CRONUI-01 — I tre comandi di riga rispondono sullo schermo

Accendere, eseguire e cancellare un job finivano tutti e tre in un
`console.error`: su un rifiuto l'icona restava dov'era, la riga non si muoveva,
e l'unica traccia era in una console che nessuno ha aperta. Chi ha premuto non
poteva distinguere «è andata» da «il server ha detto di no», e le due mosse
successive sono opposte.

Un comando rifiutato SHALL lasciare in «Automazioni» una banda d'errore
visibile, in italiano, che dice quale comando non è passato e perché (il
pianificatore non risponde, non ha avviato il giro, l'ha rifiutato).

#### Scenario: la rotta di esecuzione rifiuta
- **GIVEN** un job in elenco e la rotta `run` che risponde con un errore
- **WHEN** si preme «Esegui ora»
- **THEN** SHALL comparire la banda d'errore della vista

### Requirement: CRONUI-01b — Un'esecuzione riuscita lascia un segno sulla riga

Un Play riuscito e un Play rifiutato lasciavano la stessa riga identica. È
l'altra metà di CRONUI-01: senza un segno per il successo, l'assenza di segno
non può significare fallimento.

La riga di un job eseguito SHALL dire che è stato eseguito, e SHALL dirlo subito
dopo il gesto e non al giro di aggiornamento successivo.

#### Scenario: l'esecuzione riesce
- **GIVEN** un job e la rotta `run` che accetta
- **WHEN** si preme «Esegui ora»
- **THEN** la riga SHALL mostrare che il job è stato eseguito

### Requirement: CRONRPC-01 — Il server parla con lo scheduler di Jarvis dalla CLI di jarvis-channels

I lavori programmati di Jarvis li tiene `jarvis-channels` (dal 03/11/2026): il
vecchio gateway è spento e la sua RPC `cron.list` non ha un equivalente, così il
pannello restava vuoto con l'errore.

Le rotte `/api/cron/jobs` SHALL passare dalla CLI `jarvis-channels cron`
(`list --json --all`, `enable|disable --id`, `run --id --json`, `rm --id`),
senza alcun token né URL di gateway. Un rifiuto SHALL arrivare al pannello con
la frase della CLI: 400 per un job che non c'è, 502 per una CLI assente,
scaduta o con un'uscita che non è un elenco, 409 per un'esecuzione che la CLI
non conferma (`ok` diverso da `true`). Un id vuoto SHALL NOT arrivare alla CLI,
dove «» è il prefisso di ogni job.

L'elenco SHALL comprendere i job spenti (`--all`) e SHALL arrivare al pannello
con `nextRunAt`/`lastRunAt` in ISO, ricavati da `state.nextRunAtMs` e
`state.lastRunAtMs`; la pianificazione `at` resta in ISO, com'è.

#### Scenario: l'elenco arriva dalla CLI
- **GIVEN** `jarvis-channels` con dei job, anche disattivati
- **WHEN** il pannello chiede GET /api/cron/jobs
- **THEN** il server SHALL chiamare `jarvis-channels cron list --json --all`
- **AND** SHALL rispondere 200 con i job nella forma del pannello

#### Scenario: la CLI non conferma l'esecuzione
- **GIVEN** un job
- **WHEN** si preme «Esegui adesso» e la CLI risponde con `ok` diverso da `true`
- **THEN** la risposta SHALL essere 409 con il motivo, e la riga SHALL NOT risultare eseguita

#### Scenario: «Esegui adesso» parte subito
- **GIVEN** un job che non è in scadenza
- **WHEN** si preme «Esegui adesso»
- **THEN** il server SHALL chiamare `jarvis-channels cron run --id <id> --json`, che lo avvia dovuto o no

#### Scenario: un id sconosciuto
- **GIVEN** un job cancellato altrove
- **WHEN** il pannello lo accende o lo spegne
- **THEN** la risposta SHALL essere 400 con la frase della CLI

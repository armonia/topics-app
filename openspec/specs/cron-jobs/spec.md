# cron-jobs Specification

## Purpose
TBD - created by archiving change complete-spec-coverage. Update Purpose after archive.
## Requirements
### Requirement: CRON-01 — Job Management

The OpenClaw jobs SHALL be managed from «Automazioni» (HUBBR-14), the hub's view that took the place of the Cron panel: the sidebar panel and its pane type are withdrawn, so the same jobs are not in two places. The Jarvis rows of that view SHALL be the jobs the gateway lists through `GET /api/cron/jobs`, joined to the hub's cards by their id (`cron:<id>`), including the jobs switched off, which the hub leaves out of its model. Each SHALL carry «Esegui ora» (`POST /api/cron/jobs/:id/run`), a switch that turns it on and off (`PATCH /api/cron/jobs/:id` with `{ enabled }`) and «Elimina» after a confirmation (`DELETE /api/cron/jobs/:id`), after which the list SHALL be read again from the gateway. When the list does not come (the gateway is down) the commands SHALL be off and the view SHALL say so.

#### Scenario: The jobs and their commands in Automazioni
- **GIVEN** the gateway lists two jobs on and one off
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
gateway non risponde, non ha avviato il giro, l'ha rifiutato).

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

### Requirement: CRONRPC-01 — Il server parla con lo scheduler di OpenClaw dalle RPC del gateway

Dalla 2026.10.5 OpenClaw nega lo strumento dello scheduler su `POST /tools/invoke`
(`automations` sta nella lista HTTP vietata di default, e `cron` ne è l'alias):
ogni chiamata del pannello rispondeva 404 «Tool not available: automations» e il
pannello restava vuoto con l'errore. Le stesse operazioni esistono come RPC del
gateway (`cron.list`, `cron.update`, `cron.run`, `cron.remove`), quelle che usa
la CLI di OpenClaw.

Le rotte `/api/cron/jobs` SHALL passare dalle RPC del gateway tramite
`openclaw gateway call`, senza mettere il token del gateway né in argv né
nell'ambiente del processo figlio, e con `--expect-url` ricavato da
`GATEWAY_URL`: se la CLI punta a un altro gateway la chiamata SHALL fallire,
non agire su quello sbagliato. Un rifiuto del gateway SHALL arrivare al
pannello con la frase del gateway: 400 per una richiesta non valida, 502 per un
gateway irraggiungibile o diverso, 409 per un'esecuzione che il gateway non ha
avviato (`ran: false`).

L'elenco SHALL usare la vista `compact`, l'unica con `nextRunAt`/`lastRunAt` in
ISO che il pannello legge, e il pannello SHALL leggere la pianificazione `at`
nella forma del gateway (`at` in ISO, non `atMs`).

#### Scenario: l'elenco arriva dalla RPC
- **GIVEN** un gateway con dei job, anche disattivati
- **WHEN** il pannello chiede GET /api/cron/jobs
- **THEN** il server SHALL chiamare `cron.list` con `includeDisabled: true` e `compact: true`
- **AND** SHALL rispondere 200 con i job della risposta

#### Scenario: il gateway non avvia l'esecuzione
- **GIVEN** un job la cui esecuzione precedente è ancora in corso
- **WHEN** si preme «Esegui adesso» e il gateway risponde `ran: false`
- **THEN** la risposta SHALL essere 409 con il motivo del gateway, e la riga SHALL NOT risultare eseguita

#### Scenario: «Esegui adesso» forza l'esecuzione
- **GIVEN** un job che non è in scadenza
- **WHEN** si preme «Esegui adesso»
- **THEN** il server SHALL chiamare `cron.run` con `mode: "force"`, come `openclaw cron run`

#### Scenario: il gateway rifiuta un id sconosciuto
- **GIVEN** un job cancellato altrove
- **WHEN** il pannello lo accende o lo spegne
- **THEN** la risposta SHALL essere 400 con la frase del gateway

# system-status Specification

## Purpose
TBD - created by archiving change complete-spec-coverage. Update Purpose after archive.
## Requirements
### Requirement: SYSTEM-01 — Health Monitoring

The system SHALL provide a system status panel in the sidebar that displays gateway connectivity status with latency, server uptime, memory usage with heap details, cron job counts, active WebSocket and stream connections, topic counts, periodic auto-refresh, and a server restart capability with double-click confirmation.

#### Scenario: System status panel displays gateway online status
- **GIVEN** the system status panel is visible in the sidebar
- **WHEN** the gateway health check returns status "online"
- **THEN** a green status dot SHALL appear next to the "Gateway" label
- **AND** the value SHALL display "Online" with the latency in milliseconds

#### Scenario: Gateway timeout status displays with warning color
- **GIVEN** the system status panel is polling for status
- **WHEN** the gateway health check returns status "timeout"
- **THEN** a yellow status dot SHALL appear next to the "Gateway" label
- **AND** the value SHALL display "Timeout"

#### Scenario: Gateway connection refused status displays with error color
- **GIVEN** the system status panel is polling for status
- **WHEN** the gateway health check returns status "connection_refused"
- **THEN** a red status dot SHALL appear next to the "Gateway" label
- **AND** the value SHALL display "Refused"

#### Scenario: Gateway server error status displays correctly
- **GIVEN** the system status panel is polling for status
- **WHEN** the gateway health check returns status "server_error"
- **THEN** a red status dot SHALL appear next to the "Gateway" label
- **AND** the value SHALL display "Server Error"

#### Scenario: Gateway auth error status displays correctly
- **GIVEN** the system status panel is polling for status
- **WHEN** the gateway health check returns status "auth_error"
- **THEN** a red status dot SHALL appear next to the "Gateway" label
- **AND** the value SHALL display "Auth Error"

#### Scenario: Server uptime displays in human-readable format
- **GIVEN** the system status panel has received status data
- **WHEN** the server reports its uptimeMs value
- **THEN** the "Server" row SHALL display the uptime formatted as seconds, minutes, hours, or days (e.g., "2h 15m", "3d 4h")
- **AND** a green status dot SHALL appear next to the Server label

#### Scenario: Memory usage displays with heap details
- **GIVEN** the system status panel has received status data
- **WHEN** the server reports memoryMB, heapUsedMB, and heapTotalMB values
- **THEN** the "Memory" row SHALL display total memory (e.g., "128 MB")
- **AND** the detail text SHALL show heap breakdown (e.g., "heap: 64/128 MB")

#### Scenario: Memory row shows warning when usage exceeds 512 MB
- **GIVEN** the system status panel has received status data
- **WHEN** the server memoryMB exceeds 512
- **THEN** the Memory row status dot SHALL be yellow instead of green

#### Scenario: Cron jobs count displays enabled out of total
- **GIVEN** the system status panel has received status data
- **WHEN** the server reports cronJobs.enabled and cronJobs.total counts
- **THEN** the "Cron Jobs" row SHALL display "N/M" (enabled/total)
- **AND** if a nextRun timestamp exists, it SHALL be shown as a relative time

#### Scenario: Cron jobs row shows warning when no jobs exist
- **GIVEN** the system status panel has received status data
- **WHEN** the cronJobs.total is 0
- **THEN** the Cron Jobs row status dot SHALL be yellow

#### Scenario: Connection metrics display WebSocket clients, streams, and topics
- **GIVEN** the system status panel has received status data
- **WHEN** the connections section renders
- **THEN** the panel SHALL display the number of WebSocket clients (WS), active streams (Streams), and active topics (Topics)
- **AND** the Streams count SHALL be highlighted in primary color when greater than 0

#### Scenario: Panel auto-refreshes every 30 seconds
- **GIVEN** the system status panel is mounted and enabled
- **WHEN** 30 seconds elapse since the last status fetch
- **THEN** the system SHALL automatically poll for updated status data

#### Scenario: User manually refreshes system status
- **GIVEN** the system status panel is visible
- **WHEN** the user clicks the Refresh button
- **THEN** the system SHALL fetch the latest status immediately
- **AND** the button SHALL display the time since last check (e.g., "5s ago", "2m ago")

#### Scenario: User initiates server restart with first click
- **GIVEN** the system status panel is visible
- **WHEN** the user clicks the Restart button for the first time
- **THEN** the button SHALL change to a confirmation state displaying "Sei sicuro?" in red
- **AND** the confirmation state SHALL auto-dismiss after 3 seconds if not confirmed

#### Scenario: User confirms server restart with second click
- **GIVEN** the Restart button is in the confirmation state
- **WHEN** the user clicks the button a second time within 3 seconds
- **THEN** the system SHALL call the restart API
- **AND** the button SHALL display a spinning icon with "Riavvio..." text
- **AND** the status SHALL refresh after 3 seconds

#### Scenario: Restart confirmation auto-dismisses after timeout
- **GIVEN** the Restart button is in the confirmation state
- **WHEN** 3 seconds elapse without a second click
- **THEN** the button SHALL revert to its normal "Riavvia" state

#### Scenario: Error state displays when status fetch fails with no cached data
- **GIVEN** the system status panel has no previously cached status
- **WHEN** the status fetch request fails
- **THEN** the panel SHALL display an error message in red text

#### Scenario: Panel does not fetch when disabled
- **GIVEN** the system status panel is rendered with enabled prop set to false
- **WHEN** the component mounts
- **THEN** the system SHALL NOT poll for system status
- **AND** the auto-refresh interval SHALL NOT be started

#### Scenario: Gateway latency displays in human-readable format
- **GIVEN** the gateway is online
- **WHEN** the latency is reported
- **THEN** latency below 1ms SHALL display as "<1ms"
- **AND** latency at or above 1ms SHALL display as the rounded value with "ms" suffix


### Requirement: SYSTEM-LOG-01 — Ogni esito di uno stream ha la sua riga, e il registro non cresce per sempre

Il registro di attività SHALL scrivere una riga per ogni esito di uno stream, e
gli esiti SHALL restare DISTINTI con la propria gravità: una scadenza morbida è
un avviso, una scadenza dura e un errore sono errori, un completamento, un
annullamento e un recupero sono informazioni. Collassarli rende il registro
inutile proprio quando serve — cioè quando si cerca perché un turno è finito
come è finito.

Un completamento SHALL portare con sé il CONSUMO, e un errore il proprio
DETTAGLIO: una riga che dice solo «errore» costringe a cercare altrove ciò che
si sapeva al momento in cui è stata scritta.

I campi opzionali assenti SHALL cadere su valori puliti, senza righe a metà.

La tabella SHALL essere LIMITATA a un tetto di righe: un registro che cresce per
sempre è la stessa perdita di memoria di quello che nessuno cancella, solo più
lenta.

#### Scenario: una scadenza morbida e una dura
- **GIVEN** i due esiti
- **THEN** SHALL essere scritti con gravità diverse

#### Scenario: oltre il tetto
- **GIVEN** più righe del tetto
- **THEN** la tabella SHALL restare al tetto

### Requirement: HTTP-LOG-01 — An API request leaves one log line, on completion, with time, status and duration

The server log SHALL write ONE line per API request, when the response is
known and not at request start, carrying an ISO timestamp, the method, the
path, the status and the duration in milliseconds. A 4xx and a 5xx SHALL be
told apart at a glance from a 2xx by their mark.

The routes a client hits on a clock rather than on a user (the viewer count
of a browser context, the presence beat, the Claude hooks) SHALL stay quiet
while they succeed fast, and SHALL still print when they fail (status 400 or
more) or drag (duration over `SLOW_MS`); exactly `SLOW_MS` is not over. They
SHALL NOT be sampled: a 2xx logged one time in ten would look like a request
that happened one time in ten. Every other API route SHALL always write its
line, even a 200 in 1ms.

> **Why.** The log had a START line per request (no time, no outcome, no
> duration) and a completion line for 404s only; 44% of those lines were the
> 2s viewer poll (7,662 of 17,335 on a 20,000-line tail), and they buried the
> lines that matter.

#### Scenario: a normal route
- **GIVEN** `GET /api/topics` answered 200 in 12ms
- **THEN** one line is written, on completion, with the ISO time and `GET /api/topics 200 12ms`

#### Scenario: a route on a clock
- **GIVEN** `GET /api/browsers/:id/viewers` answered 200 in 5ms
- **THEN** no line is written
- **AND** the same route answering 404, or taking longer than `SLOW_MS`, writes its line

### Requirement: SYSTEM-02 — Un riavvio fallito si vede, e un riavvio riuscito spegne l'allarme

La rotta di riavvio del gateway risponde HTTP 200 con `ok: false` e il codice di
uscita quando il comando esce non-zero: il trasporto ha funzionato, il riavvio
no. Il client SHALL leggere l'ESITO NELLA BUSTA e NON SHALL fidarsi del solo
codice di stato — altrimenti il fallimento PIÙ COMUNE finisce nel ramo del
successo in silenzio, e il pulsante torna da «Riavvio…» a «Riavvia» come se
fosse andato bene.

Un fallimento SHALL portare il motivo dato dal server; se il server non ne dà
uno, SHALL portare almeno il codice di uscita. Un server irraggiungibile, un 404
(provider non openclaw), un 500 e un 401 SHALL finire nello stesso ramo di
fallimento.

Ogni NUOVO tentativo SHALL partire dal silenzio: la banda d'errore SHALL essere
azzerata all'inizio del tentativo, così un secondo riavvio riuscito la SPEGNE.
Lo smontaggio del pannello NON SHALL essere l'unico modo di azzerarla — il
pannello non si chiude quando ci si clicca dentro, quindi la banda rossa restava
accanto a un Gateway tornato verde.

#### Scenario: uscita non-zero con HTTP 200
- **GIVEN** una risposta `{ ok: false, exitCode: 1 }` con stato 200
- **THEN** SHALL essere mostrato un fallimento, e NESSUN aggiornamento SHALL essere programmato

#### Scenario: secondo tentativo riuscito
- **GIVEN** un fallimento già mostrato
- **WHEN** un nuovo tentativo riesce
- **THEN** la banda d'errore SHALL essere spenta

### Requirement: SYSTEM-03 — Le sonde restituiscono codici, la vista segue la lingua scelta

`GET /api/system/health` SHALL restituire stato, codice del motivo e parametri. Il server e
`shared/` NON SHALL comporre frasi visibili alla persona. Il pannello e `/health` SHALL
comporre nome, motivo e azione dal catalogo della lingua scelta; il messaggio grezzo
dell'errore SHALL restare intatto come dato. La rotta SHALL esporre server, bridge PTY,
ai-bridge, motori browser, relay, watcher, CLI Claude e database. Le sonde SHALL essere
economiche, isolate entro un tetto di tempo e senza avviare modelli o processi.

Il controllo del login Claude SHALL cercare prima gli attributi della voce `Claude
Code-credentials` nel Portachiavi senza richiederne il segreto, poi il file credenziali.
Il risultato SHALL essere memorizzato per 10 minuti e aggiornato fuori dalla richiesta.
Una CLI assente SHALL risultare `off`; un login assente SHALL risultare `error`.

La sonda dei motori browser SHALL riportare l'ultimo avvio fallito con messaggio e ora.
Se nessun motore è stato avviato, SHALL risultare `off`. I timeout SHALL essere distinti
per tipo d'errore, senza confrontare il testo del messaggio. Gli errori del watcher SHALL
restare associati al progetto che li ha causati.

#### Scenario: le viste mostrano lo stesso roster
- **GIVEN** `/api/system/health` restituisce tutti i sottosistemi
- **WHEN** il pannello laterale o `/health` mostra la lista
- **THEN** entrambi mostrano lo stesso roster con stato, motivo e azione

#### Scenario: una sonda scade mentre le altre terminano
- **GIVEN** una sonda supera il proprio limite
- **WHEN** le altre sonde completano
- **THEN** la voce ha `state: warn` e `reason: timeout`
- **AND** le altre voci vengono comunque restituite

#### Scenario: sottosistema non configurato
- **GIVEN** un sottosistema non è configurato
- **WHEN** la rotta di health risponde
- **THEN** la voce ha `state: off` con motivo traducibile

#### Scenario: l'inglese è selezionato
- **GIVEN** la health contiene un errore con un codice e un messaggio grezzo
- **WHEN** il pannello o `/health` lo mostra in inglese
- **THEN** nomi, osservazioni e azioni sono in inglese
- **AND** il messaggio grezzo conserva il testo originale

#### Scenario: il login Claude è nel Portachiavi
- **GIVEN** la voce `Claude Code-credentials` esiste
- **WHEN** la health viene letta due volte entro 10 minuti
- **THEN** entrambe le letture riportano `ok` con fonte Portachiavi
- **AND** `security` viene chiamato una volta senza chiedere il segreto

#### Scenario: un motore browser fallisce all'avvio
- **GIVEN** l'avvio del motore fallisce con un errore grezzo
- **WHEN** la health viene letta
- **THEN** la voce riporta `error`, il messaggio e l'ora dell'avvio

#### Scenario: un progetto watcher fallisce e un altro riparte
- **GIVEN** il watcher del progetto A è in errore
- **WHEN** il watcher del progetto B parte correttamente
- **THEN** la health conserva l'errore di A e nomina il suo percorso

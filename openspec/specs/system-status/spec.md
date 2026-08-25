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

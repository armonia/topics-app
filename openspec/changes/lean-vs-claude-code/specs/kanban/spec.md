# Delta: kanban (lean-vs-claude-code)

## ADDED Requirements

### Requirement: KANBAN-98 - Il feed globale si rivalida invece di riscaricarsi

Il feed globale (`GET /api/all-boards/tasks`) SHALL portare un ETag calcolato sul
corpo, e una richiesta che rimanda lo stesso valore in `If-None-Match` SHALL
ricevere un 304 senza corpo. La risposta SHALL restare `no-store` e SHALL esporre
l'ETag a CORS: l'app desktop legge da `tauri://localhost`, e per il suo fetch un
header non esposto vale `null`.

Il client SHALL rimandare l'ETag a ogni rilettura del feed intero, e su 304 SHALL
riusare le righe dell'ultimo 200, lo stesso array, così il confronto dello store si
ferma alla prima identità. Le letture d'avvio SHALL salvare l'ETag senza mandarlo:
passano dal coalescer dell'app, che condivide una richiesta fra più chiamanti, e un
304 non deve rispondere a un ETag che il chiamante non teneva. Una lettura fallita SHALL
restare un errore, e quella dopo SHALL rivalidare ancora. Le letture filtrate
(`?status=`) NON SHALL rivalidare.

PERCHÉ: l'app desktop ha riletto questo feed ogni 5 s per giorni senza una card in
movimento, 720 letture all'ora da ~155 KB (log del server, 13-14/10).

#### Scenario: board ferma
- GIVEN la board globale aperta, nessuna card che cambia
- WHEN un evento chiede una rilettura
- THEN la richiesta porta l'ETag dell'ultimo 200 e torna 304

#### Scenario: card nuova dopo un 304
- GIVEN un 304 appena ricevuto
- WHEN un task nasce sul server
- THEN la lettura torna 200 con un ETag nuovo, e la card compare e resta

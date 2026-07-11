## ADDED Requirements

### Requirement: CHAT-CONV-01 — Regenerate generale come branch fratello

Il sistema SHALL permettere di rigenerare qualunque risposta assistant (non solo
gli errori ⚠️) creando un branch fratello sotto lo stesso messaggio utente,
senza distruggere la risposta precedente; il prompt inviato al provider SHALL
troncarsi al messaggio utente anchor.

#### Scenario: rigenerazione di una risposta
- **GIVEN** un thread user→assistant completato
- **WHEN** l'utente clicca Regenerate sulla risposta
- **THEN** nasce un branch assistant fratello che streama la nuova risposta
- **AND** la risposta precedente resta raggiungibile con le frecce di branch (1/2)

#### Scenario: regenerate bloccato durante lo streaming
- **GIVEN** una sessione con un turno in streaming
- **WHEN** l'utente guarda la toolbar di un messaggio assistant
- **THEN** l'azione Regenerate non è offerta

### Requirement: CHAT-CONV-02 — Cancellazione messaggio con sottoalbero

Il sistema SHALL permettere di cancellare un messaggio; la cancellazione rimuove
anche tutti i discendenti, rinumera i fratelli superstiti densamente e ripara il
puntatore di branch attivo. La UI SHALL richiedere una conferma (two-click).

#### Scenario: delete con conferma
- **GIVEN** un messaggio nel thread
- **WHEN** l'utente clicca Delete e poi conferma ("Delete?")
- **THEN** il messaggio e i suoi discendenti spariscono dal thread
- **AND** la rimozione persiste dopo un reload (verità server)

### Requirement: CHAT-CONV-03 — Export della conversazione

Il sistema SHALL esportare il thread attivo come file Markdown scaricabile dal
menu ⋯ del composer (ruoli, timestamp e contenuti inclusi).

#### Scenario: export markdown
- **GIVEN** un topic con messaggi
- **WHEN** l'utente sceglie "Export conversation"
- **THEN** viene scaricato un file `.md` che contiene tutti i messaggi del thread attivo

### Requirement: CHAT-CONV-04 — La ricerca ⌘K trova i messaggi delle chat correnti

`searchTranscripts` SHALL interrogare la tabella SQLite `messages` (lo store in
cui la chat scrive), risolvendo il topic via session_key; i termini con
metacaratteri LIKE SHALL matchare letteralmente.

#### Scenario: messaggio fresco trovato
- **GIVEN** un topic con un messaggio appena scritto contenente "xylophone"
- **WHEN** l'utente cerca "xylophone" nella palette
- **THEN** il risultato appare nella sezione Messaggi con nome e icona del topic

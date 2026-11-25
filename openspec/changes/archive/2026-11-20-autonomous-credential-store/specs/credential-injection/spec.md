## ADDED Requirements

### Requirement: INJECT-01 — Placeholder `{{cred:dominio/campo}}` risolto a type-time

I browser tool esistenti (`browser_act` e affini) SHALL accettare, al posto di un valore
sensibile, un **placeholder** nella forma `{{cred:dominio/campo}}`. L'LLM SHALL vedere e
produrre **solo** il placeholder. La risoluzione al valore reale SHALL avvenire
**a type-time**, nel processo che digita nella pagina, subito prima dell'inserimento —
mai prima. Il valore risolto **NON** SHALL entrare nel prompt/context del modello, negli
argomenti del tool loggati, né essere ritornato al chiamante.

#### Scenario: il modello non vede mai il valore
- **GIVEN** un tool `browser_act` che deve digitare la password in un form
- **WHEN** l'agente passa `{{cred:example.com/password}}` come testo
- **THEN** la pagina riceve il valore reale digitato, ma il transcript del modello, gli
  argomenti del tool e la risposta contengono **solo** il placeholder

#### Scenario: placeholder per un dominio fuori allowlist
- **GIVEN** un placeholder che referenzia un dominio **non** in allowlist (vedi AUTH-05)
- **WHEN** il tool tenta la risoluzione
- **THEN** la risoluzione è rifiutata, nulla viene digitato, e l'agente riceve un errore
  che richiede autorizzazione umana

### Requirement: INJECT-03 — Origin binding: il segreto si digita solo sul suo dominio

Il resolver SHALL verificare, **al momento della risoluzione**, che il dominio della
credenziale corrisponda all'**origin del frame in cui si sta effettivamente digitando**
(confronto su eTLD+1, non su sottostringa). Se l'origin attivo differisce — per redirect,
navigazione intermedia, o perché il campo vive in un **iframe cross-origin** — la
risoluzione SHALL essere rifiutata e nulla SHALL essere digitato. L'allowlist (AUTH-05)
autorizza il *dominio*; l'origin binding garantisce che il segreto finisca **su quel
dominio e non altrove**: sono controlli distinti e SHALL essere entrambi applicati.

Motivazione: senza questo vincolo un redirect verso un dominio ostile, o un iframe di
terza parte dentro una pagina lecita, riceverebbe la password — è la difesa che i
password manager applicano di default e che l'allowlist da sola non fornisce.

#### Scenario: redirect verso un dominio diverso durante il login
- **GIVEN** un placeholder `{{cred:example.com/password}}`
- **WHEN** al momento della digitazione la pagina attiva è su `evil.test` (per redirect o
  navigazione intermedia)
- **THEN** la risoluzione è rifiutata, nulla viene digitato, e l'evento è registrato
  nell'audit log come tentativo bloccato

#### Scenario: campo dentro un iframe cross-origin
- **GIVEN** un form di login il cui campo password vive in un iframe di origin diverso da
  quello della pagina principale
- **WHEN** il resolver tenta di risolvere un placeholder per il dominio della pagina
  principale
- **THEN** la risoluzione è rifiutata e l'agente riceve un errore che richiede
  autorizzazione umana

#### Scenario: sottodominio legittimo dello stesso sito
- **GIVEN** un placeholder `{{cred:example.com/password}}`
- **WHEN** la digitazione avviene su `accounts.example.com` (stesso eTLD+1)
- **THEN** la risoluzione procede normalmente

### Requirement: INJECT-02 — Redaction hard nei log

Qualunque log (server, sidecar, tool trace, error report) SHALL sottoporre a **redaction**
i valori risolti da placeholder: se un valore di credenziale comparisse in una stringa da
loggare, SHALL essere sostituito con un marcatore (es. `***`) **prima** della scrittura.
La redaction SHALL applicarsi anche ai messaggi di errore e agli screenshot/HTML dump
prodotti dai browser tool.

#### Scenario: il valore non finisce nei log
- **GIVEN** un login andato a buon fine con injection
- **WHEN** si ispezionano i log del server e dei sidecar e i dump del tool per quella sessione
- **THEN** nessuna occorrenza del valore reale è presente; compaiono solo placeholder o `***`

#### Scenario: redaction su errore
- **GIVEN** un tool che fallisce mentre gestisce un valore risolto
- **WHEN** l'errore viene loggato
- **THEN** il messaggio d'errore non contiene il valore in chiaro

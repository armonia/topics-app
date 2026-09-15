# Delta: quality-gates (mac-usabile-sotto-carico)

## MODIFIED Requirements

### Requirement: GATE-11 — Il cancello che sceglie le spec e2e di una modifica ha il suo cancello

Far girare la suite e2e intera a ogni cambiamento costa troppo; farne girare
troppo poche significa essere verdi mentre la prova che misurava quel
cambiamento non e' mai partita. La selezione automatica delle spec SHALL quindi
essere provata come si prova il prodotto, perche' sbaglia in DUE modi opposti e
tutti e due si sono verificati mentre veniva scritta.

Selezionare TROPPO SHALL essere un guasto: la prima versione legava 5 file
modificati a 75 spec agganciandosi a frammenti di parola come «famil», e un
cancello che riaccende l'intera suite viene spento dal primo che ha fretta.

Selezionare le spec SBAGLIATE SHALL essere un guasto: la seconda versione
metteva otto spec di altre funzioni davanti a quella che era davvero diventata
rossa.

Il legame SHALL passare dagli identificativi dei test dichiarati nel codice,
letti in tutte le forme in cui si scrivono, e l'ordine SHALL mettere davanti le
spec piu' vicine al cambiamento.

Il cancello SELEZIONA ovunque, ma ESEGUE le spec solo dove un browser e'
ammesso: nella CI della pull request (job `e2e (1)`, passo «E2E dei file
toccati», il cui esito la board legge secondo KANBAN-84) o su una macchina che
non e' un Mac. Su un Mac fuori da GitHub Actions, senza `--list`, SHALL uscire 97
dopo aver stampato la selezione e PRIMA di costruire il bundle o lanciare
Playwright: il 15/09/2026, eseguito sul Mac come check della board, ha fatto
scaricare Chromium in una postazione dove Chromium non deve esserci. `--list`
SHALL restare identico ovunque, ed e' il modo in cui un agente sul Mac vede quali
spec tocca il suo diff.

#### Scenario: gli identificativi si leggono ovunque siano dichiarati
- **GIVEN** un file che dichiara identificativi come attributo, come espressione e come stringa interpolata
- **THEN** la lettura SHALL trovarli tutti

#### Scenario: la spec che misura il cambiamento viene per prima
- **GIVEN** una modifica che tocca una funzione con la sua spec dedicata
- **THEN** quella spec SHALL precedere le spec di altre funzioni

#### Scenario: sul Mac lo script vero elenca e non esegue
- **GIVEN** un repository con un ramo che modifica una spec, su un Mac, con `GITHUB_ACTIONS` assente
- **THEN** `check:e2e-touched --list` SHALL uscire 0 stampando la spec
- **AND** `check:e2e-touched` senza `--list` SHALL uscire 97 senza avviare Playwright
- **AND** fuori da un Mac, o con `GITHUB_ACTIONS=true`, la guardia NON SHALL rifiutare


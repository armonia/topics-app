# chat — delta

## ADDED Requirements

### Requirement: PROJ-ID-01 — la cartella è il progetto, non la strada per arrivarci

Quando un percorso di progetto viene memorizzato su un topic, DEVE essere canonicalizzato
(link risolti, `~` espanso, barra finale tolta). Due percorsi che puntano alla stessa
cartella DEVONO produrre lo stesso `projectId` e le stesse chiavi `ui_state`.

#### Scenario: un topic creato su un symlink
- **GIVEN** `~/link-al-progetto` è un link a `~/Projects/progetto`
- **WHEN** si crea un topic con `projectPath: "~/link-al-progetto"`
- **THEN** il topic risulta legato a `~/Projects/progetto`, e nella sidebar c'è una voce sola

#### Scenario: una cartella non ancora creata
- **WHEN** si crea un topic con un `projectPath` che non esiste
- **THEN** il percorso si conserva com'è e la creazione riesce

### Requirement: PROJ-ID-02 — ciò che è già scritto si fonde solo su richiesta

La canonicalizzazione NON DEVE riscrivere percorsi già memorizzati. La fusione delle
identità doppie esistenti DEVE essere un'operazione esplicita, che per default si limita
a elencare cosa cambierebbe.

#### Scenario: la prova non scrive
- **WHEN** si esegue lo script senza `--esegui`
- **THEN** stampa vecchio e nuovo id con i conteggi, e il database resta invariato

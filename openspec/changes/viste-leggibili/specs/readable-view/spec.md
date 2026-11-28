## ADDED Requirements

### Requirement: READABLE-01 — Le forme note hanno una vista deterministica

`deterministicReadableView` SHALL mappare un oggetto con titolo e stato in una card, un oggetto piatto in una scheda chiave-valore, un array di oggetti piatti in una tabella, un array di percorsi in un elenco, un errore in una vista d'errore. Un valore con campi annidati (oggetto o array di oggetti dentro una scheda, card o cella) SHALL dare null, perché lo prenda il ripiego.

#### Scenario: oggetto con array annidato
- **GIVEN** `{results:[{id:1}], total:3}`
- **THEN** `deterministicReadableView` SHALL dare null

### Requirement: READABLE-02 — Ogni chiamata a un tool ha una frase e una tipologia

`toolPhrase` SHALL dare per i tool noti una frase leggibile e una tipologia (lettura, scrittura, ricerca, rete, browser, shell). Per un tool MCP sconosciuto SHALL chiamare il modello una sola volta per nome, tenendo la frase in cache; con il ripiego spento SHALL restare il nome umanizzato.

#### Scenario: stesso tool nuovo due volte
- **GIVEN** un tool MCP mai visto chiamato due volte
- **THEN** il modello SHALL essere chiamato una volta sola

### Requirement: READABLE-VIEW-02 — Il ripiego del modello nomina percorsi, mai valori

Il ripiego SHALL scartare una specifica con un valore inventato o un percorso che non esiste, risolvere `[]` nei percorsi e leggere i percorsi delle colonne relativi alla riga e `rowsPath` assoluto, mettere in cache per firma della forma, e NON mettere in cache un errore del provider ma solo una risposta ricevuta e non valida.

#### Scenario: la stessa forma due volte
- **GIVEN** due risultati con le stesse chiavi e tipi
- **THEN** il modello SHALL essere chiamato una volta sola

### Requirement: READABLE-VIEW-03 — Leggibile e Originale mostrano lo stesso testo originale

L'interruttore SHALL ricordare la scelta e SHALL lasciare identico il testo originale; finché non c'è una vista l'originale SHALL restare visibile.

#### Scenario: giro dell'interruttore
- **WHEN** si passa a Leggibile e di nuovo a Originale
- **THEN** il testo originale SHALL essere identico

### Requirement: READABLE-VIEW-04 — La rotta serve la vista in streaming e legge il modello dalle impostazioni

`POST /api/readable-view` SHALL leggere modello e interruttore dalle impostazioni lato server, mai dal client, e SHALL rispondere in NDJSON con viste parziali man mano che la specifica arriva.

#### Scenario: specifica a pezzi
- **WHEN** la specifica arriva a pezzi
- **THEN** la rotta SHALL emettere una vista prima che la specifica sia finita

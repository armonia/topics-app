## ADDED Requirements

### Requirement: CHAT-RND-01 — Syntax highlighting nei code block

I code block dei messaggi con linguaggio noto SHALL essere renderizzati con
evidenziazione sintattica, mantenendo le funzioni esistenti (copy, conteggio
righe, collapse, word wrap). Su linguaggio ignoto, blocco oltre soglia o errore
del tokenizer il blocco SHALL degradare al testo plain attuale.

#### Scenario: blocco javascript colorato
- **GIVEN** un messaggio assistant con un fence ```javascript
- **WHEN** il messaggio è renderizzato
- **THEN** i token (keyword, stringhe, commenti) hanno classi/colori distinti
- **AND** il bottone Copy copia il testo sorgente esatto

#### Scenario: degradazione sicura
- **GIVEN** un fence con linguaggio sconosciuto o >50KB
- **WHEN** il messaggio è renderizzato
- **THEN** il blocco appare come oggi (plain mono), senza errori

### Requirement: CHAT-RND-02 — Matematica LaTeX

Le espressioni `$$...$$` (display) e `\(...\)`/`$$` inline via remark-math SHALL
essere renderizzate con KaTeX nei messaggi chat. Il dollaro singolo NON attiva la
matematica (prezzi come "$5" restano testo).

#### Scenario: display math
- **GIVEN** un messaggio con `$$\int_0^1 x^2 dx$$`
- **WHEN** renderizzato
- **THEN** appare la formula tipografica KaTeX, non il testo grezzo

#### Scenario: dollaro singolo inerte
- **GIVEN** un messaggio con "costa $5 e rende $12"
- **WHEN** renderizzato
- **THEN** il testo resta invariato (nessun parsing math)

### Requirement: CHAT-RND-03 — Diagrammi Mermaid

Un fence ```mermaid con sintassi valida SHALL essere renderizzato come diagramma
SVG; con sintassi invalida (o durante lo streaming di un blocco incompleto) SHALL
degradare al code block plain senza crash. La libreria SHALL essere caricata lazy
(solo alla prima occorrenza di un blocco mermaid).

#### Scenario: flowchart renderizzato
- **GIVEN** un messaggio con un fence mermaid `graph TD; A-->B;`
- **WHEN** il messaggio è completo
- **THEN** appare un SVG del diagramma

#### Scenario: sintassi invalida degrada
- **GIVEN** un fence mermaid con sintassi rotta
- **WHEN** renderizzato
- **THEN** appare il code block plain (nessun errore in console che rompa la vista)

# Terminal — cercare nel terminale

## ADDED Requirements

### Requirement: TERM-FIND-01 — Il terminale cerca nello schermo e nelle righe che tiene

La pane terminale SHALL registrare un cercatore basato su
`@xterm/addon-search` (serie 0.16, per `@xterm/xterm` 6), caricato accanto a
`FitAddon` in `SingleTerminalPane.tsx`.

SHALL cercare nello schermo e nelle righe passate che xterm tiene
(`scrollback: 5000`), SHALL evidenziare i risultati con le decorazioni
dell'addon (il corrente con un colore suo) e SHALL prendere totale e indice da
`onDidChangeResults`. Le righe uscite dallo scrollback NON SHALL essere
promesse: il totale conta solo ciò che xterm ha.

L'addon ha `highlightLimit` 1000 per default, e oltre quella soglia
`resultIndex` vale -1 (`@xterm/addon-search` 0.16.0,
`typings/addon-search.d.ts:83-101`). Oltre 1000 risultati il contatore SHALL
dire «oltre 1000» senza la posizione, e Invio SHALL continuare a spostarsi sul
risultato dopo. Il limite NON SHALL essere alzato senza una misura del costo
delle decorazioni.

Aprire la barra NON SHALL mandare byte al programma che gira nel terminale.
Chiudere la barra SHALL togliere le decorazioni e rimettere il fuoco nel
terminale.

#### Scenario: una riga passata
- **GIVEN** un terminale che ha stampato `seq 1 300`
- **WHEN** apro la barra e cerco «150»
- **THEN** il contatore dice almeno un risultato e la riga 150 è in vista

#### Scenario: niente arriva al programma
- **GIVEN** un terminale con `cat` in attesa
- **WHEN** premo ⌘F, scrivo «abc» nella barra e premo Esc
- **THEN** `cat` non ha ricevuto «abc»

#### Scenario: oltre il limite dell'addon
- **GIVEN** un terminale che ha stampato 1500 righe con «x» ciascuna
- **WHEN** cerco «x»
- **THEN** il contatore dice «oltre 1000»

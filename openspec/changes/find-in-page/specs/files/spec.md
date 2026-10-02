# Files — cercare in un file, nell'editor e nelle anteprime

## ADDED Requirements

### Requirement: FILE-FIND-01 — Nell'editor la barra comune guida la ricerca di CodeMirror, con Sostituisci

Il cercatore della pane file in modalità editor SHALL usare il motore di
`@codemirror/search` già caricato (`CodeEditor.tsx`): `setSearchQuery`,
`findNext`, `findPrevious`, e il conteggio con `SearchQuery.getCursor`.

Il pannello di ricerca di CodeMirror NON SHALL aprirsi: `Mod-f` NON SHALL stare
nel keymap dell'editor, e ⌘F con il cursore nell'editor SHALL aprire la barra
comune (FIND-02).

Quando l'editor non è in sola lettura la barra SHALL avere una seconda riga
«Sostituisci» con «Sostituisci» e «Sostituisci tutti» (`replaceNext`,
`replaceAll`); in sola lettura NON SHALL averla. Una sostituzione SHALL essere
annullabile con ⌘Z dell'editor.

#### Scenario: conteggio nell'editor
- **GIVEN** un file aperto nell'editor con «const» 7 volte
- **WHEN** premo ⌘F e cerco «const»
- **THEN** il contatore dice «0 di 7», e dopo Invio «1 di 7»
- **AND** il pannello di CodeMirror (`.cm-search`) non c'è

#### Scenario: sostituire tutti
- **GIVEN** un file modificabile con «foo» 3 volte
- **WHEN** cerco «foo», scrivo «bar» in Sostituisci e premo «Sostituisci tutti»
- **THEN** il file non contiene «foo» e contiene «bar» 3 volte
- **AND** ⌘Z rimette le tre «foo»

#### Scenario: sola lettura
- **GIVEN** un file aperto in sola lettura
- **WHEN** apro la barra
- **THEN** la riga Sostituisci non c'è

### Requirement: FILE-FIND-02 — Le differenze si cercano col motore dell'editor, l'anteprima Markdown nel testo a schermo

Le differenze (`Editor/DiffViewer.tsx`) sono una `MergeView` di CodeMirror con
`collapseUnchanged`, che disegna solo le righe vicine allo schermo. Il loro
cercatore SHALL usare `SearchQuery` / `setSearchQuery` di `@codemirror/search`
su tutti e due gli `EditorView` (`mergeView.a`, `mergeView.b`), e NON SHALL
cercare nel DOM. Il totale SHALL contare anche le righe fuori vista e piegate,
e non SHALL cambiare mentre scorri. L'ordine SHALL essere: prima il lato
sinistro, poi il destro. Arrivando su un risultato in una parte piegata, la
parte SHALL aprirsi (`uncollapseUnchanged`).

L'anteprima Markdown (`Editor/MarkdownPreview.tsx`) SHALL registrare un
cercatore sul testo del suo DOM (`lib/domFind.ts`: nodi di testo, CSS Custom
Highlight API per l'evidenziazione, il corrente portato al centro della vista).

L'anteprima HTML e i PDF NON SHALL avere un cercatore (sono riquadri che
dall'esterno non si leggono), e ⌘F lì SHALL seguire il ripiego di FIND-02.

#### Scenario: una parola nell'anteprima
- **GIVEN** un file `.md` aperto in anteprima con «Installazione» in un titolo
- **WHEN** cerco «installazione»
- **THEN** il contatore dice «0 di 1», e dopo Invio il titolo è in vista ed evidenziato

#### Scenario: una parola in una parte piegata delle differenze
- **GIVEN** una differenza di un file di 200 righe con una sola riga cambiata e «zibaldone» alla riga 150, invariata e quindi piegata
- **WHEN** cerco «zibaldone»
- **THEN** il contatore dice «0 di 2» (una per lato)
- **AND** dopo Invio la parte piegata è aperta e la riga 150 è in vista

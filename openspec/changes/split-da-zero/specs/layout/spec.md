## ADDED Requirements

### Requirement: SPLIT-01 — Un trascinamento divide da qualunque sorgente

The grid and the project window SHALL read one intent from the drop zone, whatever the source (column row, tab, pinned tile, cell header): a cell edge splits on that side, the cell centre shows the pane there, the surface edge inserts a full row or column. A drag that starts in the column SHALL split on an edge exactly like a tab does, opening the pane first when it is closed. No drop SHALL close a pane.

#### Scenario: dalla colonna al bordo destro
- **GIVEN** three open chats, tabs on the side, one cell
- **WHEN** the user drags the row of Beta onto the right edge of the grid
- **THEN** the grid has two cells side by side with Beta on the right and one divider

### Requirement: SPLIT-02 — L'anteprima è l'impronta della pane, con il suo nome

During a drag exactly one indicator SHALL be painted: on an edge, the area the pane will occupy, carrying the icon and name of the dragged item; on the centre, an outline of the cell without a fill. An edge that would exceed the 4 × 4 cap SHALL NOT be offered.

#### Scenario: impronta sul bordo destro
- **GIVEN** a grid with one cell
- **WHEN** the user holds a dragged row over the right edge
- **THEN** the preview covers the right half of the cell and shows the row's name

### Requirement: SPLIT-03 — Una cella divisa dice cosa contiene e chi ha il fuoco

When a surface holds more than one cell and the tabs are on the side, every cell SHALL carry a header with the pane's icon and name, the header of the focused cell SHALL be lit, a click on a header SHALL focus its cell, and the header SHALL drag like a tab. With one cell there SHALL be no header.

#### Scenario: due celle, due testate
- **GIVEN** a grid split in two with tabs on the side
- **THEN** each cell shows a header with its pane's name and only the focused one is lit

### Requirement: SPLIT-04 — I divisori si usano da tastiera

Every split divider SHALL be focusable, expose its position as `aria-valuenow` (percent of the band), move by 5% per arrow key (1% with Shift) and even out its band on Enter, as it does on double-click.

#### Scenario: freccia destra
- **GIVEN** two cells side by side at 50%
- **WHEN** the divider has focus and the user presses ArrowRight
- **THEN** the left cell is at 55% and the divider reports 55

### Requirement: SPLIT-05 — Disposizione sta in ogni foglio

The sheet of a column row, a tab, the title and a cell header SHALL offer Split right, left, down and up, Zoom, Even out and Remove from split whenever the action applies; a row whose pane is not open SHALL offer Open on the right and Open below.

#### Scenario: foglio della riga
- **GIVEN** tabs on the side and an open chat that shares its cell
- **WHEN** the user opens the sheet of its row
- **THEN** the Layout level lists the four split directions, Zoom, Even out and Remove from split

### Requirement: SPLIT-06 — Il fuoco passa fra le celle da tastiera

Cmd+Option+Arrow SHALL move the focus to the nearest cell in that direction, measured on the cells' geometry; with no cell in that direction nothing SHALL change.

#### Scenario: a destra e poi sotto
- **GIVEN** two cells side by side and one below
- **WHEN** the user presses Cmd+Option+ArrowRight then Cmd+Option+ArrowDown
- **THEN** the focus moves to the right cell and then to the one below

### Requirement: SPLIT-07 — Gli split di un progetto hanno la loro mini mappa

A project row in the column SHALL show the mini map of the splits inside its project window, with the active cell lit, whenever that window holds more than one cell.

#### Scenario: progetto diviso in due
- **GIVEN** a project window split in two
- **THEN** the project's row shows a two-cell mini map with the active cell lit

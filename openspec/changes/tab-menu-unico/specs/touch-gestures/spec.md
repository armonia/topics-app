# Spec delta: tab-menu-unico (touch-gestures)

## MODIFIED Requirements

### Requirement: CTXMENU-01 — Il tasto destro apre il menu dell'app dove l'app ha comandi, e lascia quello di sistema dove non ne ha

Dove un elemento ha comandi suoi (righe della sidebar, card della board, righe
dei file e delle modifiche git, tab dell'editor di file), il tasto destro SHALL
aprire il menu dell'app costruito sul menu al cursore CONDIVISO, non su una
scheda scritta a mano: quattro menu scritti a mano avevano ciascuno un pezzo in
meno (una misura indovinata, nessun ruolo, nessun fuoco a cui tornare). Sulle tab
della barra delle pane (`PaneTabBar`), sulle schede della finestrella del browser
della topic e sul titolo sul telefono il menu dell'app SHALL essere invece il
foglio della tab (`TABSHEET-01`), che porta lo stesso contratto.

Quel menu SHALL stare dentro la finestra, aprendosi dall'altro lato del
puntatore quando un bordo lo taglierebbe (il foglio della tab: dall'altro lato
della tab); SHALL essere UNO alla volta; Esc e un clic fuori SHALL chiuderlo;
alla chiusura il fuoco SHALL tornare all'elemento cliccato. Shift+F10 e il tasto
menu SHALL aprire lo stesso menu sull'elemento che ha il fuoco, e tenendo premuto
col dito SHALL aprirsi lo stesso menu.

Dove l'app non ha comandi (i campi di testo, il testo del composer, il testo
selezionato in chat, il terminale) il menu di sistema SHALL restare, e NON SHALL
essere sostituito da un menu vuoto. Il menu di sistema NON SHALL mai comparire
sopra o sotto uno dell'app: un tasto destro SU un menu aperto non apre quello di
sistema, tranne su un campo di testo e sul testo SELEZIONATO dentro il pannello
che non sia l'etichetta di un suo comando (il diff del task, il log della
console): li' il menu di sistema e' l'unico modo di copiare.

Un file che si prende il tasto destro senza il menu condiviso SHALL far fallire
un controllo strutturale. Per quelle tre superfici il foglio della tab vale come
menu condiviso; per ogni altro file no, comprese le tab dell'editor di file.

#### Scenario: tasto destro su una riga con comandi
- **GIVEN** una riga della sidebar
- **WHEN** l'utente ci clicca col tasto destro
- **THEN** SHALL aprirsi il menu dell'app dentro la finestra, e il menu di sistema NO

#### Scenario: tasto destro su una tab della barra delle pane
- **GIVEN** una tab della barra delle pane
- **WHEN** l'utente ci clicca col tasto destro
- **THEN** SHALL aprirsi il foglio di quella tab dentro la finestra, e né il menu di sistema né un menu al cursore

#### Scenario: tasto destro su una tab dell'editor di file
- **GIVEN** una tab dell'editor di file, dentro la pane dei file
- **WHEN** l'utente ci clicca col tasto destro
- **THEN** SHALL aprirsi il menu al cursore condiviso con le voci di quella tab, e né il menu di sistema né il foglio della tab

#### Scenario: chiusura e tastiera
- **GIVEN** il menu aperto col tasto destro o con Shift+F10
- **WHEN** l'utente preme Esc
- **THEN** il menu SHALL chiudersi e il fuoco SHALL tornare all'elemento da cui era partito

#### Scenario: un campo di testo
- **GIVEN** il composer
- **WHEN** l'utente ci clicca col tasto destro
- **THEN** SHALL aprirsi il menu di sistema, e nessun menu dell'app

#### Scenario: testo selezionato dentro un pannello dell'app
- **GIVEN** il pannello delle modifiche del task aperto, con una riga del diff selezionata
- **WHEN** l'utente clicca col tasto destro sul testo selezionato
- **THEN** SHALL aprirsi il menu di sistema (Copia), il pannello SHALL restare aperto, e un tasto destro sull'intestazione del file nello stesso pannello NON SHALL aprire il menu di sistema

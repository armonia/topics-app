# Commands — ⌘F cerca dentro la pane su cui stai

## ADDED Requirements

### Requirement: FIND-01 — Una barra di ricerca sola, uguale in ogni pane

Ogni pane che ha del testo da cercare SHALL registrare un cercatore per il suo
`paneId` (`client/src/state/findRegistry.ts`), e la ricerca SHALL mostrarsi con
un componente solo, `FindBar`, in cima alla pane e nel flusso della sua colonna
(non sopra il contenuto, non dentro l'occlusione delle webview native).

La barra SHALL avere: il campo, il contatore, il tasto maiuscole/minuscole, i
tasti precedente e successivo, il tasto chiudi. Il contatore SHALL seguire
BROWSER-FIND-01 (`findInPageModel.ts`) e SHALL scriversi «{indice} di {totale}»
in italiano e «{indice} of {totale}» in inglese.

Nel campo: Invio SHALL andare al risultato successivo, ⇧Invio al precedente.
Con la barra della pane a fuoco aperta, ⌘G SHALL andare al successivo e ⇧⌘G al
precedente, ovunque sia il cursore nella pane.

Il risultato corrente SHALL avere un'evidenziazione diversa da quella degli
altri risultati.

Lo stato della barra (aperta, parola, maiuscole, indice) SHALL appartenere alla
pane: spostarsi su un'altra pane e tornare SHALL ritrovarla com'era. Ogni
etichetta SHALL passare dai dizionari `i18n-it.ts` e `i18n-en.ts`, e le icone
SHALL essere lucide.

#### Scenario: il contatore nella lingua dell'app
- **GIVEN** la lingua italiana e una ricerca con 12 risultati
- **WHEN** premo Invio tre volte
- **THEN** il contatore dice «3 di 12»

#### Scenario: la barra resta della sua pane
- **GIVEN** la barra aperta su una chat con la parola «deploy»
- **WHEN** metto a fuoco un terminale e poi torno sulla chat
- **THEN** la barra della chat è aperta con «deploy» e lo stesso indice
- **AND** il terminale non ha una barra aperta

### Requirement: FIND-02 — ⌘F va alla pane a fuoco, ovunque sia il cursore; i progetti passano a ⇧⌘F

⌘F (senza ⇧) SHALL aprire la barra della pane a fuoco e mettere il cursore nel
suo campo, con il testo selezionato se la barra era già aperta. SHALL farlo
anche con il cursore in un campo di testo della pane (il campo della chat), in
un terminale, in un editor, o dentro la pagina di una pane browser nativa
(BROWSER-FIND-02).

Il cursore nel campo SHALL essere anche la tastiera del sistema: aprendosi, la
barra SHALL chiamare `releaseNativeFocus()` (`lib/shell/tauri.ts:50-56`) prima
di mettere il fuoco nel suo campo. Senza, con una pane browser nativa a fuoco
le lettere vanno alla pagina (`Browser/useBrowserChromeBridge.ts:107-118`).

Il modificatore: sul Mac (`usesCtrl` falso, `lib/shortcutLabel.ts:34`) SHALL
contare solo ⌘; Ctrl+F col cursore in un campo di testo, in un terminale o in
un editor NON SHALL essere preso e SHALL restare a quella superficie (avanti di
un carattere). Dove `usesCtrl` è vero (Windows, Linux) Ctrl+F SHALL aprire la
barra ovunque sia il cursore, terminale compreso.

Se la pane a fuoco non ha un cercatore:
- la board SHALL ricevere il cursore nel suo campo filtro
  (`Board/FilterTokenField.tsx`);
- ogni altra pane SHALL aprire la ricerca nel contenuto dei progetti, come
  prima di questa change.

⇧⌘F SHALL aprire, o chiudere se aperta, la ricerca nel contenuto dei progetti;
con la ricerca per nome aperta (⌘P) SHALL passare al modo contenuto senza
chiudere. Questo rovescia il ritiro di ⇧⌘F del 2026-08-06 (SRC-05 in
`tests/e2e/search-shortcuts.spec.ts`), e SRC-03 diventa: ⌘F in un campo di
testo apre la barra della pane, non la ricerca nei progetti. Il registro
`shared/shortcuts.ts` SHALL avere le righe ⌘F «Cerca qui», ⌘G, ⇧⌘G e ⇧⌘F
«Cerca nei progetti aperti», e ⌘F e ⌘G SHALL portare `native` (accordi
inoltrati dalla shell su Mac e Windows).

#### Scenario: dal campo della chat
- **GIVEN** una chat a fuoco con il cursore nel campo dove scrivo
- **WHEN** premo ⌘F
- **THEN** si apre la barra della chat con il cursore nel suo campo
- **AND** la ricerca nei progetti non si apre

#### Scenario: Ctrl+F sul Mac resta al campo
- **GIVEN** il Mac, una chat a fuoco con il cursore nel campo dove scrivo
- **WHEN** premo Ctrl+F
- **THEN** né la barra della chat né la ricerca nei progetti si aprono

#### Scenario: la ricerca nei progetti su ⇧⌘F
- **GIVEN** un progetto aperto
- **WHEN** premo ⇧⌘F
- **THEN** si apre la ricerca nel contenuto dei progetti (`file-search`, modo contenuto)

#### Scenario: una pane senza testo da cercare
- **GIVEN** la dashboard a fuoco e un progetto aperto
- **WHEN** premo ⌘F
- **THEN** si apre la ricerca nel contenuto dei progetti

#### Scenario: la board
- **GIVEN** la board a fuoco
- **WHEN** premo ⌘F
- **THEN** il cursore è nel campo filtro della board

### Requirement: FIND-03 — Esc nella barra chiude la barra, e non interrompe il turno

Con il cursore dentro una `FindBar`, Esc SHALL chiudere quella barra, togliere
le evidenziazioni e rimettere il cursore dove stava nella pane prima di ⌘F, e
NON SHALL interrompere il turno in streaming della pane. Se la barra era stata
aperta col cursore dentro la pagina di una pane browser nativa, Esc SHALL
ridare la tastiera a quella pagina con un comando di release della shell
(`browser_focus_pane`; oggi `focus_grab_browser`, `lib.rs:8083`, esiste solo
in debug). La regola SHALL stare
nel gestore in capture su window (`useKeyboardShortcuts.ts`), prima del ramo
che interrompe il turno, perché quel gestore gira prima di ogni `onKeyDown`
della barra.

Con il cursore fuori dalla barra Esc SHALL fare quello che faceva prima di
questa change (in un terminale arriva al programma; in una chat in streaming
interrompe il turno).

#### Scenario: Esc nella barra di una chat che sta scrivendo
- **GIVEN** una chat con un turno in streaming e la sua barra aperta col cursore nel campo
- **WHEN** premo Esc
- **THEN** la barra si chiude
- **AND** il turno è ancora in streaming

### Requirement: FIND-04 — Sul touch la barra si apre dal menu della tab

Il menu della tab (`Layout/PaneTabBar.tsx`) SHALL avere la voce «Cerca» quando
la pane ha un cercatore, e la voce SHALL aprire la stessa barra di ⌘F. Le pane
senza cercatore NON SHALL avere la voce.

#### Scenario: chat sul telefono
- **GIVEN** una chat su un viewport 390x844
- **WHEN** apro il menu della sua tab e scelgo «Cerca»
- **THEN** si apre la barra della chat

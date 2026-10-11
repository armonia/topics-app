## Purpose

La chrome del telefono dopo il giro di feedback del 05/10/2026 (change
`mobile-chrome-feedback`, msg 3862): la riga in alto si rivela scorrendo e le
sessioni partono da subito dopo la safe area, il menu Topics vive nel menu
utente, la fila in basso tiene le sue misure, Cerca sta nel design system, «In
attesa» risponde sempre e la matita apre subito una chat nuova. Tutto sotto i
768px; sopra non cambia un pixel.

Sui numeri: le etichette di scenario `MOBILE-CHROME-01..09` di
`tests/e2e/mobile-chrome-bar.spec.ts` sono nate prima di questa capability e
nominano scenari loro (la legge concentrica, la pane Profilo, il velo in alto).
I requisiti qui sotto partono da `MOBILE-CHROME-07` e gli id si leggono nelle
annotazioni `spec` dei test, non nei titoli.

## Requirements

### Requirement: MOBILE-CHROME-07 — In alto la riga si rivela, le righe partono dalla safe area, Topics sta nel foglio

Sotto i 768px la colonna SHALL tenere le righe da subito dopo `--sat`
(`--sidebar-scroll-top` SHALL essere la sola safe area, non la safe area più
l'altezza della riga) e la riga in alto SHALL essere compatta in cima (44px,
`data-compact="true"`) e intera appena la lista scorre (56px,
`data-compact="false"`), fuori dal flusso in entrambi i casi.

Il foglio del titolo (che sul telefono È il menu utente) SHALL avere due
piani: la radice con l'identità, la voce «Topics» (`user-menu-topics-entry`) e
lo stato, e il piano Topics con le righe e la riga «Indietro»
(`user-menu-topics-back`). Una richiesta per Aspetto, Notifiche o Vista SHALL
aprire il foglio già sceso al piano Topics.

#### Scenario: compatta in cima, intera appena si scorre, righe dalla safe area
- **GIVEN** un viewport da telefono e una lista che scorre
- **WHEN** la lista è in cima
- **THEN** la riga è alta 44px con `data-compact="true"` e la prima riga sta a `--sat`
- **WHEN** la lista scorre
- **THEN** la riga è alta 56px con `data-compact="false"` e le righe le passano sotto

#### Scenario: il menu Topics si raggiunge dal menu utente
- **GIVEN** il foglio aperto alla radice
- **WHEN** si tocca la voce «Topics»
- **THEN** si vedono la riga «Indietro» e le righe dei topics
- **WHEN** si tocca «Indietro»
- **THEN** si torna alla radice (voce «Topics» e stato visibili)

### Requirement: MOBILE-CHROME-08 — La fila in basso tiene raggi, aria e bilanciamento

Sotto i 768px, su 390x844 con la fascia dell'home indicator, la fila
(`MobileChromeBar`) SHALL tenere la geometria misurata: il primo e l'ultimo
tasto SHALL avere il raggio basso esterno sopra 12px (concentrico, da
`safeAreaArc`), fra i tasti SHALL esserci il PASSO (6px) e sopra i tasti
l'aria SOPRA (6px), il glifo di ogni tasto SHALL stare al centro del tasto
(±1px su entrambi gli assi) e la parola SHALL stare sotto il glifo, fuori dal
flusso, con aria misurabile fra il glifo e il fondo del tasto.

#### Scenario: raggi, aria e glifi al centro
- **GIVEN** un viewport da telefono con la fascia forzata a 34px e il raggio a 55px
- **THEN** il basso esterno del primo e dell'ultimo tasto è sopra 12px
- **AND** fra un tasto e l'altro ci sono 6px (±1) e sopra i tasti 6px (±1)
- **AND** ogni glifo è al centro del suo tasto (±1px) con la parola sotto

### Requirement: MOBILE-CHROME-09 — Il toggle Cerca sta al passo degli altri tasti

Sotto i 768px la distanza del tasto Cerca dai vicini SHALL essere la distanza
fra gli altri tasti: un PASSO unico, misurato sia fra i bordi che fra i centri
dei glifi (±1px).

#### Scenario: Cerca equidistante
- **GIVEN** un viewport da telefono con la fascia forzata a 34px e il raggio a 55px
- **THEN** il buco fra Cerca e il vicino è il buco fra gli altri (±1px)
- **AND** il passo fra il centro del glifo di Cerca e quello del vicino è il passo fra gli altri centri (±1px)

### Requirement: MOBILE-CHROME-10 — Cerca sta nel design system e dentro la safe area

Sotto i 768px la pagina di ricerca a schermo pieno SHALL avere il fondo
dell'app (`--bg`, mai il grigio dei popover che prendeva da
`.native-occlude`), dipinto da y=0 senza stacchi col notch, e il contenuto
SHALL stare dentro la safe area: niente sopra `--sat`, niente sotto
l'indicatore (`--sab`).

#### Scenario: fondo dell'app e contenuto nella safe area
- **GIVEN** un viewport da telefono con `--sat` a 24px e `--sab` a 34px
- **WHEN** si apre Cerca
- **THEN** il fondo computato della pagina è il fondo computato dell'app
- **AND** il campo sta sotto `--sat` e l'ultima riga sta sopra l'indicatore

### Requirement: MOBILE-CHROME-11 — «In attesa» risponde sempre, a coda vuota apre l'Inbox

Sotto i 768px la porta «In attesa» SHALL essere sempre abilitata: con la coda
fa il passo di ⌘J (CHAT-WAIT-04, provato lì), a coda vuota SHALL aprire la
pagina In attesa (il Now dell'Inbox) invece di restare muta. Il nome
accessibile SHALL portare il numero, zero compreso.

#### Scenario: a coda vuota apre il Now
- **GIVEN** un viewport da telefono e nessuna chat in attesa
- **THEN** la porta è abilitata
- **WHEN** la si tocca
- **THEN** si apre il pannello Inbox sul Now

### Requirement: MOBILE-CHROME-12 — La matita apre subito una chat, tenuta premuta apre il menu

Sotto i 768px la porta di creazione (`pane-add-menu-trigger`, glifo `Pencil`)
SHALL aprire subito una chat nuova al tap — il cassetto si chiude e davanti va
una chat senza righe (le bozze sono scratch locali e non si leggono dal
server: la prova è che ogni chat esistente ha una riga e questa no) — e SHALL
aprire l'intero menu «+» (lo stesso elenco del desktop, non un sottoinsieme)
alla pressione lunga, senza aprire nessuna chat.

#### Scenario: tap apre la bozza, pressione lunga apre il menu
- **GIVEN** un viewport da telefono col cassetto aperto e ogni chat con una riga
- **WHEN** si tocca la matita
- **THEN** il cassetto si chiude e davanti va una chat senza righe, senza menu
- **WHEN** invece la si tiene premuta
- **THEN** si apre il menu «+» con le sue righe e nessuna chat si apre

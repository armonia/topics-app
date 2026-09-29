# Notifications — una verità sola

## ADDED Requirements

### Requirement: NOTIF-ONE-01 — Un solo «visto» per soggetto, e vederlo ovunque lo spegne ovunque

Una chat e un terminale SHALL avere un solo stato di «visto». Aprire la chat,
cliccare una sua notifica nel pannello o aprire il pannello (che segna viste
tutte le righe della lista) SHALL passare dalla stessa porta lato server, che
azzera il non-letto della chat E segna viste le sue righe, e lo annuncia a ogni
finestra con `unread:updated` e `notification:seen`.

Aprire il pannello SHALL spegnere anche le chat con non-letti che non hanno
più righe non viste, e i segni «finito» dei terminali. SHALL risparmiare solo i
soggetti con una notifica arrivata DOPO la lista letta: quella non è stata vista.

Il frame `notification:seen` SHALL nominare i soggetti spenti (`subjects`) o,
per il «segna tutto», quelli risparmiati (`allExcept`), così ogni finestra spegne
i propri segni in memoria e i pallini delle sole righe nominate.

#### Scenario: una notifica di chat vista nel pannello
- **WHEN** si clicca nel pannello la notifica di una chat con 4 non letti
- **THEN** il non-letto della chat SHALL essere zero, e la sua riga, la sua tab e il numero globale SHALL calare insieme

#### Scenario: il pannello aperto su una chat ferma
- **GIVEN** una chat con 3 non letti e nessuna riga non vista
- **WHEN** si apre il pannello
- **THEN** il suo non-letto SHALL andare a zero e nessuna superficie SHALL mostrarla

#### Scenario: una notifica più nuova della lista letta
- **WHEN** una notifica arriva dopo la lettura della lista
- **THEN** la sua chat NON SHALL essere spenta dal «segna tutto»

#### Scenario: aprire una chat con il non-letto già a zero
- **WHEN** si apre una chat che ha righe non viste e non-letto zero
- **THEN** le sue righe SHALL essere segnate viste

### Requirement: NOTIF-ONE-02 — I numeri globali contano soggetti, non messaggi

Il numero globale (Dock, tray, badge PWA) e il numero della campanella SHALL
contare i SOGGETTI in attesa: una chat vale 1 qualunque sia il numero dei suoi
messaggi, un terminale finito 1, una pane con badge 1, una card in review 1. Due
righe dello stesso gruppo sono una cosa sola. Le righe e le tab POSSONO
continuare a mostrare il numero dei messaggi della chat.

#### Scenario: due chat, sei messaggi
- **WHEN** una chat ha 4 non letti e un'altra 2, ognuna con la sua notifica
- **THEN** il numero globale e la campanella SHALL dire 2

## MODIFIED Requirements

### Requirement: CHROME-COUNT-01 — Un numero solo per il dock, la tray e l'icona, ed e' quello della sidebar

Il numero che Topics dipinge sul sistema operativo (badge dell'icona, glifo
nella barra dei menu, Badging API della PWA) SHALL essere il risultato di UNA
funzione pura, e quella funzione SHALL essere l'unico posto dove quel numero
esiste.

Il criterio e' uno: QUANTE COSE STANNO CHIEDENDO QUALCOSA A UN UMANO. Le chat
non lette o ferme in attesa, i terminali che hanno finito, le card della board
che aspettano una decisione. Cose, non messaggi (NOTIF-ONE-02). Il lavoro che
gira da solo non entra, e un topic ARCHIVIATO non entra mai.

Il numero SHALL coincidere con il numero di righe di sidebar che mostrano un
badge per gli stessi soggetti, e la parita' SHALL essere provata calcolando
l'attesa dagli stessi aiutanti per-riga, non da un numero scritto a mano.

#### Scenario: le due superfici sullo stesso stato
- **WHEN** un insieme di topic, terminali e card produce il conteggio del chrome
- **THEN** quel numero SHALL essere uguale al numero di righe di sidebar con un badge per gli stessi soggetti, piu' le card in review

#### Scenario: la chat letta
- **WHEN** un topic con non letti viene letto e il suo conteggio va a zero
- **THEN** il totale SHALL calare di uno, senza toccare gli altri

#### Scenario: un topic archiviato con non letti
- **THEN** SHALL contare zero: nessuna superficie lo mostra, nessun gesto lo spegne

#### Scenario: archiviato in vista, con «mostra archiviati» acceso
- **WHEN** la riga di un topic archiviato con non letti compare in sidebar
- **THEN** SHALL portare badge zero, come il chrome

#### Scenario: niente da mostrare
- **WHEN** non c'e' nessun soggetto in attesa
- **THEN** il totale SHALL essere zero, che e' il badge spento

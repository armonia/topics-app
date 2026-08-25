## Purpose

Specifies behavioral scenarios for the unified attention system: the numeric badge that
one topic shows on every surface at once (pane tab, sidebar row, OS app badge), the
per-topic mute that silences the interruption without hiding the count, and the parity
contract that keeps those surfaces from drifting apart.

## Background

Common preconditions shared across scenarios:

- The user is logged into Topics App and the sidebar is visible
- Attention reaches the client as WebSocket frames: `unread:updated` for chat messages,
  `session:state` for a Claude Code phase transition
- A badge count is read from a single rollup (`getBadgeCount` in
  `client/src/hooks/useTabNotifications.tsx`), never from a per-surface counter

## Requirements

### Requirement: TAB-BADGE-01 — Unread badge on an inactive chat tab

The system SHALL render the topic's unread count as a numeric badge on that topic's pane
tab while the tab is not the active one.

#### Scenario: Unread count paints a badge on the inactive tab
- **GIVEN** two topics A and B are open as pane tabs and B is the active tab
- **WHEN** the server broadcasts `unread:updated` for topic A with a count of 3
- **THEN** A's pane tab shows a badge whose text is exactly "3"

### Requirement: TAB-BADGE-02 — Badge clears when the tab is activated

The system SHALL remove the badge from a tab once the topic's unread count returns to
zero after the user activates that tab.

> Written from the test: the E2E injects the `unread:updated → 0` frame itself after the
> click, so what is pinned is the client's rendering of a zeroed count, not the server's
> decision to clear unread on focus.

#### Scenario: Activating the tab drops the badge
- **GIVEN** topic A's inactive pane tab shows a badge of "5"
- **WHEN** the user clicks A's tab to activate it
- **AND** the server reports A's unread count as 0
- **THEN** the badge is no longer visible on A's tab

### Requirement: TAB-BADGE-07 — No badge on the active tab

The system SHALL suppress the unread badge on the tab the user is already looking at:
`getBadgeCount` returns 0 for an active pane regardless of the unread count the server
reports for its topic.

> Written from the test, which is tagged `@nightly` and runs off the PR gate: its
> negative assertion (wait, then expect count 0) is timing-sensitive on CI-Linux.

#### Scenario: Unread on the active topic paints nothing
- **GIVEN** topic A is open as the single, active pane tab
- **WHEN** the server broadcasts `unread:updated` for topic A with a count of 2
- **THEN** no badge element is rendered inside A's tab

### Requirement: TAB-BADGE-08 — Badges are independent per pane

The system SHALL track badge state per pane, so a badge raised on one tab neither
appears on nor clears another tab's badge.

#### Scenario: Switching the active tab moves which tab can carry a badge
- **GIVEN** topics A and B are open as pane tabs and B is active
- **WHEN** the server broadcasts an unread count of 2 for A
- **THEN** A's tab shows a badge of "2"
- **WHEN** the user activates A, A's unread is reported as 0, and B is reported unread 7
- **THEN** B's tab shows a badge of "7"
- **AND** A's tab shows no badge, because A is now the active tab

### Requirement: TAB-BADGE-09 — Badge is a filled pill that does not resize the tab

The system SHALL render the badge with a non-transparent background, and adding a badge
SHALL NOT change the width of the tab it sits on.

> Written from the test, and no wider: it pins a computed `background-color` that is not
> transparent and a tab width that stays exactly 150px with a two-digit count. Shape,
> colour token and position relative to the close button are not asserted.

#### Scenario: A two-digit badge keeps the tab at its fixed width
- **GIVEN** topics A and B are open as pane tabs and B is active
- **WHEN** the server broadcasts an unread count of 42 for topic A
- **THEN** A's tab shows a badge whose text is exactly "42"
- **AND** the badge's computed background colour is neither `transparent` nor fully transparent rgba
- **AND** A's tab is 150px wide

### Requirement: MUTE-01 — Mute silences the interruption, never the count

The system SHALL suppress the native completion banner (and its sound) for a topic whose
`muted` flag is set, while still counting that topic's attention in the app badge and in
its own on-screen tab badge. The mute gate (`client/src/lib/notify/muteGate.ts`) decides
only the interruption; the badge rides the attention rollup, which never consults it.

#### Scenario: Two sessions finish, one muted — exactly one banner fires
- **GIVEN** a muted topic and an unmuted topic are both open, and neither is the focused pane
- **AND** both have been seen in the `running` phase (the first frame for a session only records the phase)
- **WHEN** both flip from `running` to `completed` in the same tick
- **THEN** exactly one native notification is constructed
- **AND** its title names the unmuted topic and never the muted one

#### Scenario: The app badge counts the muted topic too
- **GIVEN** both topics have just completed as above
- **WHEN** each topic is reported with an unread count of 1
- **THEN** `navigator.setAppBadge` is called with the previous total plus 2
- **AND** the muted topic's own pane tab shows a badge of "1"

#### Scenario: Foregrounding the muted topic drops its share of the badge
- **GIVEN** the app badge counts both topics
- **WHEN** the user activates the muted topic's pane and its unread is reported as 0
- **THEN** the app badge falls back by exactly one, keeping the still-backgrounded topic's share

### Requirement: MUTE-02 — Il fuoco che ESCE da una chat va detto al server, non solo quello che entra

Quando il fuoco lascia una chat per una pane che NON è una chat — la board, un
terminale, un browser — il sistema SHALL dirlo al server. L'ingresso in una chat
era già annunciato; l'uscita no, e il gemello esisteva in un punto solo, dentro
una finestra di progetto.

Non è simmetria per il gusto della simmetria. Senza l'annuncio dell'uscita, per
il server l'ultima chat guardata resta quella davanti: dopo la soglia di
permanenza entra fra quelle «in lettura», e da lì OGNI suo conteggio di non
letti maggiore di zero viene RI-MARCATO letto al volo, sul ramo «è arrivato un
messaggio mentre stavi già leggendo». Il risultato è che **un turno che finisce
su una chat in secondo piano non lascia traccia sul badge**, e quale chat perda
il conto dipende da quale scheda è stata aperta per prima.

#### Scenario: due chat aperte, il fuoco sulla board
- **GIVEN** due chat aperte e il fuoco spostato su una pane che non è una chat
- **WHEN** entrambe ricevono un messaggio
- **THEN** ENTRAMBE SHALL contare sul badge

### Requirement: PARITY-01 — Same count on the tab bar and the sidebar row

The system SHALL show the same unread count for a topic on its pane tab and on its
sidebar row, and SHALL NOT render the retired per-Claude phase dot on any surface — the
phase signal is folded into the badge.

#### Scenario: One unread event paints both surfaces with the same number
- **GIVEN** topics A and B are open as pane tabs and B is active, leaving A unfocused on both surfaces
- **WHEN** the server broadcasts an unread count of 2 for topic A
- **THEN** A's pane tab shows a badge of "2"
- **AND** A's sidebar row shows a badge of "2"

#### Scenario: No legacy phase dot survives anywhere
- **GIVEN** the app is rendered with the badge above in place
- **WHEN** the page is searched for the retired `ClaudePhaseDot` tooltips ("Awaiting your approval", "Claude is generating…", "Claude is running a tool", "Claude replied — waiting for you", "Approval timed out — still waiting on you", "Session error", "Finished a turn — click to open")
- **THEN** none of them is present

### Requirement: UNREAD-01 — Un messaggio incrementa SEMPRE, e solo una lettura esplicita azzera

L'arrivo di un messaggio su un topic SHALL incrementare il suo non-letto,
SEMPRE. Solo una lettura ESPLICITA — quella che il client manda dopo una
permanenza continua sullo sguardo — SHALL azzerarlo.

NON SHALL esistere un cancello del tipo «se il topic è a fuoco, non contare».
Quel cancello equivaleva a «presente = letto», senza nessuna nozione di tempo, e
si rompeva in due modi:

1. un messaggio ad applicazione in secondo piano NON produceva MAI il badge,
   perché il server considerava ancora a fuoco l'ultima chat vista — non
   esisteva un annuncio di uscita affidabile e il fuoco veniva ri-annunciato a
   ogni riconnessione;
2. la soppressione era GLOBALE: bastava una qualunque connessione — un altro
   dispositivo, un'altra finestra, un'applicazione web dimenticata — con quel
   topic a fuoco perché NESSUNO ricevesse il badge.

Da quando la lettura è marcata sulla soglia di permanenza, quel cancello è
insieme ridondante e dannoso. Vedi [[MUTE-02]] per l'altra metà: l'uscita dal
fuoco va comunque detta al server.

Messaggi ravvicinati NON SHALL essere collassati: ognuno conta.

L'incremento NON SHALL toccare il non-letto degli ALTRI topic, e NON SHALL
azzerare l'istante di ultima lettura di una riga che esiste già.

L'annuncio SHALL portare il conteggio NUOVO, non quello precedente
all'incremento.

Un errore di persistenza del non-letto NON SHALL propagare: il badge è
accessorio, il messaggio no.

#### Scenario: messaggi a raffica
- **GIVEN** più messaggi ravvicinati sullo stesso topic
- **THEN** il conteggio SHALL crescere di uno per ciascuno

#### Scenario: la scrittura del badge fallisce
- **GIVEN** un errore nel persistere il non-letto
- **THEN** la consegna del messaggio NON SHALL fallire

### Requirement: MUTE-03 — Il silenzio per progetto si legge dove il client lo scrive già, e ogni forma storta vale «nessuno»

Il silenzio per PROGETTO SHALL essere letto dal server dalla riga di
impostazioni che il client pubblica già. Non SHALL richiedere una colonna nuova
né un canale nuovo: il campo non è locale al dispositivo, quindi viaggia con le
impostazioni e la riga lo contiene — mancava solo qualcuno che lo LEGGESSE.

Il valore è testo libero scritto da un client, quindi SHALL essere validato per
intero: riga assente, contenuto illeggibile, campo mancante, campo della forma
sbagliata, elementi che non sono testo, testo vuoto.

**Ogni caso storto SHALL valere LISTA VUOTA**, cioè «nessun progetto
silenziato». Il verso dell'errore è deliberato: una notifica di troppo si
ignora, una persa non si recupera.

La lettura NON SHALL pescare da altre chiavi dello stato, e una tabella assente
SHALL dare lista vuota invece di un'eccezione.

Gli elementi validi di un elenco parzialmente sbagliato SHALL essere TENUTI: si
scartano i singoli elementi storti, non l'intera preferenza.

#### Scenario: contenuto illeggibile
- **GIVEN** una riga di impostazioni che non si riesce a interpretare
- **THEN** SHALL valere nessun progetto silenziato, senza errore

#### Scenario: elenco misto
- **GIVEN** un elenco con dentro elementi validi e altri no
- **THEN** SHALL essere tenuto ciò che è valido

### Requirement: NOTIF-LOG-01 — Lo stesso evento da due mittenti è UNA riga, e il bersaglio si salva quando lo si conosce

Un evento registrato più volte entro una FINESTRA di tempo SHALL lasciare UNA
riga sola: due mittenti che raccontano lo stesso fatto sono un fatto, non due.
FUORI dalla finestra la stessa chiave SHALL essere un evento NUOVO — altrimenti
un fatto che si ripete davvero, a distanza, sparisce.

Il BERSAGLIO SHALL essere salvato con la riga, non ricostruito quando qualcuno
ci clicca: ricostruirlo dopo significa indovinare, e una notifica che porta nel
posto sbagliato è peggio di una che non porta da nessuna parte. Senza bersaglio
la riga SHALL esistere comunque, e NON SHALL essere cliccabile.

Il RAGGRUPPAMENTO predefinito SHALL essere il bersaglio: ciò che porta allo
stesso posto si legge insieme.

Una lettura SHALL poter azzerare FINO A un certo punto, lasciandolo. Vista UNA
del gruppo, SHALL essere considerato visto il GRUPPO: contare ancora ciò che la
persona ha appena aperto è come nasce un contatore che non torna mai a zero.

Una richiesta di lettura SENZA identificativi e senza un punto NON SHALL toccare
niente: la lettura è un gesto esplicito.

Oltre un TETTO SHALL restare le più recenti, e le righe più vecchie della
SCADENZA SHALL sparire al primo inserimento: il registro non deve crescere per
sempre.

#### Scenario: due mittenti, un evento
- **GIVEN** lo stesso evento registrato due volte dentro la finestra
- **THEN** SHALL restare una riga sola

#### Scenario: una del gruppo
- **GIVEN** una notifica di un gruppo dichiarata vista
- **THEN** il contatore del gruppo SHALL tornare a zero

### Requirement: PUSH-01 — Un dispositivo si iscrive davvero, e una revoca cancella SOLO le righe giuste

L'iscrizione di un dispositivo SHALL scrivere una riga: il meccanismo era
completo in ogni suo pezzo e NESSUN dispositivo si era mai iscritto.

La riga SHALL portare il proprio dispositivo, e — quando chi si iscrive è
APPAIATO — la sua IDENTITÀ, non l'identificativo che il corpo della richiesta
dichiara. Un'iscrizione senza identità SHALL continuare a ricevere.

Un'iscrizione senza chiavi SHALL essere un rifiuto, non una riga muta. Un
recapito RUOTATO SHALL SPOSTARE il dispositivo, non raddoppiarlo. Un dispositivo
inesistente SHALL essere dichiarato assente, non un successo che non ha fatto
niente.

Le preferenze SHALL essere PER DISPOSITIVO: spegnere il telefono NON SHALL
spegnere il computer, e una nuova iscrizione NON SHALL riaccendere un dispositivo
spento.

Revocare un DISPOSITIVO SHALL togliergli le iscrizioni; il filtro SHALL stare
nella richiesta, così anche una riga sopravvissuta non riceve. Lo stesso telefono
che si RIAPPAIA dopo una revoca SHALL restare UNA riga sola: l'identificativo
locale sopravvive alla revoca, l'identità appaiata no, e restringere la potatura
alla sola identità produrrebbe una violazione di unicità.

Cancellare un GRUPPO NON SHALL cancellare le iscrizioni dei suoi membri, e
TOGLIERE un membro nemmeno: la funzione che elenca i dispositivi di un soggetto
restituisce per costruzione solo quelli VIVI, ed è da lì che passava il difetto.
Revocare quel dispositivo SHALL continuare a cancellarle — il controllo positivo.

Le righe scritte PRIMA che l'identità esistesse SHALL potervi essere attribuite,
e il timbro NON SHALL rubare le righe di un ALTRO dispositivo.

Una colonna assente SHALL essere SILENZIO; un errore VERO SHALL essere
registrato. Una revoca NON SHALL fallire per colpa della tabella delle notifiche.

L'elenco SHALL dire QUALE dispositivo sei: senza, due telefoni uguali sono
indistinguibili. Senza identificativo NESSUNA riga SHALL essere marcata come
questo dispositivo: meglio nessuna che quella sbagliata.

#### Scenario: cancellare un gruppo
- **GIVEN** un gruppo cancellato
- **THEN** le iscrizioni dei suoi membri NON SHALL essere cancellate

#### Scenario: lo stesso telefono che si riappaia
- **GIVEN** una revoca seguita da un nuovo appaiamento
- **THEN** SHALL restare una riga sola

### Requirement: PUSH-02 — Un tasto di notifica CHIAMA, e un percorso rifiutato non chiama niente

I tasti dichiarati in una notifica SHALL diventare i tasti che si vedono, e una
notifica senza tasti SHALL restare quella di prima. Se NON ci stanno TUTTI NON
SHALL essere mostrato NESSUNO: mezzi tasti sono peggio di nessuno.

Tasti MALFORMATI NON SHALL arrivare al sistema.

Premere un tasto SHALL CHIAMARE e NON SHALL aprire nulla: un gesto, non due. La
chiamata SHALL portare le credenziali della sessione, o il cancello la respinge.

Un rifiuto del server, e l'assenza di rete, SHALL ripiegare APRENDO il task —
dove il motivo si legge — mai su un tasto che sparisce nel vuoto.

Premere il CORPO della notifica SHALL aprire come sempre, senza eseguire niente.

Un percorso RIFIUTATO — fuori dalla bacheca, verso un altro ospite, con una
risalita, o che non è nemmeno un testo — NON SHALL produrre NESSUNA chiamata. Un
metodo non previsto nemmeno.

Un tasto premuto SENZA la propria richiesta associata SHALL aprire il task.

Il codice del servizio SHALL essere IDENTICO nelle due copie che ne esistono: una
copia non rigenerata è una copia che si comporta diversamente.

#### Scenario: un percorso con una risalita
- **GIVEN** un percorso che tenta di uscire dalla bacheca
- **THEN** NON SHALL essere fatta nessuna chiamata

#### Scenario: i tasti non ci stanno tutti
- **GIVEN** più tasti di quanti il sistema ne mostra
- **THEN** NON SHALL essere mostrato nessuno

### Requirement: NOTIF-HIST-01 — La cronologia degli avvisi non si sdoppia, e non stampa numeri finti

Una riga nuova SHALL andare in TESTA alla cronologia.

Una riga che QUESTA finestra ha appena scritto NON SHALL essere duplicata quando
torna indietro dal server: sono lo stesso avviso visto due volte.

L'età di un avviso SHALL scalare da «adesso» fino ai giorni.

Una data ILLEGGIBILE NON SHALL stampare un numero non-numerico: è la forma in cui
un difetto arriva fino agli occhi di chi guarda.

#### Scenario: l'eco della propria scrittura
- **GIVEN** un avviso scritto qui e rimandato dal server
- **THEN** SHALL comparire una volta sola

#### Scenario: una data illeggibile
- **GIVEN** un istante non interpretabile
- **THEN** NON SHALL comparire un valore non-numerico

### Requirement: QUIET-01 — Con «Non disturbare» acceso non si bussa, ma solo su una lettura VERA

Il cancello del silenzio SHALL leggere lo stato di concentrazione del sistema, che
sul web NON esiste: lo sa solo il guscio nativo e lo spinge dentro l'interfaccia.

Il difetto: gli avvisi di fine turno bussavano a ogni turno senza chiedersi se il
sistema fosse in concentrazione — si accende «Non disturbare» per lavorare e l'app
continua a suonare.

Il valore predefinito SHALL essere TRASPARENTE: senza ancora una lettura si avvisa
normalmente. Il silenzio SHALL scattare SOLO su una lettura POSITIVA e SUPPORTATA;
supportata ma senza concentrazione attiva SHALL avvisare; un ospite che NON
supporta la lettura NON SHALL MAI silenziare, nemmeno se dichiara di essere
attivo.

Una concentrazione che si spegne SHALL riaprire il cancello.

Un carico non booleano SHALL essere convertito senza AVVELENARE il cancello.

Il MOTIVO della lettura SHALL essere diagnosticabile: «file assente» NON SHALL
silenziare e NON SHALL essere un blocco — il cancello funziona; «negato» NON SHALL
silenziare mai, e il difetto sicuro resta; un guscio vecchio che manda solo i due
booleani SHALL ricadere sulla regola precedente; e un motivo SCONOSCIUTO NON SHALL
avvelenare il cancello. Fuori dal guscio nativo NON c'è niente da diagnosticare.

#### Scenario: un ospite che non supporta la lettura
- **GIVEN** un guscio che dichiara concentrazione attiva senza supportarla
- **THEN** NON SHALL essere silenziato niente

#### Scenario: permesso negato
- **GIVEN** una lettura rifiutata dal sistema
- **THEN** NON SHALL essere silenziato niente

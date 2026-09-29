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
SEMPRE. Solo un atto di VEDERE SHALL azzerarlo: la lettura esplicita che il
client manda dopo una permanenza continua sullo sguardo, oppure il «visto» della
sua notifica dato dalla persona nel pannello (clic sulla riga, «segna tutto»),
che passa dalla stessa porta del server (NOTIF-ONE-01).

Con UNA eccezione, e la parola «SEMPRE» sopra vale dentro quel confine: un topic
ARCHIVIATO NON SHALL prendere il badge, e il suo incremento NON SHALL essere
ANNUNCIATO — un annuncio fa ridisegnare a ogni client un badge che non esiste.

L'archiviazione azzera già il conteggio, quindi l'invariante sembrava chiusa: era
chiusa sul bordo dell'ARCHIVIAZIONE soltanto. Un messaggio arrivato DOPO rialzava
il badge su un topic che nessuno riaprirà. Misurato il 26/08/2026, tre settimane
dopo quel lavoro: **475** topic archiviati con un badge appeso, con l'ultima
lettura fino al 23/08. Un contatore riparato dove si scrive e mai dove si
incrementa è riparato sul bordo sbagliato.

La condizione «è archiviato» SHALL essere una dipendenza OBBLIGATORIA di chi
incrementa, non facoltativa: una condizione facoltativa vale «no» in ogni punto
di chiamata che la dimentica, ed è esattamente il silenzio che questa regola
chiude.

Un conteggio già accumulato su un topic archiviato NON SHALL essere ripulito da
chi incrementa — quella è una cura sul bordo sbagliato una seconda volta. Il
residuo storico si toglie una volta sola, e chi incrementa SHALL limitarsi a
smettere di produrlo.

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

#### Scenario: un messaggio su un topic archiviato
- **GIVEN** un topic archiviato
- **WHEN** arriva un messaggio
- **THEN** il non-letto NON SHALL crescere, e NESSUN annuncio SHALL partire

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

### Requirement: NOTIF-LOG-02 — Le due porte scrivono la STESSA chiave, o ogni consegna lascia due righe

La deduplica del registro funziona solo se le due porte — il banner del client e
la spinta del server — scrivono la STESSA stringa per lo STESSO evento. Se
divergessero, ogni consegna lascerebbe DUE righe e nessuno se ne accorgerebbe
leggendo il codice di una sola delle due parti.

Le chiavi SHALL essere STABILI e DISTINTE per famiglia.

Ciò che non è registrabile SHALL essere rifiutato. Un tipo SCONOSCIUTO NON SHALL
far buttare via la riga: SHALL declassarla. Un bersaglio a metà NON SHALL essere
un bersaglio.

Titolo e corpo SHALL essere TAGLIATI: è una lista, non un archivio di testi.

La sorgente SHALL valere «banner» salvo dichiarazione contraria.

Le rotte del bersaglio SHALL essere quelle dei collegamenti profondi. Il gruppo
predefinito SHALL essere il bersaglio, e senza bersaglio NON SHALL esserci
gruppo.

Il vocabolario dei tipi SHALL essere chiuso.

#### Scenario: la stessa consegna dalle due porte
- **GIVEN** un evento scritto dal banner e dalla spinta
- **THEN** SHALL produrre la stessa chiave, e una riga sola

#### Scenario: un tipo sconosciuto
- **GIVEN** un avviso di famiglia ignota
- **THEN** SHALL essere declassato, non scartato

### Requirement: NOTIF-ACT-01 — Un tasto su un avviso o fa esattamente quello che dice, o non c'è

Una domanda con delle opzioni SHALL produrre un tasto per opzione, etichettato col
TESTO dell'opzione. **Più opzioni del tetto SHALL produrre NESSUN tasto**: una
scelta troncata è peggio di nessuna scelta, perché sembra completa.

Una card in revisione SENZA domanda SHALL offrire lo stesso tasto della card. Una
domanda SENZA opzioni NON è una consegna da approvare: NESSUN tasto. Un elemento
parcheggiato SHALL offrire di rimetterlo in coda.

La decodifica SHALL reggere testi con caratteri che romperebbero un
identificativo ingenuo, e un identificativo sconosciuto o rotto SHALL valere
NIENTE, mai un'azione a caso.

Rispondere SHALL essere un rifiuto che PORTA il testo — è la semantica della
card. Approvare e rimettere in coda SHALL usare le porte della bacheca. Senza
progetto o senza task NON SHALL esserci richiesta.

**Ogni percorso composto SHALL passare il cancello di chi la richiesta la
riceve**: fuori dalla bacheca NON SHALL essere eseguito niente.

Il pacchetto pronto SHALL portare tasti e richieste GIÀ composte, in coppia, per
chi non sa decodificare; e senza riferimento al task SHALL essere VUOTO: nessun
tasto che non fa niente.

#### Scenario: più opzioni del tetto
- **GIVEN** una domanda con troppe opzioni
- **THEN** NON SHALL comparire nessun tasto

#### Scenario: un percorso fuori dalla bacheca
- **GIVEN** una richiesta composta verso un'altra superficie
- **THEN** NON SHALL essere eseguita

### Requirement: PUSH-03 — Per spegnere IL dispositivo giusto bisogna riconoscerlo

Sembra cosmesi e non lo è: l'elenco delle impostazioni serve a spegnere UN
dispositivo, e per spegnere quello giusto bisogna riconoscerlo. Il punto di
consegna non si può mostrare — è un indirizzo lunghissimo che cambia da solo —
quindi tutto il riconoscimento poggia su una riga di testo.

L'etichetta SHALL riconoscere i dispositivi noti. **Il tablet SHALL essere
riconosciuto PRIMA del computer**, perché da una certa versione un tablet si
dichiara come un computer.

Una dichiarazione che non dice niente SHALL dare la parola generica, non una
stringa tecnica: una stringa tecnica non si riconosce meglio di un indirizzo.

Il momento in cui aprire SHALL ammettere due valori soli, e tutto il resto SHALL
valere NIENTE — la rotta ci fa un rifiuto di richiesta.

Una riga SENZA preferenze scritte SHALL ricadere sui valori predefiniti, non su
un valore indefinito. Senza sapere CHI chiede, NESSUNA riga SHALL essere «questo
dispositivo».

#### Scenario: un tablet che si dichiara computer
- **GIVEN** una dichiarazione ambigua
- **THEN** SHALL essere riconosciuto come tablet

#### Scenario: una riga senza preferenze
- **GIVEN** nessuna preferenza scritta
- **THEN** SHALL valere i predefiniti

### Requirement: PUSH-04 — Ogni spinta porta a QUALCOSA, e tace su ciò che non è una notizia

La spinta di fine lavoro SHALL scattare quando un task entra in revisione,
portando il TITOLO e un'etichetta chiavata sul task — così una ri-emissione
SOSTITUISCE invece di impilare — e SHALL degradare con grazia senza titolo. Il
gesto SHALL portare AL TASK, non alla pagina iniziale; senza identificativo SHALL
ripiegare sulla pagina iniziale invece di costruire un indirizzo rotto. SHALL
restare MUTA per gli annunci che non la riguardano.

I tasti SHALL seguire la stessa regola della card: una domanda con opzioni dà i
suoi tasti; una consegna con la sola azione di pubblicazione tiene il titolo di
revisione e quel tasto; una domanda MISTA torna a essere una domanda; una
consegna senza domanda dà un tasto solo; una domanda con TROPPE opzioni dà
NESSUN tasto — **ma la spinta parte lo stesso**, perché la notizia vale anche
senza i tasti. Un elemento parcheggiato SHALL offrire di rimetterlo in coda.
Senza identificativo di task NON SHALL essere disegnato nessun tasto: non
saprebbe a chi parlare.

Un parcheggio SHALL distinguere i propri motivi: consegna mancata, richiesta di
intervento, e richiesta di una decisione sono TRE testi diversi, e degradano
senza titolo. Anche qui il gesto SHALL portare al task.

La fine PULITA di una conversazione SHALL mandare una spinta col nome
dell'argomento, con etichetta e indirizzo chiavati su di esso, e senza nome
risolto SHALL degradare a un titolo generico MANDANDO comunque.

SHALL essere MUTA su: un annullo, l'abbattimento del sorvegliante, un turno di
errore, l'assenza di identificativo dell'argomento, un argomento archiviato o
silenziato, e un argomento il cui PROGETTO è silenziato. Un argomento in un
progetto NON silenziato SHALL mandare.

Il cancello del silenzio SHALL parlare per un argomento sano in un progetto non
silenziato; SHALL tacere se archiviato o silenziato, qualunque sia il progetto;
SHALL tacere per un progetto silenziato, confrontando il percorso ESATTO — un
prefisso NON è il progetto; un argomento senza percorso NON SHALL essere toccato
dal silenzio di progetto; una lista assente o vuota SHALL valere nessun progetto
silenziato, sbagliando verso la spinta; e un argomento INESISTENTE SHALL tacere,
sbagliando verso il silenzio.

#### Scenario: una domanda con troppe opzioni
- **GIVEN** più opzioni del tetto
- **THEN** NON SHALL esserci tasti, e la spinta SHALL partire lo stesso

#### Scenario: un progetto con un percorso che è prefisso di uno silenziato
- **GIVEN** un percorso simile ma diverso
- **THEN** NON SHALL essere silenziato

### Requirement: SEEN-01

Il pallino di attenzione su una card di GRUPPO SHALL spegnersi quando la chat
che l'ha acceso viene letta, senza aspettare il messaggio successivo.

Il segnale grezzo non basta a deciderlo. Una fase come `awaiting-user` non si
spegne da sola: resta finche' non arriva un altro turno. Quindi l'unica cosa
che puo' abbassare quel pallino e' il segno di «visto», e il rollup del gruppo
SHALL applicare lo stesso cancello `seenSubjects` che il rollup di un pannello
di PROGETTO applicava gia'.

#### Scenario: la chat letta non tiene acceso il gruppo

- **WHEN** una chat dentro un gruppo finisce il turno e la card prende il
  pallino, e poi quella chat viene aperta e letta
- **THEN** la card del gruppo torna neutra insieme alla riga e alla tab, e non
  resta un'intestazione accesa sopra righe tutte calme

#### Scenario: il gruppo principale e' una card come le altre

- **WHEN** la chat letta sta nel gruppo principale invece che in uno spazio
- **THEN** vale la stessa regola: nessun ramo esente

### Requirement: SEEN-02

Il cancello del «visto» SHALL valere per il ramo delle chat e NON SHALL toccare
il ramo dei terminali.

Un terminale segnala per conto suo (un comando finito, un processo morto) e non
ha una nozione di lettura che coincida con quella di una chat. Spegnerlo col
segno di visto lo renderebbe muto su un evento che nessuno ha guardato.

#### Scenario: il ramo dei terminali resta intatto

- **WHEN** un terminale dentro un gruppo ha un segnale attivo e le chat dello
  stesso gruppo sono tutte lette
- **THEN** la card del gruppo resta accesa per il terminale

### Requirement: NOTIF-SEEN-01 — Una notifica il cui soggetto e' andato avanti NON SHALL restare accesa

Il contatore della campanella e quello del chrome (tray e icona dell'app: un
solo numero, una sola chiamata, non possono divergere fra loro) mostrano
lo STESSO numero (NOTIF-ONE-02): i soggetti che aspettano te e quelli con una
notifica non vista, ciascuno una volta. Il pannello elenca tutto cio' che quel
numero conta.

Il difetto e' che gli eventi non si spengono. Una notifica SHALL essere
considerata vista quando il fatto che la ha prodotta non e' piu' vero:

- un avviso di card in review, quando la card non e' piu' in `review`;
- un avviso di task parcheggiato, quando il task non attende piu' una risposta;
- l'avviso di un comando finito, che segnala un fatto transitorio.

Misurato il 29/08/2026: 400 righe non viste contro una decina di segnali vivi.
74 erano avvisi di card gia' approvate, 1 di un task gia' ripartito, 325 di
terminali finiti. `markTargetNotificationsSeen` esisteva gia' e le avrebbe
spente, ma in tutto il repository ha UN SOLO chiamante, e solo per i topic.

Cio' che e' ancora da guardare NON SHALL essere spento da un automatismo: una
correzione che spegne troppo ruba un avviso, e chi lo perde non ha modo di
sapere che c'era. Il «segna tutto» della persona e' un atto di vedere, non un
automatismo, e spegne tutto cio' che il pannello elencava.

#### Scenario: la card e' stata approvata tre settimane fa
- **WHEN** una riga `task-review` punta a un task che non e' piu' in `review`
- **THEN** SHALL risultare vista

#### Scenario: la card e' ancora in attesa
- **WHEN** una riga `task-review` punta a un task ancora in `review`
- **THEN** NON SHALL essere toccata

#### Scenario: il comando e' appena finito
- **WHEN** un avviso di sessione e' piu' recente della finestra di grazia
- **THEN** NON SHALL essere spento: e' ancora una notizia

### Requirement: CHROME-COUNT-01 — Un numero solo per il dock, la tray e l'icona, ed e' quello della sidebar

Il numero che Topics dipinge sul sistema operativo (badge dell'icona, glifo
nella barra dei menu, Badging API della PWA) SHALL essere il risultato di UNA
funzione pura, e quella funzione SHALL essere l'unico posto dove quel numero
esiste.

Il criterio e' uno: QUANTE COSE STANNO CHIEDENDO QUALCOSA A UN UMANO. Le chat
non lette, ferme in attesa o finite (segno «done»), i terminali che hanno finito, le card della board
che aspettano una decisione. Cose, non messaggi (NOTIF-ONE-02). Il lavoro che
gira da solo non entra, e un topic ARCHIVIATO non entra mai.

Il numero SHALL coincidere con il numero di righe di sidebar che mostrano un
badge per gli stessi soggetti, piu' le card in review, piu' i soggetti con una
notifica non vista che non hanno gia' un badge; e la parita' SHALL essere provata
calcolando l'attesa dagli stessi aiutanti per-riga, non da un numero scritto a
mano.

#### Scenario: le due superfici sullo stesso stato
- **WHEN** un insieme di topic, terminali e card, senza notifiche non viste, produce il conteggio del chrome
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

### Requirement: NOTIF-PERM-01 — Il permesso di sistema si legge E si concede da dentro l'app

Il pannello Impostazioni SHALL dire lo stato vero della catena dei banner
nativi e SHALL offrire l'azione che quello stato consente. Uno stato in sola
lettura lascia la persona davanti a una diagnosi senza porta: «non arrivano»,
e poi?

L'azione dipende dallo stato, e non SHALL essercene una che non fa niente:

- non ancora deciso: SHALL chiedere il permesso al sistema;
- negato: macOS non ripropone il prompt, quindi SHALL aprire il pannello
  Impostazioni di Sistema → Notifiche;
- concesso, fuori dal bundle .app, o fuori da macOS: nessun tasto, perche' non
  c'e' niente che un tasto possa cambiare.

Dopo l'azione il pannello SHALL rileggere lo stato: seguire il consiglio e
vedere la stessa diagnosi di prima e' indistinguibile dal non aver fatto nulla.

#### Scenario: permesso mai chiesto
- **WHEN** lo stato e' «non ancora deciso»
- **THEN** il tasto SHALL chiedere il permesso al sistema

#### Scenario: permesso negato
- **WHEN** lo stato e' «negato»
- **THEN** il tasto SHALL portare al pannello di sistema, non a un secondo prompt che non comparira'

#### Scenario: niente da fare
- **WHEN** il permesso e' concesso, o l'app non gira da un bundle, o non e' macOS
- **THEN** NON SHALL comparire nessun tasto

### Requirement: CHAT-DONE-01 — Una chat che ha finito resta segnata come un terminale che ha finito

Una chat il cui turno finisce pulito (`stream:end` che `isCleanChatTurnEnd`
accetta: `completed`, non `dispatched`, non annullato) SHALL accendere un segno
«finito», qualunque sia il runtime, con o senza hook Claude Code. Il segno SHALL
dipingersi sulla riga della sidebar e sulla tab con lo stesso tier `done`
(«turno finito») di un terminale che ha finito, e le due superfici SHALL
esporlo come `data-attention="done"`.

Il segno SHALL spegnersi quando la chat viene aperta (è la pane attiva col
fuoco), quando si clicca la sua riga (anche se la chat la tiene un'altra
finestra, dove il clic porta avanti quella finestra) o quando comincia un nuovo turno (`stream:start`). Se la chat è già
davanti quando il turno finisce, il segno NON SHALL restare acceso. Come quello
dei terminali, vive in memoria: un ricarico della pagina riparte senza.

#### Scenario: chat senza hook che finisce dietro un'altra tab
- **GIVEN** una chat senza hook aperta in una tab, e un'altra tab attiva
- **WHEN** il suo turno finisce pulito
- **THEN** la sua tab e la sua riga SHALL avere `data-attention="done"`

#### Scenario: aprire la chat spegne il segno
- **WHEN** la tab della chat segnata viene attivata
- **THEN** tab e riga NON SHALL avere più `data-attention`

#### Scenario: la riga di una chat tenuta da un'altra finestra si spegne al clic
- **GIVEN** una chat tenuta da un'altra finestra, segnata `done` sulla riga di questa
- **WHEN** si clicca la sua riga, che porta avanti l'altra finestra senza aprire niente qui
- **THEN** la riga NON SHALL avere più `data-attention`

#### Scenario: una chat con gli hook non perde il segno dopo 15 minuti
- **GIVEN** una chat con hook finita e mai aperta
- **WHEN** la fase passa da `awaiting-user` a `completed`
- **THEN** il segno SHALL restare finché la chat non viene aperta

#### Scenario: un turno fermato non è un turno finito
- **WHEN** arriva `stream:end` con `reason: user_abort` o `dispatched: true`
- **THEN** NON SHALL accendersi nessun segno

### Requirement: CHAT-DONE-02 — Una chat che ha finito suona una volta, qualunque runtime e quante che siano le finestre

Un `stream:end` pulito SHALL alzare un banner di sistema anche per una chat senza
hook e con la finestra visibile dietro un'altra app, con gli stessi cancelli
degli altri percorsi (interruttore, silenzio, archiviata, agente di board, chat
davanti con la finestra a fuoco). Il banner SHALL claimare la stessa chiave del
banner di `message:new` per la risposta dello stesso turno (il suo `messageId`),
così due finestre, una nascosta e una visibile, alzano UN banner.

#### Scenario: due finestre, un banner
- **GIVEN** la finestra B nascosta e la finestra A visibile dietro un'altra app
- **WHEN** B claima il banner su `message:new` e A su `stream:end` dello stesso turno
- **THEN** solo una delle due SHALL consegnarlo

#### Scenario: i turni che non sono una fine non suonano
- **WHEN** un'altra chat riceve `stream:end` con `dispatched: true` o `reason: user_abort`
- **THEN** NON SHALL alzarsi un banner per quella chat

### Requirement: NOTIF-ONE-01 — Un solo «visto» per soggetto, e vederlo ovunque lo spegne ovunque

Una chat e un terminale SHALL avere un solo stato di «visto». Aprire la chat,
cliccare una sua notifica nel pannello o aprire il pannello (che segna viste
tutte le righe della lista) SHALL passare dalla stessa porta lato server, che
azzera il non-letto della chat E segna viste le sue righe, e lo annuncia a ogni
finestra con `unread:updated` e `notification:seen`.

Aprire il pannello SHALL spegnere esattamente ciò che il pannello elencava: le
righe fino alla più recente letta, con le chat dietro di esse, e le chat e i
terminali sotto «Aspettano te» (anche una chat con non-letti e nessuna riga non
vista, il segno «finito» di un terminale, il segno «done» di una chat). NON
SHALL spegnere ciò che non ha mostrato: una chat silenziata (MUTE-01) o zittita
dal Non disturbare non ha righe, e i suoi messaggi arrivati dopo la lettura
della lista restano non letti. SHALL risparmiare anche i soggetti elencati con
una notifica arrivata DOPO la lista letta: quella non è stata vista.

Il frame `notification:seen` SHALL nominare i soggetti spenti (`subjects`: la
chiave di gruppo, o l'id di una riga senza gruppo), così ogni finestra spegne i
propri segni in memoria e i pallini delle sole righe nominate.

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

#### Scenario: una chat silenziata che il pannello non ha mostrato
- **GIVEN** il pannello si apre, e il suo «segna tutto» non è ancora applicato
- **WHEN** una chat silenziata riceve 3 messaggi (nessun banner, nessuna riga)
- **THEN** il «segna tutto» NON SHALL azzerarne il non-letto, e la chat SHALL restare contata e elencata

#### Scenario: aprire una chat con il non-letto già a zero
- **WHEN** si apre una chat che ha righe non viste e non-letto zero
- **THEN** il client SHALL mandare il «visto» della chat anche senza non-letti, e le sue righe SHALL essere segnate viste

### Requirement: NOTIF-ONE-02 — I numeri globali contano soggetti, non messaggi

Il numero globale (Dock, tray, badge PWA) e il numero della campanella SHALL
essere LO STESSO numero, calcolato da una funzione sola: i SOGGETTI in attesa
(una chat vale 1 qualunque sia il numero dei suoi messaggi, un terminale finito
1, una chat finita col segno «done» 1, una pane con badge 1, una card in review
1) uniti ai soggetti con una
notifica non vista, ognuno una volta sola. Due righe dello stesso gruppo sono
una cosa sola; una chat con non letti e con la sua notifica è una cosa sola. Le
righe e le tab POSSONO continuare a mostrare il numero dei messaggi della chat.

Il pannello SHALL elencare sotto «Aspettano te» ogni soggetto contato che la
cronologia non mostra già con un pallino, e SHALL dire «Nessuna notifica» solo
quando non c'è niente né lì né nella cronologia.

#### Scenario: due chat, sei messaggi
- **WHEN** una chat ha 4 non letti e un'altra 2, ognuna con la sua notifica
- **THEN** il numero globale e la campanella SHALL dire 2

#### Scenario: una card in review senza notifica
- **WHEN** una card entra in review e nessuna riga del registro la nomina
- **THEN** il numero globale e la campanella SHALL contarla 1, e aprendo il pannello la card SHALL comparire sotto «Aspettano te» e non SHALL comparire «Nessuna notifica»

#### Scenario: una chat che ha finito, senza righe e senza non-letti
- **WHEN** una chat senza hook finisce il turno e porta il segno «done», senza riga né non-letti
- **THEN** il numero globale e la campanella SHALL contarla 1, il pannello SHALL elencarla sotto «Aspettano te», e il «segna tutto» SHALL spegnerne il segno in ogni finestra

#### Scenario: una chat che ti aspetta, con le righe già viste
- **WHEN** una chat è ferma in attesa di te e tutte le sue righe sono viste
- **THEN** il numero globale e la campanella SHALL contarla 1, e il pannello SHALL elencarla sotto «Aspettano te»

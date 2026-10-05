## Purpose

Specifies behavioral scenarios for the unified attention system: the numeric badge that
one topic shows on every surface at once (pane tab, sidebar row, OS app badge), the
per-topic mute that silences the interruption without hiding the count, and the parity
contract that keeps those surfaces from drifting apart.

## Background

Common preconditions shared across scenarios:

- The user is logged into Topics App and the sidebar is visible
- Attention reaches the client as WebSocket frames: `attention:init` at every open of
  the socket and `attention:updated` for one subject, with its unread count on the row
- A badge count is read from a single rollup (`getBadgeCount` in
  `client/src/hooks/useTabNotifications.tsx`), never from a per-surface counter

## Requirements

### Requirement: TAB-BADGE-01 — Unread badge on an inactive chat tab

The system SHALL render a numeric badge on an inactive chat tab only while the topic's
attention subject is lit (`needs-you`, or `finished` not seen: ATTN-01), and its text
SHALL be `max(1, unread)`, both read from the same `attention:*` frame. A topic that is
not lit (`idle`, `working` with or without a job left running, seen) SHALL NOT have a badge, whatever its
unread count: unread raised by a woken turn in background, a system message or an edit
waits for the subject to light up.

#### Scenario: Unread count paints a badge on the inactive tab
- **GIVEN** two topics A and B are open as pane tabs and B is the active tab
- **WHEN** the server sends `attention:updated` for topic A as `finished(done)` with an unread count of 3
- **THEN** A's pane tab shows a badge whose text is exactly "3"

#### Scenario: A lit topic with no unread still shows one
- **WHEN** topic A is `needs-you(question)` with an unread count of 0
- **THEN** A's inactive pane tab shows a badge whose text is exactly "1"

#### Scenario: Unread in background paints nothing
- **WHEN** topic A is `working` on a job left running, with an unread count of 2
- **THEN** no badge element is rendered inside A's tab

### Requirement: TAB-BADGE-02 — Badge clears when the tab is activated

The system SHALL remove the badge from a tab once the topic's unread count returns to
zero after the user activates that tab.

> Written from the test: the E2E stages the lit `attention:updated` frame itself, and
> the click on the tab is the seen, so what is pinned is the client's rendering of a
> subject seen on activation.

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
- **WHEN** the server sends `attention:updated` for topic A as `finished` with an unread count of 2
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

The system SHALL show the same number for a topic on its pane tab and on its sidebar row,
computed by the same `attentionOf` from the same frame, and SHALL NOT render the retired
per-Claude phase dot on any surface — the phase signal is folded into the attention tier.

#### Scenario: One unread event paints both surfaces with the same number
- **GIVEN** topics A and B are open as pane tabs and B is active, leaving A unfocused on both surfaces
- **WHEN** the server sends `attention:updated` for topic A as `finished(done)` with an unread count of 2
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

### Requirement: PUSH-05 — Il telefono si iscrive con un tocco, e ogni spinta lascia una riga

Il service worker SHALL registrarsi su OGNI origine sicura fuori dal guscio
desktop, non solo su `localhost`: il telefono non arriva mai come `localhost`, e
senza worker non esiste nessuna iscrizione. Un worker assente NON SHALL tenere
appeso il tocco su «Attiva»: il tocco SHALL registrarlo da sé, e una
registrazione che fallisce SHALL essere DETTA nella card, con il rimedio, invece
di sembrare «non iscritto».

Il tocco su «Attiva su questo dispositivo» SHALL chiedere il permesso DENTRO il
gesto, iscrivere il dispositivo e lasciare la riga sul server; la riga SHALL
sopravvivere a un ricarico della app. Togliere l'iscrizione SHALL togliere
quella riga e nessun'altra.

Ogni spinta SHALL essere una richiesta FIRMATA (VAPID) e CIFRATA per quel solo
dispositivo, con il suo momento-in-cui-aprire dentro. Il registro SHALL avere
una riga per ogni consegna, per ogni rifiuto — con la ragione del servizio di
consegna — e per ogni iscrizione scaduta, che SHALL sparire dalla tabella; e
SHALL dire quando non c'è NESSUN dispositivo a cui mandare, invece di tacere.

Una chat che ASPETTA te (una domanda, un piano da approvare, un permesso) SHALL
mandare una spinta all'ENTRATA nell'attesa, col nome dell'argomento e la
domanda, con le stesse regole di silenzio della fine risposta; la stessa attesa
ripetuta NON SHALL mandarne una seconda. Una pagina iscritta NON SHALL
aggiungere il proprio banner a quella spinta.

#### Scenario: il telefono su un indirizzo che non è localhost
- **GIVEN** la app aperta su un'origine sicura diversa da `localhost`
- **WHEN** si tocca «Attiva su questo dispositivo» e si concede il permesso
- **THEN** la riga SHALL comparire sul server, e dopo un ricarico il worker SHALL esserci ancora

#### Scenario: nessun dispositivo iscritto
- **GIVEN** zero iscrizioni consegnabili
- **THEN** il registro SHALL dirlo con una riga, senza nessuna richiesta in uscita

#### Scenario: la stessa attesa ritrasmessa
- **GIVEN** una chat in attesa la cui fase viene ritrasmessa
- **THEN** SHALL partire una spinta sola; una domanda NUOVA dopo la ripresa SHALL mandarne un'altra

### Requirement: SEEN-01

Il pallino di attenzione su una card di GRUPPO SHALL spegnersi quando la chat
che l'ha acceso viene letta, senza aspettare il messaggio successivo.

La card del gruppo SHALL derivare da `rollupAttention` dei suoi figli, come la riga
e la tab di progetto: il «visto» che la spegne è quello del server (ATTN-06), non un
cancello `seenSubjects` della finestra, che resta solo come ottimismo locale.

#### Scenario: la chat letta non tiene acceso il gruppo

- **WHEN** una chat dentro un gruppo finisce il turno e la card prende il
  pallino, e poi quella chat viene aperta e letta
- **THEN** la card del gruppo torna neutra insieme alla riga e alla tab, e non
  resta un'intestazione accesa sopra righe tutte calme, in ogni finestra

#### Scenario: il gruppo principale e' una card come le altre

- **WHEN** la chat letta sta nel gruppo principale invece che in uno spazio
- **THEN** vale la stessa regola: nessun ramo esente

### Requirement: SEEN-02

Il segno «finito» di un terminale, con o senza hook, SHALL essere lo stato di
attenzione `finished` del suo soggetto, e SHALL spegnersi col visto del server
(ATTN-06), sulla tab, sulla riga, sul rollup di progetto e sulla card del gruppo
insieme. Una richiesta di permesso (`needs-you(permission)`) SHALL invece tenerli
accesi anche se il terminale è stato visto. Nessun cancello per finestra SHALL
filtrare il segno, quindi il secondo turno finito di una sessione senza hook SHALL
riaccenderlo con un'epoca nuova.

#### Scenario: il ramo dei terminali resta acceso per ciò che nessuno ha visto

- **WHEN** un terminale dentro un gruppo ha un turno finito non ancora visto
  e le chat dello stesso gruppo sono tutte lette
- **THEN** la card del gruppo resta accesa per il terminale

#### Scenario: un terminale fermo su una fase, già guardato

- **WHEN** un terminale claude-code del gruppo ha finito il turno ed è stato visto
- **THEN** la card del gruppo torna neutra insieme alla sua tab e alla sua riga,
  e una richiesta di permesso (`awaiting-approval`) la tiene invece accesa

#### Scenario: il secondo turno di un terminale senza hook

- **GIVEN** un terminale senza hook il cui primo turno finito è stato visto
- **WHEN** finisce un secondo turno, con la pane non a fuoco
- **THEN** tab, riga e card del gruppo SHALL riaccendersi blu

### Requirement: NOTIF-SEEN-01 — Una notifica il cui soggetto e' andato avanti NON SHALL restare accesa

Una riga di cronologia SHALL risultare vista quando il suo soggetto non è più acceso per
l'epoca che l'ha scritta: la card uscita da review, la card parcheggiata rimessa in coda,
cancellata o archiviata, la chat vista, il topic archiviato. Lo fa la porta del visto e la
transizione del soggetto, sul server, nello stesso passo. Le righe NON SHALL entrare in
nessun numero (NOTIF-ONE-02): il pallino in «Cronologia» è l'unico segno che danno.

Ciò che è ancora acceso NON SHALL essere spento da un automatismo.

#### Scenario: la card e' stata approvata tre settimane fa
- **WHEN** una riga `task-review` punta a una card approvata tre settimane fa
- **THEN** SHALL risultare vista, segnata dalla transizione dell'approvazione, e NON SHALL contare

#### Scenario: la card parcheggiata e' ripartita
- **WHEN** una card parcheggiata viene rimessa in coda
- **THEN** la sua riga `task-parked` SHALL risultare vista

#### Scenario: il comando e' appena finito
- **GIVEN** un terminale che ha appena finito, non visto
- **THEN** la sua riga NON SHALL essere spenta finché il terminale non viene visto

#### Scenario: la card e' ancora in attesa
- **WHEN** una riga `task-review` punta a una card ancora in `review`
- **THEN** NON SHALL essere toccata

### Requirement: CHROME-COUNT-01 — Un numero solo per il dock, la tray e l'icona, ed e' quello della sidebar

Il numero che Topics dipinge sul sistema operativo (badge dell'icona, glifo nella barra
dei menu, Badging API della PWA) SHALL essere il risultato di UNA funzione pura sullo stato
di attenzione: il numero di soggetti accesi non archiviati. Il lavoro che gira da solo
(`working`, anche quando aspetta un lavoro in background) non entra, un topic archiviato non entra mai, e le righe di
cronologia non entrano.

Il numero SHALL coincidere con le righe di sidebar che mostrano un tier acceso più il
numero della tab board generale (ATTN-16), per gli stessi soggetti, provato calcolandolo
dagli stessi aiutanti. Il menu della tray SHALL elencare i soggetti che il suo numero
conta: chat e terminali fino a otto righe, e le card nei gruppi della board. Sul desktop
lo SHALL scrivere solo la finestra principale (ATTN-08).

#### Scenario: la tray elenca la chat finita che conta
- **GIVEN** una chat `finished(done)`, una `finished(error)` e una `needs-you(permission)`
- **WHEN** si compone il menu della tray
- **THEN** SHALL avere tre righe di chat, come il numero

#### Scenario: le due superfici sullo stesso stato
- **WHEN** un insieme di chat, terminali e card produce il conteggio del chrome
- **THEN** quel numero SHALL essere uguale alle righe di sidebar con un tier acceso più il numero della tab board generale

#### Scenario: la tray elenca anche il terminale e la card
- **GIVEN** un terminale `finished(done)` e una card parcheggiata
- **THEN** il numero SHALL essere 2, e la tray SHALL elencare il terminale e, nel gruppo della board, la card

#### Scenario: la chat letta
- **WHEN** una chat accesa viene vista
- **THEN** il totale SHALL calare di uno, senza toccare gli altri

#### Scenario: un topic archiviato con non letti
- **GIVEN** un topic archiviato con non letti e una riga non vista
- **THEN** SHALL contare zero, e la tray NON SHALL elencarlo

#### Scenario: archiviato in vista, con «mostra archiviati» acceso
- **WHEN** la riga di un topic archiviato con non letti compare in sidebar
- **THEN** SHALL portare badge zero e nessun `data-attention`, come il chrome

#### Scenario: una chat in background
- **THEN** SHALL contare zero

#### Scenario: niente da mostrare
- **WHEN** non c'e' nessun soggetto acceso
- **THEN** il totale SHALL essere zero, che e' il badge spento

### Requirement: NOTIF-PERM-01 — Il permesso di sistema si legge E si concede da dentro l'app

Il livello Notifiche del menu utente (USERMENU-03), che prende il posto della
voce Notifiche del pannello Impostazioni, SHALL dire lo stato vero della catena
dei banner nativi e SHALL offrire l'azione che quello stato consente. Uno stato
in sola lettura lascia la persona davanti a una diagnosi senza porta: «non
arrivano», e poi?

L'azione dipende dallo stato, e non SHALL essercene una che non fa niente:

- non ancora deciso: SHALL chiedere il permesso al sistema;
- negato: macOS non ripropone il prompt, quindi SHALL aprire il pannello
  Impostazioni di Sistema → Notifiche;
- concesso, fuori dal bundle .app, o fuori da macOS: nessun tasto, perche' non
  c'e' niente che un tasto possa cambiare.

Dopo l'azione il livello SHALL rileggere lo stato: seguire il consiglio e
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

#### Scenario: la casa del permesso
- **WHEN** apro il menu utente sul livello Notifiche
- **THEN** lo stato del permesso e il suo tasto sono lì
- **AND** il pannello Impostazioni non ha una voce Notifiche

### Requirement: CHAT-DONE-01 — Una chat che ha finito resta segnata come un terminale che ha finito

Una chat il cui turno finisce con un messaggio visibile, senza compiti in background e
fuori da un'attesa (ATTN-02, ATTN-04, ATTN-05) SHALL entrare in `finished(done)`,
qualunque sia il runtime, con o senza hook Claude Code. Il segno SHALL dipingersi sulla
riga della sidebar e sulla tab con lo stesso tier `done` di un terminale che ha finito, e
le due superfici SHALL esporlo come `data-attention="done"`.

Il segno è lo stato di attenzione del server, non una memoria della finestra: SHALL
essere uguale in ogni finestra e dispositivo e dopo un ricarico. SHALL spegnersi col
visto (ATTN-06): la chat a fuoco per la soglia, il clic sulla sua riga quando la tiene
un'altra finestra, l'apertura dalla inbox. Un turno nuovo lo porta in `working`.

Se la chat è a fuoco in una finestra sveglia quando il turno finisce, l'epoca SHALL
nascere vista: niente numero, niente riga non vista, niente movimento del Dock. Una chat
a fuoco in una finestra dietro un'altra app non è davanti a nessuno: SHALL accendersi e
contare, e spegnersi quando la finestra torna davanti e passa la soglia.

#### Scenario: chat senza hook che finisce dietro un'altra tab
- **GIVEN** una chat senza hook aperta in una tab, e un'altra tab attiva
- **WHEN** il suo turno finisce pulito, senza compiti in background
- **THEN** la sua tab e la sua riga SHALL avere `data-attention="done"`

#### Scenario: la chat davanti che finisce non muove il numero del Dock
- **GIVEN** una chat senza hook a fuoco, in una finestra sveglia
- **WHEN** finiscono cinque suoi turni
- **THEN** le righe di cronologia SHALL essere già viste e il Dock NON SHALL cambiare
- **WHEN** la finestra passa dietro un'altra app e un turno finisce
- **THEN** il numero SHALL salire di uno, e SHALL tornare giù quando la finestra torna davanti

#### Scenario: aprire la chat spegne il segno
- **WHEN** la tab della chat segnata viene attivata e resta a fuoco per la soglia
- **THEN** tab e riga NON SHALL avere più `data-attention`

#### Scenario: la riga di una chat tenuta da un'altra finestra si spegne al clic
- **GIVEN** una chat tenuta da un'altra finestra, segnata `done` sulla riga di questa
- **WHEN** si clicca la sua riga, che porta avanti l'altra finestra senza aprire niente qui
- **THEN** la riga NON SHALL avere più `data-attention`, in nessuna finestra

#### Scenario: una chat con gli hook non perde il segno dopo 15 minuti
- **GIVEN** una chat con hook finita e mai vista
- **WHEN** la fase passa da `awaiting-user` a `completed`
- **THEN** il segno SHALL restare finché la chat non viene vista

#### Scenario: aperta in una finestra, si spegne anche nell'altra
- **GIVEN** due finestre, e in entrambe una chat segnata `done`
- **WHEN** la chat viene vista nella finestra A
- **THEN** la sua riga NON SHALL avere più `data-attention` né in A né in B

#### Scenario: il ricarico non riaccende
- **GIVEN** una chat finita e già vista
- **WHEN** la finestra si ricarica
- **THEN** la chat NON SHALL avere `data-attention`

#### Scenario: un turno che lascia lavoro in background non è finito
- **WHEN** arriva `stream:end` con `background.count > 0`
- **THEN** NON SHALL accendersi nessun segno

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

Una chat, un terminale e una card SHALL avere un solo stato di «visto», l'ultima epoca
vista sul server (ATTN-06). Guardare la pane a fuoco per la soglia, aprire una voce della
inbox, «Segna visto» e «Segna tutte viste» SHALL passare dalla stessa porta, che alza
l'epoca vista, azzera il non-letto della chat, segna viste le sue righe di cronologia e
lo annuncia a ogni finestra e dispositivo con `attention:updated`.

Aprire la inbox NON SHALL segnare niente. «Segna tutte viste» SHALL spegnere esattamente
le `Finite` che la inbox mostrava, alle epoche mostrate: NON SHALL spegnere un'epoca
arrivata dopo, e NON SHALL spegnere un `needs-you`.

#### Scenario: una notifica di chat vista nel pannello
- **WHEN** si apre dalla inbox una chat finita con 4 non letti
- **THEN** il non-letto della chat SHALL essere zero, e la sua riga, la sua tab e il numero globale SHALL calare insieme su ogni dispositivo

#### Scenario: una notifica più nuova della lista letta
- **WHEN** un'epoca nuova arriva dopo che la inbox ha mostrato la lista
- **THEN** «Segna tutte viste» NON SHALL spegnerla

#### Scenario: il pannello aperto su una chat ferma
- **GIVEN** una chat finita con 3 non letti e nessuna riga non vista
- **WHEN** si apre la inbox e la si chiude senza toccare niente
- **THEN** il suo non-letto SHALL restare 3, e la chat SHALL restare nelle `Finite` e contata

#### Scenario: una chat silenziata che il pannello non ha mostrato
- **GIVEN** la inbox aperta, e il suo «Segna tutte viste» non ancora premuto
- **WHEN** una chat silenziata finisce un turno (nessun banner)
- **THEN** «Segna tutte viste» NON SHALL spegnerla, perché la sua epoca è arrivata dopo la lista
- **AND** una chat silenziata già mostrata nelle `Finite` SHALL spegnersi come le altre

#### Scenario: aprire una chat con il non-letto già a zero
- **WHEN** si guarda una chat `finished` con non-letto zero
- **THEN** il visto SHALL partire lo stesso e la chat SHALL spegnersi ovunque

### Requirement: NOTIF-ONE-02 — I numeri globali contano soggetti, non messaggi

Il numero globale (Dock, tray, badge PWA) e il numero della inbox SHALL essere LO STESSO
numero: i soggetti accesi (ATTN-01), ognuno una volta sola, qualunque sia il numero dei
suoi messaggi o delle sue righe di cronologia. Una card in review o parcheggiata vale 1.
Le righe di cronologia NON SHALL entrare nel numero. Le righe e le tab POSSONO mostrare il
numero dei messaggi della chat accesa.

La inbox SHALL elencare ogni soggetto contato, e SHALL dire «Niente da guardare» solo
quando non ce n'è nessuno.

#### Scenario: due chat, sei messaggi
- **WHEN** una chat finita ha 4 non letti e un'altra 2
- **THEN** il numero globale e la inbox SHALL dire 2

#### Scenario: una card in review senza notifica
- **WHEN** una card entra in review e nessuna riga del registro la nomina
- **THEN** il numero globale e la inbox SHALL contarla 1, e la card SHALL comparire sotto «Ti aspettano»

#### Scenario: una chat che ha finito, senza righe e senza non-letti
- **WHEN** una chat senza hook finisce il turno, senza riga né non-letti
- **THEN** il numero globale e la inbox SHALL contarla 1, e «Segna tutte viste» SHALL spegnerla su ogni dispositivo

#### Scenario: una chat che ti aspetta, con le righe già viste
- **WHEN** una chat è ferma su una domanda (`needs-you(question)`) e tutte le sue righe sono viste
- **THEN** il numero globale e la inbox SHALL contarla 1, e la inbox SHALL elencarla sotto «Ti aspettano»

#### Scenario: una chat letta ferma su `awaiting-user`
- **WHEN** una chat finita è stata vista e la sua fase resta `awaiting-user`
- **THEN** il numero globale e la inbox NON SHALL contarla

#### Scenario: righe vecchie non viste
- **GIVEN** 300 righe non viste nel registro di soggetti già spenti
- **THEN** il numero SHALL essere quello dei soggetti accesi, e le righe SHALL stare solo in «Cronologia»

### Requirement: SEEN-ANY-FOCUS-01 — Una pane è vista quando è LA pane a fuoco della finestra, da qualunque gesto ci si arrivi

Il «visto» di una pane SHALL avere una definizione sola: la pane è quella a
fuoco della finestra (la pane attiva del gruppo a fuoco, o la pane interna a
fuoco della finestra di progetto a fuoco), con la finestra sveglia, per
SEEN_DWELL_MS continui. Qualunque gesto la porti a fuoco SHALL valere uguale:
il clic sulla tab, un clic o un tocco DENTRO la pane, la tastiera, la palette,
la riga della sidebar.

Quell'unico evento SHALL spegnere insieme ogni segno di quella pane: il segno
«finito» di un terminale (e le sue righe nel registro), il segno «done» di una
chat (e nelle altre finestre, dalla porta del visto), il fill blu di una fase
`awaiting-user`. Ogni superficie SHALL leggere quegli stessi segni: la tab, la
riga della sidebar, il rollup di progetto, la card del gruppo, la campanella e
il Dock. Nessuna superficie SHALL avere uno spegnimento suo (la tab che spegneva
il terminale solo al proprio clic, la pane terminale che lo spegneva appena
visibile). Fa eccezione la riga di una chat tenuta da UN'ALTRA finestra: qui
nessuna pane la mostra, e il clic che porta avanti quella finestra è lo sguardo.

Una pane è davanti anche senza un fuoco che la nomini: con nessuna pane a
fuoco (un dispositivo nuovo, dopo un trascinamento) il gruppo disegna la sua
tab attiva come a fuoco, e quella pane SHALL contare come la pane a fuoco. La
chat del coordinatore aperta nel cassetto della board SHALL contare come la
pane a fuoco quando lo è la board.

Le richieste di risposta (`awaiting-approval`, una domanda aperta) e il
non-letto restano fuori: la prima si spegne rispondendo, e SHALL restare ambra
su OGNI superficie (tab, riga, card del gruppo, rollup di progetto) anche
quando la pane è stata vista; il secondo ha la sua porta (il ping `focus`),
armata dalla stessa chat a fuoco con la stessa soglia e riarmata, come il
visto, quando la finestra torna davanti.

#### Scenario: una pane visibile ma non a fuoco tiene il suo segno
- **GIVEN** una chat e un terminale finiti, ognuno visibile nella sua cella di
  uno split, con il fuoco su un'altra cella
- **WHEN** passa più di una soglia di visto
- **THEN** la tab, la riga e la campanella SHALL mostrare ancora entrambi i segni

#### Scenario: un clic dentro la pane la vede
- **WHEN** si clicca DENTRO la chat (non sulla sua tab)
- **THEN** dopo la soglia il suo segno SHALL sparire dalla tab, dalla riga e
  dalla campanella insieme, e il terminale SHALL tenere il suo
- **WHEN** si clicca dentro il terminale
- **THEN** il suo segno SHALL sparire dalla riga, dalla campanella e, lasciato
  il fuoco, dalla tab

#### Scenario: un permesso in attesa sulla chat a fuoco
- **GIVEN** la chat a fuoco passa in `awaiting-approval`
- **WHEN** passa più di una soglia di visto con la finestra sveglia
- **THEN** la tab, la riga e la card del gruppo SHALL mostrare tutte l'ambra

#### Scenario: la finestra torna davanti alla chat a fuoco
- **GIVEN** la chat a fuoco riceve un messaggio e finisce un turno mentre la
  finestra è dietro
- **WHEN** la finestra torna davanti e resta sulla chat per la soglia
- **THEN** la campanella e il Dock SHALL non contarla più, e lasciata la chat
  né la sua riga né la sua tab SHALL avere un badge

#### Scenario: la riga di banner di un terminale senza segno «finito»
- **GIVEN** un terminale claude-code guidato dagli hook, che non riceve mai il
  segno «finito» (la sua attenzione passa dalla fase), con una riga di banner
  non vista raggruppata sotto `terminal:<id>`
- **WHEN** lo si porta a fuoco dalla sua tab, o dalla sua riga della sidebar
- **THEN** dopo la soglia la riga SHALL risultare vista e la campanella (e il
  Dock) SHALL non contarla più, anche se il terminale era già stato visto prima

### Requirement: SEEN-ANY-FOCUS-02 — La pane a fuoco quando il suo turno finisce non resta segnata

Una pane che è già quella a fuoco quando il suo turno finisce NON SHALL restare
segnata su nessuna superficie. Un turno pulito di una chat e il segno «finito»
di un terminale SHALL non accendersi affatto; una fase che torna su
`awaiting-user` sotto gli occhi della persona MAY accendere il fill per la
soglia e SHALL spegnersi da sola dopo, senza bisogno di un altro gesto.

#### Scenario: una chat a fuoco riparte e si ferma di nuovo
- **GIVEN** una chat vista, a fuoco da un clic al suo interno
- **WHEN** la sua fase passa a `running` e torna su `awaiting-user`
- **THEN** il fill blu SHALL sparire dalla tab e dalla riga dopo la soglia

#### Scenario: un terminale a fuoco finisce un turno
- **WHEN** un terminale a fuoco segnala un turno finito
- **THEN** né la riga né la tab (lasciato il fuoco) SHALL mostrare un badge per lui
- **AND** la riga di registro del suo banner (che parte comunque con «notifica
  anche a fuoco») SHALL nascere vista, come quella di una chat a fuoco, e la
  campanella e il Dock SHALL non contarla

#### Scenario: nessuna pane a fuoco, la pane disegnata davanti finisce un turno
- **GIVEN** nessuna pane a fuoco, e il gruppo disegna la sua tab attiva (un
  terminale o una chat) come a fuoco
- **WHEN** quella pane finisce un turno
- **THEN** né la sua riga, né la sua tab, né la campanella SHALL contarla

#### Scenario: il coordinatore nel cassetto della board finisce un turno
- **GIVEN** la board a fuoco con il cassetto del coordinatore aperto
- **WHEN** il coordinatore finisce un turno pulito, rumoroso o silenziato
- **THEN** la campanella SHALL non contarlo e il Dock SHALL non lampeggiare

### Requirement: ATTN-01 — Ogni soggetto ha UNO stato di attenzione, e lo compone il server

Ogni chat (`topic:<id>`), terminale (`terminal:<id>`) e card (`task:<id>`) SHALL avere
uno e un solo stato di attenzione: `idle`, `working`, `needs-you` (con
motivo `question`, `permission`, `plan`, `review` o `parked`) o `finished` (con esito
`done` o `error`), più un'epoca e l'ultima epoca vista. Un soggetto è **acceso** quando è
`needs-you`, o quando è `finished` e la sua epoca non è stata vista.

Lo stato SHALL comporlo il server da turno, lavoro in background, attesa di una persona,
ultimo turno, stato della card, archiviazione e chiusura, con questa precedenza:
archiviato, cancellato o terminale chiuso → `idle`; topic di un agente di board → `idle`;
attesa aperta → `needs-you`;
card in review o parcheggiata → `needs-you`; turno aperto → `working`; ultimo turno in
errore non visto → `finished(error)`; compiti in background → `working`; ultimo turno
finito non visto → `finished(done)`; altrimenti `idle`.

Un soggetto che aspetta il lavoro che ha lanciato È al lavoro (modifica del 2026-10-04):
non esiste uno stato `background` a parte, e ogni superficie lo mostra «in corso» come un
turno aperto. Un processo fatto per restare acceso (un server avviato con `run_script`, o
con `run_command` senza sveglia, che ascolta su una porta) NON SHALL essere un compito che
conta: è un server della chat (BGVIS-08), con un segno suo sulla riga della sidebar, che
non conta come lavoro in corso e non accende niente. Una riga salvata come `background`
prima della modifica SHALL caricarsi come `working`.

Un'attesa aperta nella sessione di una card in volo SHALL essere un ingresso del soggetto
`task:<id>` di quella card, non del suo topic. L'attesa resta un fatto transitorio come
oggi (`task:awaiting-human`, non scritto in `dispatch_state`): dopo un riavvio le mappe dei
bridge sono vuote e l'attesa non esiste più.

Un solo modulo SHALL scrivere lo stato e trasmetterlo (`attention:init`,
`attention:updated`). Tab di pane, riga della sidebar (anche la sua presenza e il suo
ordine), riga e tab di progetto, card del gruppo, tab board e riga Board, vista per stato,
coda di ⌘J e porta «In attesa» del telefono, menu agenti, anello di lavoro, inbox,
Dock, tray e badge PWA SHALL derivare solo da quello stato, con le stesse due funzioni per
soggetto e per insieme di soggetti. Nessuna superficie SHALL leggere la fase Claude, le
righe del registro, il poll di `GET /api/topics/streaming` o un segno in memoria per
decidere se accendersi o se mostrare il lavoro in background.

#### Scenario: la precedenza, a tabella
- **GIVEN** ogni combinazione di archiviato, agente di board, attesa, card, turno aperto, esito dell'ultimo turno, visto e compiti in background
- **WHEN** si compone lo stato
- **THEN** il risultato SHALL essere quello della prima regola dell'elenco che si applica

#### Scenario: una chat e un terminale con hook finiti contano uguale
- **GIVEN** una chat finita e un terminale claude-code con hook finito, nessuno dei due visto
- **WHEN** si leggono tab, riga, menu agenti, campanella e Dock
- **THEN** entrambi SHALL essere blu con un numero sulla tab e sulla riga
- **AND** il menu agenti, la campanella e il Dock SHALL dire 2

#### Scenario: un terminale senza hook finito si accende dappertutto o da nessuna parte
- **GIVEN** un terminale senza hook dentro un gruppo che ha finito e non è stato visto
- **WHEN** si leggono la sua tab, la sua riga, la riga di progetto e la card del gruppo
- **THEN** tutte e quattro SHALL avere `data-attention="done"`

#### Scenario: nessuna chat è insieme al lavoro e finita
- **GIVEN** una chat con un Agent in background
- **WHEN** si compone il menu agenti
- **THEN** la chat SHALL stare fra quelle al lavoro e NON SHALL stare fra le finite

#### Scenario: un server acceso non è lavoro in corso
- **GIVEN** una chat il cui agente ha avviato un dev server con `run_script`, che ascolta su una porta
- **THEN** il suo stato NON SHALL essere `working`, la riga della sidebar SHALL avere il segno del server (`row-server-sign`) col suo indirizzo e nessun anello
- **AND** la riga quieta della inbox NON SHALL contarla

#### Scenario: il topic di un agente di board
- **GIVEN** il topic di una card dispatchata che finisce un turno
- **THEN** il suo stato SHALL essere `idle`, e la consegna SHALL comparire come `needs-you(review)` della card

#### Scenario: l'agente di board chiede a metà turno
- **GIVEN** una card `in_progress` la cui sessione apre un permesso dal permission bridge, o una domanda dall'ask bridge
- **THEN** il soggetto `task:<id>` SHALL essere `needs-you(permission)` o `needs-you(question)`, nella inbox sotto «Ti aspettano», contato in campanella, Dock e tab board
- **AND** il topic della card SHALL restare `idle`
- **WHEN** la persona risponde
- **THEN** il soggetto della card SHALL tornare spento

#### Scenario: un terminale chiuso
- **GIVEN** un terminale `finished(done)` non visto
- **WHEN** la persona chiude la sua tab, o la sua pane viene rimossa
- **THEN** il soggetto SHALL essere `idle`, la sua riga di cronologia vista, e campanella e Dock SHALL calare di uno

### Requirement: ATTN-02 — Il lavoro in background è lavoro in corso, non chiede niente, e la fine vera avvisa una volta

Un turno che finisce lasciando compiti in volo (Bash o Agent con `run_in_background`,
Workflow, Monitor, CronCreate non ricorrente, `run_command` di Topics) SHALL portare il
soggetto in `working`, come un turno aperto: niente fill, niente numero, niente banner,
niente spinta, niente riga di cronologia, e nessun conto in campanella, Dock, tray o vista
«Ti aspetta». L'anello di lavoro in corso SHALL essere il suo segno, lo stesso di un turno.

`stream:end` SHALL portare `background: { count, kinds }`, calcolato prima del frame da
una funzione dell'attenzione (`attentionBackground`) che conta i compiti vivi, la CLI che
si sta già svegliando (`wake-queued`) e i cron non ricorrenti. NON SHALL venire da
`backgroundState`/`backgroundOfTurn` del goal loop, che contano anche un cron ricorrente
armato per due ore: quelli restano al goal loop, invariati.

Un turno risvegliato che chiude con altri compiti ancora in volo SHALL lasciare il
soggetto in `working`, senza avvisi. Quando l'ultimo compito è tornato e il turno che
lo porta chiude, il soggetto SHALL passare a `finished(done)` con un'epoca nuova: un
avviso solo per tutta l'attesa. Se l'ultimo compito torna e nessun turno si apre entro
5 s, il soggetto SHALL passare a `finished(done)` se l'ultimo turno non era stato visto,
altrimenti a `idle`. Un turno è visto quando la persona ha guardato il soggetto dopo che è
chiuso, anche mentre aspetta i suoi compiti (ATTN-06, `seen_at`), o quando è chiuso davanti a lei.

Nessun messaggio dentro un turno e nessun turno risvegliato SHALL alzare un banner su
nessuna finestra, nemmeno sulla finestra principale nascosta nella tray: il ramo dei
banner di `message:new` SHALL sparire, e l'unico banner SHALL essere l'annuncio della
transizione (ATTN-11).

Un turno in errore SHALL dare `finished(error)` anche con compiti in volo.

#### Scenario: una chat lancia i verifier e aspetta
- **GIVEN** una chat non a fuoco il cui turno lancia un Agent e un Bash in background e risponde «Lanciati, aspetto»
- **WHEN** arriva `stream:end`
- **THEN** il frame SHALL portare `background.count = 2`
- **AND** lo stato SHALL essere `working`, senza riga di cronologia, senza spinta e senza banner
- **AND** la tab e la riga NON SHALL avere fill né numero, e campanella e Dock NON SHALL cambiare

#### Scenario: uno di tre è tornato
- **GIVEN** la chat in attesa del suo lavoro (`working`) con tre compiti
- **WHEN** il primo torna, la CLI si sveglia e il turno chiude con «1 di 3 arrivato»
- **THEN** lo stato SHALL restare `working` senza epoca nuova, e il non-letto SHALL salire di uno senza che nessuna superficie lo mostri

#### Scenario: l'ultimo torna
- **GIVEN** la chat in attesa del suo lavoro (`working`) con un solo compito, e due messaggi non letti dei turni risvegliati
- **WHEN** l'ultimo compito torna e il turno che lo porta chiude senza altro in volo
- **THEN** lo stato SHALL essere `finished(done)` con un'epoca nuova
- **AND** SHALL partire un banner solo, e la riga e la tab SHALL mostrare 3

#### Scenario: il compito torna e la CLI non si sveglia
- **GIVEN** una chat in attesa del suo lavoro (`working`) il cui ultimo turno non era stato visto
- **WHEN** l'ultimo compito torna e per 5 s non si apre nessun turno
- **THEN** lo stato SHALL essere `finished(done)`

#### Scenario: guardata mentre aspettava il suo lavoro
- **GIVEN** una chat in attesa del suo lavoro (`working`), guardata dalla persona per la soglia dopo la fine del turno
- **WHEN** l'ultimo compito torna e per 5 s non si apre nessun turno
- **THEN** lo stato SHALL essere `idle`, senza epoca nuova né banner

#### Scenario: la finestra principale è nella tray
- **GIVEN** la finestra principale nascosta nella tray, e una chat in attesa del suo lavoro (`working`) con tre compiti
- **WHEN** tornano i primi due, ciascuno con un turno risvegliato che scrive un messaggio
- **THEN** NON SHALL partire nessun banner
- **WHEN** torna il terzo e il turno chiude senza altro in volo
- **THEN** SHALL partire UN banner, uno solo fra tutte le finestre

#### Scenario: un cron ricorrente in una chat
- **GIVEN** una chat headless il cui turno crea un cron ricorrente e risponde
- **WHEN** arriva `stream:end`
- **THEN** `background.count` SHALL essere 0 e lo stato `finished(done)`
- **AND** il goal loop SHALL continuare a rimandare il giudizio finché il cron è armato, come oggi

#### Scenario: un Monitor armato
- **GIVEN** una chat che ha armato un Monitor e chiude il turno
- **THEN** lo stato SHALL essere `working`, con l'anello di lavoro, e la tab NON SHALL essere blu né contata in campanella

#### Scenario: un errore con compiti in volo
- **GIVEN** una chat con un Bash in background
- **WHEN** il turno successivo finisce in errore
- **THEN** lo stato SHALL essere `finished(error)`, rosso, contato

### Requirement: ATTN-03 — I compiti in background si contano per id e si chiudono col loro avviso

Il server SHALL tenere per ogni sessione i compiti in background per id: entra un id per
ogni lancio, esce quando arriva l'avviso di fine di quell'id (`<task-notification>` nel
transcript, consegna o fine del Monitor anche per scadenza, primo scatto o CronDelete di
un cron non ricorrente, uscita del processo di un `run_command`). Per le chat headless la
fonte SHALL essere lo snapshot dei compiti che la CLI stampa; per i terminali gli hook e
il transcript. Un CronCreate ricorrente SHALL stare fra i compiti, segnato ricorrente,
perché la riga del background e lo Stop lo mostrino, ma NON SHALL contare né per lo stato
di attenzione né per `watching`, in chat e nei terminali.

I compiti di un soggetto SHALL avere un detentore solo, lo stato di attenzione: le fonti
(lo snapshot della CLI per le chat, hook e transcript per i terminali, il registro dei
processi per `run_command`) lo alimentano, e la macchina delle fasi legge da lì il numero
di compiti allo `Stop`.

La macchina delle fasi SHALL mettere `watching` allo `Stop` quando la sessione ha almeno
un compito in volo, qualunque sia il tool che l'ha lanciato, e `awaiting-user` quando non
ne ha.

La mappa dei compiti SHALL sopravvivere a un ricarico del server finché il processo che
la tiene è vivo. La fine del processo SHALL svuotarla (ATTN-15).

#### Scenario: Bash, Agent e Workflow in un terminale
- **GIVEN** un terminale claude-code con hook
- **WHEN** un turno lancia un Bash con `run_in_background`, oppure un Agent con `run_in_background`, oppure un Workflow, e poi arriva `Stop`
- **THEN** la fase SHALL essere `watching` e lo stato di attenzione `working`

#### Scenario: il Monitor scaduto di un terminale
- **GIVEN** un terminale in `watching` per un solo Monitor
- **WHEN** il transcript dice che il Monitor è scaduto e arriva lo `Stop` del turno dopo
- **THEN** la fase SHALL essere `awaiting-user` e lo stato `finished(done)`

#### Scenario: un cron ricorrente
- **WHEN** un turno crea un cron ricorrente e finisce
- **THEN** il cron NON SHALL entrare nei compiti e lo stato SHALL essere `finished(done)`

#### Scenario: il server si ricarica con un terminale in attesa
- **GIVEN** un terminale con un Agent in volo e il bridge PTY vivo
- **WHEN** il server si ricarica
- **THEN** il terminale SHALL essere ancora `working` con lo stesso id in volo

#### Scenario: un cron ricorrente in un terminale
- **GIVEN** un terminale claude-code con hook
- **WHEN** un turno crea un cron ricorrente e arriva `Stop`
- **THEN** la fase SHALL essere `awaiting-user` e lo stato `finished(done)`

### Requirement: ATTN-04 — Una persona in mezzo è «ti serve», da qualunque porta arrivi

Un soggetto SHALL essere `needs-you` quando aspetta una persona: una domanda
(`mcp__topics__ask_user_question` del bridge, `AskUserQuestion`), un permesso (permission
bridge, `awaiting-approval`, `paused`), un piano da approvare, una card in `review`, una
card parcheggiata. Lo stato di attenzione SHALL ascoltare gli eventi di attesa dei bridge
come il dispatcher.

`needs-you` SHALL restare acceso finché l'attesa finisce: risposta data, permesso deciso,
piano approvato o respinto, card uscita da review, card rimessa in coda, cancellata o
archiviata. Il visto NON SHALL spegnerlo. Un piano da approvare NON SHALL essere
annunciato come turno finito.

#### Scenario: una domanda MCP in una chat
- **GIVEN** una chat headless che chiama `mcp__topics__ask_user_question`
- **WHEN** il bridge apre l'attesa
- **THEN** lo stato SHALL essere `needs-you(question)` con la domanda in `detail`, ambra su tab, riga, card del gruppo e progetto
- **AND** la fase NON SHALL essere `tool-running`

#### Scenario: un permesso dal permission bridge
- **WHEN** il permission bridge apre un'attesa per un comando Bash
- **THEN** lo stato SHALL essere `needs-you(permission)` col comando in `detail`

#### Scenario: un piano da approvare
- **GIVEN** una chat in plan mode il cui turno chiude con un piano
- **WHEN** si apre il pannello di approvazione
- **THEN** lo stato SHALL essere `needs-you(plan)`
- **AND** NON SHALL esserci una riga «Claude ha finito di rispondere» né un `finished`

#### Scenario: la risposta
- **GIVEN** una chat in `needs-you(question)`
- **WHEN** la persona risponde e il turno riprende
- **THEN** lo stato SHALL essere `working`, e la chat NON SHALL più contare

#### Scenario: il permesso scaduto
- **WHEN** un `awaiting-approval` scade in `paused`
- **THEN** lo stato SHALL restare `needs-you(permission)` senza epoca nuova

#### Scenario: guardare non spegne l'ambra
- **GIVEN** una chat `needs-you(question)` a fuoco con la finestra sveglia
- **WHEN** passa la soglia del visto
- **THEN** SHALL restare ambra e contata

#### Scenario: la card parcheggiata rimessa in coda
- **GIVEN** una card parcheggiata, contata in campanella e Dock
- **WHEN** la persona la rimette in coda
- **THEN** il soggetto della card SHALL tornare spento e la campanella e il Dock SHALL calare di uno

#### Scenario: la card esce da review
- **WHEN** una card in review viene approvata, cancellata o archiviata
- **THEN** il suo soggetto SHALL spegnersi

### Requirement: ATTN-05 — «Finito» vale una volta, solo con qualcosa dentro, e si spegne guardandolo

Un turno che finisce con un messaggio visibile e nessun compito in volo SHALL portare il
soggetto in `finished(done)` con un'epoca nuova. Un turno in errore SHALL portarlo in
`finished(error)`, anche quando a chiudere il turno è la macchina (watchdog, stall judge,
rifiuto, limite di uscita): oggi lo stesso turno porta `reason: "error"` e la spinta di
errore, ed è un fatto che la persona deve vedere. Fa eccezione un errore che il sistema
riprende da solo (il rinvio di `resumesByItself`): resta `working` senza epoca finché il
turno riparte. Solo uno stop della PERSONA o un turno dispatchato SHALL portarlo in `idle`
senza avvisi.

Il numero sulla tab e sulla riga SHALL venire dal frame di attenzione, che SHALL partire
anche quando cambia solo il non-letto di un soggetto acceso; nessun altro frame SHALL
essere una seconda fonte del numero (quello dei soli non-letti, `unread:updated`, è
stato tolto con il client che lo leggeva).

Un turno risvegliato scartato perché vuoto NON SHALL alzare il non-letto né creare
un'epoca. Il non-letto SHALL salire solo per un turno che lascia un messaggio visibile.

`finished` SHALL spegnersi col visto (ATTN-06) e restare spento finché non arriva
un'epoca nuova: una chat letta e ferma su `awaiting-user` NON SHALL contare su nessuna
superficie.

#### Scenario: un turno pulito
- **GIVEN** una chat non a fuoco
- **WHEN** il turno finisce con una risposta e niente in volo
- **THEN** lo stato SHALL essere `finished(done)`, epoca +1, blu con numero su tab e riga, +1 in campanella e Dock

#### Scenario: un tick di Monitor a cui il modello non risponde
- **GIVEN** una chat in attesa del suo lavoro (`working`) per un Monitor
- **WHEN** arriva un turno risvegliato che viene scartato perché vuoto
- **THEN** il non-letto NON SHALL cambiare e NON SHALL nascere un'epoca

#### Scenario: un errore
- **WHEN** un turno finisce in errore
- **THEN** lo stato SHALL essere `finished(error)`, rosso, contato

#### Scenario: uno stop della persona
- **WHEN** la persona ferma il turno
- **THEN** lo stato SHALL essere `idle` senza banner, spinta né riga

#### Scenario: il watchdog taglia il turno
- **WHEN** un turno viene chiuso dalla macchina con `reason: "error"` e il sistema non lo rimanda da solo
- **THEN** lo stato SHALL essere `finished(error)` con un'epoca nuova

#### Scenario: un messaggio nuovo su una chat già accesa
- **GIVEN** una chat `finished(done)` non vista con 2 non letti
- **WHEN** il server alza il non-letto a 3 senza cambiare stato
- **THEN** SHALL partire `attention:updated` e la riga e la tab SHALL mostrare 3

#### Scenario: la chat letta non torna a «1»
- **GIVEN** una chat `finished(done)` con la fase `awaiting-user`
- **WHEN** la persona la guarda per la soglia e poi passa a un'altra pane
- **THEN** né la tab né la riga SHALL avere un numero, e campanella e Dock NON SHALL contarla

### Requirement: ATTN-06 — Il «visto» è della persona, sta sul server e vale per un'epoca

Il visto SHALL essere uno solo per soggetto e per persona, salvato sul server come
ultima epoca vista e come istante fin dove i turni del soggetto sono stati visti
(`seen_at`). Una porta sola (`POST /api/attention/seen` con `{subject, epoch, turnAt}`)
SHALL alzarli, azzerare il non-letto del topic, segnare viste le righe di cronologia del
soggetto fino a quell'epoca e trasmettere `attention:updated` a ogni finestra e
dispositivo della persona, SEMPRE, anche quando non ha cambiato niente.

Un visto per un'epoca NON SHALL spegnere un'epoca più nuova, e un `turnAt` vecchio NON
SHALL coprire un turno più nuovo. Una pane a fuoco SHALL mandare il visto anche quando il
soggetto aspetta i suoi compiti (`working`) con un turno chiuso non visto.

Il frame `focus` SHALL portare il soggetto a fuoco e se la finestra è sveglia, e la
chiusura della socket SHALL cancellarlo. Un'epoca che nasce mentre il suo soggetto è a
fuoco in una finestra sveglia della persona SHALL nascere vista: niente numero, niente
riga non vista, niente spinta.

Le socket degli ospiti NON SHALL scrivere il visto né ricevere `attention:*`, e il loro
frame `focus` NON SHALL far nascere visto niente.

Sul telefono il visto SHALL spegnere numero e righe dal vivo con la PWA aperta; con la PWA
chiusa, alla sua apertura o al ritorno in primo piano SHALL ritirare le notifiche
consegnate dei soggetti non più accesi e riscrivere il badge. Ogni spinta SHALL portare il
numero corrente, che il service worker scrive sul badge.

#### Scenario: letta sul Mac, spenta ovunque
- **GIVEN** una chat `finished(done)` accesa nella finestra A, nella finestra B e nella PWA aperta sul telefono
- **WHEN** la persona la guarda in A per la soglia
- **THEN** in B e sul telefono la tab, la riga e il numero SHALL spegnersi senza nessun gesto

#### Scenario: il telefono con la PWA chiusa
- **GIVEN** una spinta consegnata per una chat, e la PWA chiusa
- **WHEN** la persona guarda la chat sul Mac e poi apre la PWA
- **THEN** la notifica consegnata SHALL essere ritirata e il badge SHALL non contarla più

#### Scenario: un terminale guardato senza righe
- **GIVEN** un terminale senza hook finito, senza nessuna riga di cronologia
- **WHEN** la persona lo guarda in A
- **THEN** SHALL partire `attention:updated` e in B il terminale SHALL spegnersi

#### Scenario: un'epoca più nuova della lista
- **GIVEN** la inbox mostra una chat all'epoca 4
- **WHEN** arriva l'epoca 5 e poi la persona preme «Segna tutte viste»
- **THEN** la chat SHALL restare accesa per l'epoca 5

#### Scenario: la chat davanti finisce
- **GIVEN** una chat a fuoco in una finestra sveglia
- **WHEN** finisce cinque turni
- **THEN** ogni epoca SHALL nascere vista, nessuna spinta SHALL partire e il numero del Dock NON SHALL cambiare

#### Scenario: la finestra è dietro un'altra app
- **GIVEN** una chat a fuoco in una finestra non sveglia
- **WHEN** il turno finisce
- **THEN** l'epoca SHALL nascere non vista e contare, e SHALL spegnersi quando la finestra torna davanti e passa la soglia

#### Scenario: un ospite
- **WHEN** una socket ospite manda un visto
- **THEN** il server SHALL scartarlo e lo stato NON SHALL cambiare

#### Scenario: il fuoco di un ospite
- **GIVEN** una socket ospite sveglia col fuoco su una chat condivisa, e nessuna finestra della persona su quella chat
- **WHEN** il turno della chat finisce
- **THEN** l'epoca SHALL nascere non vista, contare e partire come annuncio

### Requirement: ATTN-07 — Aprire, ricaricare o riconnettere non riaccende e non suona

A ogni apertura della socket della persona il server SHALL mandare `attention:init` con
ogni soggetto non `idle` e ogni `finished` non visto, e il client SHALL sostituire il suo
stato per intero. Non SHALL esserci una seconda porta per la stessa istantanea.

Un banner SHALL partire solo da un `attention:updated` dal vivo con un'epoca più grande
dell'ultima annunciata per quel soggetto in quella finestra; l'istantanea NON SHALL mai
annunciare.

A ogni avvio del server, anche un ricarico del watcher, lo stato SHALL ricomporsi
dall'ultimo turno, dal visto e dai compiti salvati nella riga e dagli ingressi riletti da
dove già vivono (card, archiviati, terminali chiusi, dispatch, attese salvate), senza
annunciare e senza epoche nuove: un'epoca nasce solo per un fatto nuovo (un turno,
un'attesa, uno stato della card), mai per una ricomposizione degli stessi fatti.

Al primo avvio con la tabella vuota il server SHALL accendere solo ciò che è vero in quel
momento (attese salvate, card in review o parcheggiate, processi vivi), e NON SHALL
accendere chat finite prima del rilascio.

#### Scenario: un ricarico
- **GIVEN** tre chat lette ferme su `awaiting-user`
- **WHEN** la finestra si ricarica
- **THEN** nessuna delle tre SHALL essere blu o contata, e nessun banner SHALL partire

#### Scenario: il telefono si risveglia
- **GIVEN** il telefono addormentato mentre la persona legge sul Mac una chat che il telefono contava
- **WHEN** il telefono riconnette la socket
- **THEN** il suo numero e la sua inbox SHALL non contarla più, senza aprire il pannello

#### Scenario: una finestra nuova
- **WHEN** si apre una finestra di gruppo con due chat accese
- **THEN** SHALL mostrarle accese e NON SHALL alzare banner

#### Scenario: un ricarico del server con una chat finita non vista
- **GIVEN** una chat `finished(done)` all'epoca 7, non vista, e una card in review
- **WHEN** il watcher ricarica il server
- **THEN** la chat SHALL essere ancora `finished(done)` all'epoca 7, la card ancora `needs-you(review)`, e nessun banner né riga SHALL nascere

#### Scenario: il primo avvio dopo il rilascio
- **GIVEN** la tabella vuota, una card in review e 50 chat finite nei giorni prima
- **WHEN** il server parte
- **THEN** la inbox SHALL elencare la card e nessuna delle 50 chat, e nessun banner SHALL partire

### Requirement: ATTN-08 — Un numero, una mano che lo scrive

Il numero di campanella, Dock, tray e badge PWA SHALL essere il numero di soggetti
accesi non archiviati, calcolato dallo stato di attenzione e da nient'altro. Sul desktop
SHALL scriverlo solo la finestra principale: `set_app_status` chiamato da un'altra
finestra NON SHALL cambiare Dock né tray.

#### Scenario: due finestre
- **GIVEN** la finestra principale e una finestra di gruppo aperte
- **WHEN** una chat della finestra di gruppo finisce e poi viene vista lì
- **THEN** la cronologia delle chiamate che arrivano al Dock SHALL avere solo i valori della finestra principale, +1 e poi -1

#### Scenario: la finestra di gruppo chiama da sola
- **WHEN** una finestra che non è la principale chiama `set_app_status`
- **THEN** il Dock e la tray NON SHALL cambiare

### Requirement: ATTN-09 — Il tasto della sidebar è una inbox di cose vere

Il tasto della sidebar SHALL aprire un pannello «Da guardare» con due linguette, «Ora» e
«Cronologia». «Ora» SHALL elencare i soggetti accesi in due sezioni: «Ti aspettano»
(`needs-you`, dal più vecchio) e «Finite» (`finished` non visti, dal più recente), ogni
riga con icona del motivo, nome, progetto, tempo e una seconda linea con la domanda, il
permesso, il motivo, l'inizio dell'ultimo messaggio o l'errore. Sotto, una riga quieta
SHALL dire quanti soggetti sono al lavoro (un turno aperto o un lavoro in background che
aspettano: un conto solo), senza entrare nel numero.

Aprire il pannello NON SHALL segnare niente. Aprire una voce SHALL portare al soggetto nel
punto (la chat sulla domanda, la card nel cassetto) e, per una `Finite`, segnarla vista.
«Segna visto» su una riga e «Segna tutte viste» in fondo alle `Finite` SHALL mandare le
epoche mostrate. «Ti aspettano» NON SHALL avere un'azione che la spegne senza rispondere.

«Cronologia» SHALL elencare le ultime 100 righe del registro per giorno, in sola lettura,
senza numero sulla linguetta. Una riga nuova SHALL arrivarci dal vivo, a linguetta
aperta e senza ricaricare: quella scritta da una transizione di un soggetto nel suo
`attention:updated` (`history`), ogni altra (un avviso di sistema, la rotta pubblica
`POST /api/notifications`) sul frame `attention:history`, solo della persona come gli
altri frame di attenzione. Un doppione che il registro scarta NON SHALL partire.

Il tasto SHALL mostrare il numero dei soggetti accesi, ambra se almeno uno è
`needs-you`, e nessun numero a zero. Il pannello SHALL funzionare da tastiera (una voce
del registro delle scorciatoie di oggi, `shared/shortcuts.ts`, per aprirlo, ↑/↓, Invio, `E`, ⇧`E`, ←/→ per le linguette, Esc che rende il
fuoco al tasto) e al tocco (righe da almeno 44 px, foglio dal basso sotto i 768 px,
scorrimento a sinistra per «Segna visto» solo sulle `Finite`). Icone lucide, nessuna
emoji.

#### Scenario: aprire non spegne
- **GIVEN** due chat `Finite` e una domanda in «Ti aspettano»
- **WHEN** si apre il pannello e lo si chiude
- **THEN** il numero SHALL essere ancora 3

#### Scenario: una voce aperta
- **WHEN** si preme Invio su una `Finite`
- **THEN** la chat SHALL aprirsi, la voce SHALL sparire dalla lista e il numero SHALL calare di uno su ogni dispositivo

#### Scenario: la domanda si apre sul punto
- **WHEN** si apre una voce `needs-you(question)`
- **THEN** la chat SHALL aprirsi scorsa sulla domanda, e la voce SHALL restare finché non si risponde

#### Scenario: segna tutte viste
- **GIVEN** tre `Finite` e due in «Ti aspettano»
- **WHEN** si preme «Segna tutte viste»
- **THEN** il numero SHALL essere 2

#### Scenario: niente da guardare, due al lavoro in background
- **GIVEN** nessun soggetto acceso e due chat in attesa del suo lavoro (`working`)
- **WHEN** si apre il pannello
- **THEN** SHALL dire «Niente da guardare» e «2 al lavoro», e il tasto NON SHALL avere numero

#### Scenario: solo tastiera
- **WHEN** la persona apre il pannello con la scorciatoia, scende con ↓, segna con `E` e chiude con Esc
- **THEN** la voce SHALL risultare vista e il fuoco SHALL tornare sul tasto

#### Scenario: telefono
- **GIVEN** uno schermo largo 390 px
- **WHEN** si tocca il tasto
- **THEN** il pannello SHALL aprirsi come foglio dal basso con righe alte almeno 44 px, e uno scorrimento a sinistra su una `Finite` SHALL segnarla vista

#### Scenario: una riga senza transizione arriva dal vivo
- **GIVEN** la linguetta «Cronologia» aperta
- **WHEN** un avviso di sistema scrive la sua riga, o una riga arriva da `POST /api/notifications`
- **THEN** la riga SHALL comparire in cima senza ricaricare né riaprire la linguetta, portata da `attention:history`
- **AND** lo stesso evento riportato una seconda volta NON SHALL aggiungere una riga né un frame

### Requirement: ATTN-10 — Gli avvisi di infrastruttura non accendono una chat

Gli avvisi di swap-freeze (congelato, scongelato), di riavvio trattenuto e del GC dei
worktree SHALL essere righe di cronologia di tipo «Sistema», con un soggetto `system:` e
non `topic:`, una per ciclo. NON SHALL accendere nessun soggetto né entrare in nessun
numero.

#### Scenario: un comando in background congelato e scongelato
- **GIVEN** una chat in attesa del suo lavoro (`working`) col comando che lo swap congela e poi scongela
- **THEN** la chat SHALL restare `working`, spenta, e la cronologia SHALL avere UNA riga «Sistema» per quel ciclo

#### Scenario: un riavvio trattenuto
- **WHEN** il server trattiene un riavvio per una chat al lavoro
- **THEN** la riga SHALL essere «Sistema» e campanella e Dock NON SHALL cambiare

### Requirement: ATTN-11 — Banner, spinte e righe nascono dalle transizioni del server

Ogni epoca nuova dal vivo SHALL scrivere UNA riga di cronologia, scritta dal server,
nata vista se il soggetto è nato visto, anche quando nessuna spinta parte. Il client NON
SHALL scrivere righe per fine turno, attesa o terminale.

Solo l'ingresso in `needs-you` e in `finished` SHALL annunciare. Il server NON SHALL
annunciare per un soggetto silenziato (o nel progetto silenziato), archiviato o di un
agente di board; la riga sì, tranne che per l'archiviato. I testi e i tasti SHALL seguire
PUSH-04.

Il banner di una finestra desktop SHALL partire se l'epoca non è nata vista, o se è nata
vista e «notifica anche se a fuoco» è acceso, e poi SHALL passare il cancello di Non
disturbare del client (QUIET-01), che resta dove vive la lettura della concentrazione;
due finestre, anche la principale nascosta nella tray, SHALL consegnarne uno solo (claim su
`subject#epoch`). Nessun altro ramo del client SHALL alzare banner per turni o messaggi.

La spinta al telefono SHALL partire per ogni annuncio la cui epoca non è nata vista, e NON
SHALL leggere la concentrazione del Mac.

#### Scenario: nessun dispositivo iscritto
- **GIVEN** zero iscrizioni push e una chat non a fuoco
- **WHEN** il turno finisce
- **THEN** SHALL esserci una riga sola, non vista, e il log SHALL dire che nessun dispositivo era iscritto

#### Scenario: la chat a fuoco con «notifica anche se a fuoco» spento
- **GIVEN** una chat con hook a fuoco in una finestra sveglia, e l'impostazione spenta
- **WHEN** il turno finisce
- **THEN** NON SHALL partire nessun banner, e la riga SHALL nascere vista

#### Scenario: un telefono iscritto
- **GIVEN** un telefono iscritto e la chat non a fuoco in nessuna finestra sveglia
- **WHEN** una chat finisce davvero
- **THEN** SHALL partire una spinta, con l'etichetta della chat e il numero corrente

#### Scenario: Non disturbare sul Mac
- **GIVEN** la concentrazione del sistema accesa e letta dal guscio
- **WHEN** una chat arriva a una domanda
- **THEN** NON SHALL partire il banner sul Mac, la riga SHALL nascere e la chat SHALL contare

#### Scenario: una chat archiviata si risveglia
- **GIVEN** una tab chiusa, che ha archiviato la chat, col suo lavoro in background
- **WHEN** il lavoro torna e il turno risvegliato chiude
- **THEN** NON SHALL partire banner né spinta, e NON SHALL nascere una riga

#### Scenario: due finestre, un banner
- **GIVEN** due finestre che ricevono la stessa epoca
- **THEN** una sola SHALL consegnare il banner

### Requirement: ATTN-12 — Pane, tab, riga, progetto e gruppo mostrano lo stesso tier

Ogni superficie SHALL disegnare il tier del soggetto così: `working` (un turno aperto o un
lavoro in background che aspetta) l'anello di lavoro, senza fill né numero; `needs-you` fill ambra; `finished(done)` non visto fill
blu; `finished(error)` non visto fill rosso; visto o `idle` niente. Le superfici accese
SHALL esporre `data-attention` col tier (`needs-you`, `done`, `error`) e il numero
`max(1, non-letti)`. Riga e tab di progetto e card del gruppo SHALL mostrare il tier più
alto dei figli accesi (`needs-you` sopra `error` sopra `done`) e il numero dei figli
accesi. La vista per stato della sidebar SHALL avere le sezioni «Ti aspetta», «Finite»,
«Al lavoro», dallo stesso tier. Un server acceso (BGVIS-08) NON SHALL accendere l'anello:
la riga ha il suo segno del server.

L'anello di lavoro, l'indicatore di lavoro e la riga del background della chat
SHALL leggere il tier e i compiti dello stato di attenzione, dallo stesso frame del fill;
lo Stop del lavoro in background SHALL leggere i compiti in volo, anche col tier `error`.

Il numero su tab e riga SHALL esserci solo per un soggetto acceso: una chat spenta con
non-letti (al lavoro, vista, o con un messaggio di sistema) NON SHALL avere numero.

#### Scenario: la chat in background nella vista per stato
- **GIVEN** una chat in attesa del suo lavoro (`working`)
- **THEN** nella vista per stato SHALL stare sotto «Al lavoro» e NON sotto «Ti aspetta»

#### Scenario: la chat in background in sidebar e sulla tab
- **GIVEN** una chat il cui turno ha lasciato un Bash in background
- **THEN** la sua riga e la sua tab SHALL avere `[data-loader-state="working"]`, senza `data-attention`
- **WHEN** il Bash torna e il turno che lo riporta chiude
- **THEN** la riga SHALL avere `data-attention="done"` e nessun anello

#### Scenario: il progetto con una domanda e una chat finita
- **GIVEN** un progetto con una chat `needs-you` e una `finished(done)` non vista
- **THEN** la riga del progetto SHALL essere ambra con il numero 2

#### Scenario: anello e fill insieme non esistono più
- **GIVEN** una qualunque chat, anche `finished(error)` con un Bash ancora in volo
- **THEN** la sua riga NON SHALL mostrare insieme l'anello di un lavoro in background e un fill
- **AND** con il Bash in volo il composer SHALL offrire lo Stop del lavoro in background

### Requirement: ATTN-13 — Archiviare, cancellare o chiudere spegne il soggetto e le sue righe, dove si scrive

Archiviare o cancellare un topic, e chiudere o rimuovere un terminale, SHALL portare il
soggetto in `idle`, segnare viste la sua epoca, il suo ultimo turno e le sue righe di
cronologia nello stesso passo, sul server. Un topic archiviato NON SHALL contare su
nessuna superficie, e NON SHALL prendere epoche nuove finché resta archiviato.

Riaprire un topic archiviato NON SHALL riaccendere niente di prima: lo stato SHALL
ricomporsi senza `archived`, e un turno già finito prima dell'archiviazione NON SHALL dare
un'epoca né un annuncio.

#### Scenario: chiudere la tab prima di leggere
- **GIVEN** una chat `finished(done)` non vista con la sua riga di cronologia non vista
- **WHEN** la persona chiude la tab e la chat si archivia
- **THEN** campanella, Dock e tray SHALL calare di uno, e la tray SHALL elencare lo stesso numero di chat che conta

#### Scenario: cancellata
- **WHEN** si cancella una chat `needs-you`
- **THEN** il soggetto SHALL sparire da ogni numero e dalla inbox

#### Scenario: riaperta
- **GIVEN** una chat archiviata mentre era `finished(done)` non vista
- **WHEN** la persona la riapre
- **THEN** la chat SHALL essere `idle`, senza riga, banner né numero

### Requirement: ATTN-14 — La sidebar tiene e ordina le righe per stato acceso

Una chat o un terminale senza tab SHALL restare in sidebar se il suo soggetto è acceso,
oltre alle eccezioni di oggi (fissata, aperta in un'altra finestra, sotto-agenti vivi).
Le righe accese SHALL stare sopra le altre, fra loro dalla più recente per ingresso nello
stato; le spente SHALL ordinarsi per attività. Né il non-letto né la fase NON SHALL
tenere una riga in cima.

#### Scenario: la chat letta non galleggia più
- **GIVEN** due chat finite e accese, A più recente di B
- **THEN** A SHALL stare sopra B, ed entrambe sopra le chat spente
- **WHEN** la persona guarda A per la soglia
- **THEN** A SHALL tornare al suo posto per attività, su ogni finestra

#### Scenario: una chat senza tab che ti aspetta
- **GIVEN** una chat senza tab aperta, non fissata, che arriva a un permesso
- **THEN** la sua riga SHALL comparire in sidebar, ambra
- **WHEN** la persona risponde e il turno finisce davanti a lei
- **THEN** la riga SHALL sparire

### Requirement: ATTN-15 — La fine del processo chiude il lavoro in volo, e lo dice una volta

Quando il processo di un soggetto finisce (fine della sessione, uscita del PTY o del figlio
CLI, reaper per inattività, tetto di vita, crash, uccisione da parte dello swap, o
assenza del processo a un riavvio del server) i suoi compiti in background SHALL
svuotarsi.

Se c'erano un turno aperto o compiti che contano e la fine non l'ha chiesta la persona, il
soggetto SHALL passare a `finished(error)` con un'epoca nuova e la causa nel `detail`, salvo
un turno che il sistema riprende da solo. Altrimenti lo stato SHALL ricomporsi senza
epoche: un turno già visto NON SHALL riaccendersi, uno non visto SHALL restare com'era.

#### Scenario: il reaper chiude una chat ferma
- **GIVEN** una chat `idle`, già vista, senza compiti in volo
- **WHEN** il reaper ne chiude la CLI dopo 15 minuti
- **THEN** lo stato SHALL restare `idle`, senza epoca, riga né banner

#### Scenario: il tetto di vita chiude una chat in background
- **GIVEN** una chat in attesa del suo lavoro (`working`) con un Agent in volo
- **WHEN** il tetto di vita chiude la CLI
- **THEN** lo stato SHALL essere `finished(error)` con un'epoca nuova, rosso e contato

#### Scenario: un terminale con hook va in crash
- **GIVEN** un terminale claude-code in `working`
- **WHEN** il PTY esce con un codice diverso da zero senza che la persona l'abbia chiuso
- **THEN** lo stato SHALL essere `finished(error)`

#### Scenario: il server riparte e il processo non c'è più
- **GIVEN** una chat in attesa del suo lavoro (`working`) con un compito in volo, e nessun processo vivo dopo il riavvio
- **THEN** lo stato SHALL essere `finished(error)`, contato, senza banner né spinta

### Requirement: ATTN-16 — La tab board conta le card accese

Il numero della tab board e della riga Board SHALL essere il numero di soggetti `task:`
accesi del progetto (tutti i progetti per la board generale): card in review,
parcheggiate, o con un'attesa a metà turno. L'anello delle card in corso resta com'è. Il
numero NON SHALL venire da una cache locale.

#### Scenario: una card parcheggiata
- **GIVEN** una card in review e una parcheggiata nello stesso progetto
- **THEN** la tab board del progetto SHALL dire 2, come la inbox

#### Scenario: la card rimessa in coda
- **WHEN** la card parcheggiata viene rimessa in coda
- **THEN** la tab board SHALL dire 1

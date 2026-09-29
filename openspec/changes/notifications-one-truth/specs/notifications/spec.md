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
- **THEN** il client SHALL mandare il «visto» della chat anche senza non-letti, e le sue righe SHALL essere segnate viste

### Requirement: NOTIF-ONE-02 — I numeri globali contano soggetti, non messaggi

Il numero globale (Dock, tray, badge PWA) e il numero della campanella SHALL
essere LO STESSO numero, calcolato da una funzione sola: i SOGGETTI in attesa
(una chat vale 1 qualunque sia il numero dei suoi messaggi, un terminale finito
1, una pane con badge 1, una card in review 1) uniti ai soggetti con una
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

#### Scenario: una chat che ti aspetta, con le righe già viste
- **WHEN** una chat è ferma in attesa di te e tutte le sue righe sono viste
- **THEN** il numero globale e la campanella SHALL contarla 1, e il pannello SHALL elencarla sotto «Aspettano te»

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

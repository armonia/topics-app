## Purpose

Cosa Topics dice di te su Discord mentre lavori, e chi decide quanto. È l'unica
superficie del prodotto che pubblica lo stato della tua macchina FUORI dalla
macchina, verso una piattaforma di terzi e verso chiunque veda il tuo profilo.
Per questo la sua descrizione comincia da ciò che non esce.

## Background

TRE LIVELLI E UNA COSA CHE NON ESCE MAI. La riga pubblicata si costruisce dagli
stessi conteggi che l'app mostra a sé stessa — chat aperte, quante lavorano,
task in corso, progetto in primo piano — ma il progetto viene nominato SOLO al
livello più esplicito, e il nome di una chat o il suo contenuto non escono a
nessun livello. Il livello minimo pubblica una parola sola: il nome
dell'applicazione.

PERCHÉ UNA MACCHINA A STATI E NON UN TIMER. L'interruttore, il filo verso
Discord e il contenuto da pubblicare possono cambiare a ogni giro
indipendentemente l'uno dall'altro. Un solo passo periodico che li valuta tutti
e tre è ciò che garantisce le tre proprietà che contano: spegnere CANCELLA
invece di lasciare una riga vecchia appesa; Discord chiuso è uno STATO e non un
errore; e un identificativo rifiutato non produce una raffica di tentativi.

## Requirements

### Requirement: DISCORD-01 — Il livello decide cosa esce, e il progetto esce solo al più esplicito

La presenza SHALL avere tre livelli: `minimal`, `activity`, `detailed`.

`minimal` SHALL pubblicare il solo nome dell'applicazione: nessun numero,
nessun nome. `activity` SHALL aggiungere i conteggi. `detailed` SHALL essere
l'UNICO livello in cui compare il nome del progetto in primo piano.

Il nome di una chat, il suo titolo e il suo contenuto NON SHALL uscire a nessun
livello.

Quando `detailed` è scelto ma non c'è un progetto in primo piano, il sistema
SHALL degradare su `activity` invece di pubblicare un vuoto: «sta lavorando su
niente» è peggio che non dirlo.

Ogni stringa pubblicata SHALL essere troncata a una lunghezza dichiarata.

L'anteprima che l'interfaccia mostra SHALL essere ESATTAMENTE ciò che quel
livello pubblicherebbe — lo stesso codice, non un'imitazione — e SHALL essere
guardabile a interruttore SPENTO senza aprire nessuna connessione.

Il nome dell'applicazione mostrato sulla scheda lo dice DISCORD, non il codice:
finché la conferma non arriva, il sistema NON SHALL fingere di saperlo. Prima di
questa regola l'anteprima scriveva un nome a mano mentre la scheda vera ne
mostrava un altro.

#### Scenario: il livello minimo
- **GIVEN** il livello `minimal`
- **THEN** NON SHALL comparire nessun numero e nessun nome di progetto
- **AND** SHALL restare acceso anche a zero sessioni

#### Scenario: esplicito senza progetto
- **GIVEN** il livello `detailed` e nessun progetto in primo piano
- **THEN** SHALL essere pubblicato ciò che pubblicherebbe `activity`

### Requirement: DISCORD-02 — Spegnere CANCELLA, e il nulla è uno stato pubblicabile

Spegnere l'interruttore SHALL cancellare la presenza prima di chiudere il filo:
una riga vecchia lasciata appesa direbbe di te qualcosa che non è più vero, e
sarebbe l'unico modo in cui questa funzionalità può mentire.

Quando non c'è niente da dire — nessuna chat aperta e nessun task in corso — la
presenza SHALL essere CANCELLATA, ai livelli che pubblicano numeri. Zero chat ma
un task al lavoro NON è niente da dire.

Uno stato identico a quello già pubblicato NON SHALL essere riscritto: la
piattaforma limita la frequenza degli aggiornamenti, e riscrivere lo stesso
testo spende quel limite per nulla.

Un solo giro alla volta SHALL essere in volo, e nessuno dei timer SHALL tenere
vivo il processo.

#### Scenario: si spegne
- **GIVEN** una presenza pubblicata e l'interruttore che passa a spento
- **THEN** la presenza SHALL essere cancellata E il filo chiuso
- **AND** lo stato SHALL essere «spento», non «errore»

#### Scenario: nessuna chat, un task
- **GIVEN** zero chat aperte e un task in corso
- **THEN** la presenza NON SHALL essere cancellata

### Requirement: DISCORD-03 — Discord chiuso è uno stato, e un rifiuto non si ritenta come un guasto

Il collegamento SHALL provare i punti d'ingresso IN ORDINE, e un punto morto
NON SHALL nascondere quello vivo.

L'attesa della stretta di mano SHALL avere una scadenza: senza, il collegamento
resta appeso e lo stato non diventa mai niente.

I fallimenti SHALL essere DISTINTI e ritentati in modo diverso, perché non
significano la stessa cosa: nessun punto d'ingresso è «Discord non è aperto» e
passa da sé; un identificativo RIFIUTATO non passa col tempo, e SHALL essere
ritentato molto più di rado.

Un frame che arriva in più pezzi SHALL essere ricomposto, e due frame nello
stesso pezzo separati. Un contenuto illeggibile NON SHALL far cadere il filo.

La lunghezza dichiarata nell'intestazione di un frame SHALL essere in BYTE e non
in caratteri: con un nome di progetto accentato le due misure divergono, la
piattaforma legge una lunghezza corta, e da lì in poi ogni frame successivo è
disallineato.

Su macOS il sistema SHALL cercare i punti d'ingresso anche nella cartella
temporanea dell'UTENTE e non solo in quella del processo: un servizio avviato
con una cartella temporanea propria direbbe «Discord non è in esecuzione» mentre
lo è.

Un errore del connettore SHALL diventare un errore TIPATO e non un'eccezione che
risale.

#### Scenario: Discord non è aperto
- **GIVEN** nessun punto d'ingresso presente
- **THEN** lo stato SHALL dire che Discord non è in esecuzione, e NON SHALL essere un errore

#### Scenario: un identificativo rifiutato
- **GIVEN** una stretta di mano rifiutata dalla piattaforma
- **THEN** il tentativo successivo SHALL essere molto più lontano di quello di un
  semplice «non c'è nessuno»

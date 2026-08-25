## Purpose

Le invarianti del banco E2E stesso: isolamento fra run concorrenti, proprietà
della porta di test, e pulizia dei processi. Non descrive una funzionalità del
prodotto — descrive le condizioni senza le quali le misure del prodotto non
valgono niente.

## Background

Su questa macchina girano più agenti insieme, e più di una suite E2E può partire
nello stesso momento. La porta di test (`13334` per default) e il suo server sono
una risorsa condivisa: due run che la usano insieme si cancellano i dati a
vicenda e producono rossi mobili — il tipo di rosso che si insegue per un giorno
e il giorno dopo non c'è più.

## Requirements

### Requirement: E2E-LOCK-01 — Una run non tocca la porta di un'altra run

Il banco E2E SHALL proteggere la porta di test con un lock che nomina il PID e
la working directory di chi la sta usando. Una run che trova il lock tenuto da un
processo VIVO SHALL rifiutarsi di partire, dicendo di chi è la porta.

Lo smontaggio (`global-teardown`) SHALL verificare la proprietà della porta
**prima** di uccidere i processi che vi ascoltano. Il teardown gira sempre,
anche quando il setup ha rifiutato di partire: senza quella verifica, la run
respinta uccide il server della run che il lock stava proteggendo.

Un lock il cui PID è morto, assente o illeggibile NON SHALL bloccare la pulizia:
un lock rimasto per terra dopo un crash congelerebbe la porta per sempre e i
processi orfani si accumulerebbero. Il rimedio non deve essere peggiore del male.

Il lock di chi sta smontando NON SHALL proteggerlo da sé stesso: il caso normale
— la propria run che si chiude — deve pulire esattamente come prima.

> Scritto dal guasto, non dall'ipotesi. Il 25/08/2026 alle 01:37 una run respinta
> dal lock ha comunque stampato `Killed stale processes on port 13334: 45374`,
> facendo morire a metà corsa la suite di un altro agente. Il lock aveva fatto il
> suo lavoro; il teardown l'ha disfatto.

#### Scenario: una run respinta smonta senza uccidere

- **GIVEN** la porta di test è tenuta da un'altra run viva
- **WHEN** il global-teardown di una run respinta gira
- **THEN** non uccide nessun processo su quella porta
- **AND** dice di chi è la porta (PID e cwd)

#### Scenario: un lock morto non congela la porta

- **GIVEN** un lock il cui PID non esiste più
- **WHEN** il teardown gira
- **THEN** la pulizia procede normalmente

#### Scenario: il proprio lock non blocca la propria pulizia

- **GIVEN** il lock appartiene al processo che sta smontando
- **WHEN** il teardown gira
- **THEN** la pulizia procede normalmente

#### Scenario: un lock illeggibile non è un titolare

- **GIVEN** un file di lock scritto a metà
- **WHEN** il teardown lo legge
- **THEN** non lo tratta come una run viva e procede

### Requirement: E2E-GATE-01 — La superficie di test non esiste, fuori dal banco

Le rotte di test — quelle che fotografano e RIPRISTINANO il database riga per
riga, e quelle che seminano stato a cui le API pubbliche non arrivano — SHALL
esistere solo quando una variabile d'ambiente lo dichiara con un valore ESATTO.
Fuori da quel caso SHALL rispondere come rotte che non esistono: un 404, non un
403 e non una rotta disarmata.

Il riconoscimento SHALL essere per valore esatto: nessuna variabile, il valore
spento, una parola che «sembra» accesa, o un ambiente di test dichiarato per
altra via NON SHALL accendere niente. Un default «acceso quando non so»
riaprirebbe il buco senza che nessun test diventi rosso.

> Il difetto era reale e vissuto: una rotta di semina era registrata senza
> condizione, ed è stata l'unica superficie di test raggiungibile anche in
> produzione.

#### Scenario: nessuna variabile
- **GIVEN** un ambiente che non dichiara niente
- **THEN** le rotte di test NON SHALL esistere

#### Scenario: un valore che somiglia a un sì
- **GIVEN** la variabile impostata a una parola diversa dal valore esatto
- **THEN** le rotte di test NON SHALL esistere

### Requirement: E2E-GATE-02 — Il codice che va in produzione sta DENTRO i cancelli, e lo si prova eseguendoli

Ogni cartella il cui contenuto viene DISTRIBUITO SHALL essere compresa nei
programmi dei cancelli — tipi, lint, codice morto. Una suite di test verde su
quella cartella NON SHALL essere scambiata per copertura: i test giravano, e
intanto un errore di tipo, un export morto o una violazione di stile
arrivavano in produzione senza che niente diventasse rosso.

La prova SHALL ESEGUIRE i cancelli e confrontare l'elenco dei file che
dichiarano di aver letto con i file su disco. Verificare la CONFIGURAZIONE non
basta: un'inclusione che non combacia con nessun file, o un comando la cui
configurazione ignora la cartella, sono verdi — ed è esattamente lo stato che
questa regola esiste per rilevare.

Le SCADENZE di questa prova SHALL essere molto sopra il caso a macchina scarica.
È una prova che gira nella barra di review di OGNI card: con dieci agenti che
rivedono insieme, tre misure diventano trenta compilazioni in parallelo, e una
compilazione da tre secondi ne impiega più di sessanta. Un rosso da scadenza qui
non costa una card: costa N card e N agenti che lo rileggono ciascuno per conto
suo.

#### Scenario: una cartella distribuita fuori dai programmi
- **GIVEN** una cartella il cui codice viene distribuito e che nessun cancello legge
- **THEN** la prova SHALL fallire

#### Scenario: configurazione che non combacia
- **GIVEN** un'inclusione che non corrisponde a nessun file
- **THEN** SHALL essere rilevata, perché l'elenco letto è vuoto

### Requirement: E2E-UAT-01 — I video esistono già: quello che mancava era l'elenco, e un video non è un verde

La suite E2E SHALL poter essere GUARDATA senza riscrivere nessun test. Ciò che
serve al generatore della pagina di collaudo non è Gherkin: è un ELENCO dei
video prodotti, con titolo, percorso, esito e durata. La suite ne produce già
centinaia a ogni passata in modalità evidenza — mancava solo la lista.

Un file `.feature` NON SHALL essere richiesto per vedere le prove. Il testo
GIVEN/WHEN/THEN dei requisiti SHALL essere letto come RIPIEGO per il dettaglio
tecnico, non come fonte dei video: senza, la scheda mostra il titolo del test e
il suo esito, che è esattamente ciò che serve per guardarli.

**Un video NON SHALL mai valere come esito positivo.** L'esito SHALL venire dal
rapporto della passata; in sua assenza SHALL essere dichiarato SCONOSCIUTO, mai
verde. La ragione è che il default della suite conserva i video proprio dei
ROSSI: «c'è un video» non può voler dire «è passato», e una pagina di prove che
dichiara verde ciò che non sa è peggio di nessuna pagina.

Un tempo scaduto SHALL contare come fallimento, non come esito sconosciuto.

La regola sull'esito SHALL essere ESPOSTA e non sepolta in un valore di ripiego
scritto in linea: deve essere possibile toglierla e vedere una prova diventare
rossa.

I video SHALL essere COLLEGATI nella cartella che la configurazione già
dichiara, non copiati — sono decine di megabyte a passata — e la copia SHALL
essere il ripiego quando il collegamento non è possibile. La configurazione NON
SHALL essere piegata ai file: sarebbe stato più rapido e avrebbe rotto una
convenzione che il repo si è già dato.

Un titolo SHALL essere ricostruito dal nome della cartella solo quando il
rapporto manca, e NON SHALL essere indovinato: si tolgono il suffisso del
motore e l'impronta, e il resto resta leggibile.

#### Scenario: nessun rapporto
- **GIVEN** un video senza nessuna riga di rapporto che lo riguardi
- **THEN** SHALL essere marcato sconosciuto, mai passato

#### Scenario: un tempo scaduto
- **GIVEN** una prova terminata per tempo scaduto
- **THEN** SHALL contare come fallimento

### Requirement: E2E-GATE-03 — Le rotte di azzeramento NON ESISTONO senza il flag, e la fotografia sopravvive al riavvio

La rotta che AZZERA il database svuota OGNI tabella: l'unica cosa che le impedisce
di esistere sul server vero è il suo cancello, quindi il CANCELLO è la cosa da
verificare — se cede, cede in un posto dove non c'è nessun banco ad accorgersene.

Senza il flag le rotte NON SHALL ESISTERE AFFATTO: non una risposta di rifiuto,
proprio nessuna rotta. Il flag SHALL essere riconosciuto SOLO nella sua forma
esatta.

La fotografia di partenza SHALL vivere sotto la cartella dei dati, cioè PER
FRAMMENTO di esecuzione, e SHALL SOPRAVVIVERE a un riavvio del server — una spec
lo riavvia a metà corsa.

Il ripristino SHALL riportare i contatori di versione SOPRA il massimo corrente: il
client applica l'ultimo-che-scrive-vince su quel numero, e senza il salto
scarterebbe proprio l'idratazione dell'azzeramento.

Un azzeramento SENZA fotografia SHALL essere un CONFLITTO dichiarato, non un
successo che finge di aver ripulito.

#### Scenario: il flag assente
- **GIVEN** nessun flag di banco
- **THEN** le rotte NON SHALL esistere

#### Scenario: nessuna fotografia
- **GIVEN** un azzeramento senza punto di partenza registrato
- **THEN** SHALL essere un conflitto dichiarato

### Requirement: E2E-GATE-04 — Ogni spec dichiara il proprio isolamento, e lo dichiara a LIVELLO DI FILE

OGNI spec del banco SHALL chiamare la funzione che le garantisce uno spazio di
lavoro pulito. È una riga che si DIMENTICA, e dimenticarla non rompe niente IN
QUEL FILE: il conto arriva altrove, su una spec che decine di test più avanti
trova uno spazio che nessuno le ha promesso.

La chiamata SHALL stare a LIVELLO DI FILE, non dentro un raggruppamento: là
dentro si registra sulla suite annidata e gira DOPO le preparazioni del file,
cancellando ciò che quelle hanno seminato.

Importare quella funzione SENZA chiamarla, e chiamarla senza importarla, SHALL
essere un errore.

Il presidio SHALL verificare di avere davvero delle spec da guardare: un
conteggio che scende a zero significa che sta guardando la cartella sbagliata.

#### Scenario: una spec nuova senza la riga
- **GIVEN** una spec che non dichiara l'isolamento
- **THEN** il banco SHALL fallire

#### Scenario: la chiamata dentro un raggruppamento
- **GIVEN** la dichiarazione annidata
- **THEN** il banco SHALL fallire

### Requirement: E2E-GATE-05 — Una run non ruba la porta di un'altra, e quando succede lo DICE

Una corsa del banco SHALL prendere un LUCCHETTO sulla propria porta PRIMA che
parta un solo test, e SHALL RIFIUTARSI di partire quando un'altra corsa viva la
tiene. Il difetto che questo chiude non si vede in nessun rosso: si vede in una
corsa che muore per un motivo che non c'entra niente col codice sotto test.

Un lucchetto il cui processo è MORTO SHALL essere un residuo, e SHALL essere
preso. Un processo VIVO ma con un lucchetto vecchio di ore SHALL essere
considerato un identificativo RICICLATO — nessuna suite dura sei ore — e SHALL
essere preso. Un lucchetto CORROTTO NON SHALL rendere il banco inavviabile per
sempre. Il PROPRIO identificativo NON SHALL bloccare sé stesso.

Il rifiuto SHALL dire la PORTA, CHI la tiene, e COME girare in parallelo. Porte
diverse NON SHALL bloccarsi a vicenda. Rilasciare SHALL togliere il PROPRIO
lucchetto e NON SHALL toccare quello di un altro.

Quando una connessione viene rifiutata, la DIAGNOSI SHALL distinguere: server
VIVO — l'errore è vero e SHALL passare INTATTO; porta che risponde ma lucchetto
cambiato di proprietario — SHALL accusare l'altra corsa dicendo che il database
non è il nostro; identificativo morto ma porta che risponde e lucchetto ancora
nostro — è un RIAVVIO, e SHALL TACERE.

Fuori dal contesto in cui si sa di chi è il lucchetto NON SHALL essere accusato
NESSUNO: qui i falsi positivi costano troppo. Un indizio SHALL essere dichiarato
come tale, non come una certezza.

#### Scenario: un'altra corsa viva sulla stessa porta
- **GIVEN** un lucchetto di un processo vivo e recente
- **THEN** il banco SHALL rifiutarsi di partire, dicendo chi la tiene

#### Scenario: un errore di connessione col server vivo
- **GIVEN** il server che risponde
- **THEN** l'errore SHALL passare intatto, senza diagnosi inventate

### Requirement: E2E-GATE-06 — Il banco non tocca NIENTE che appartenga alla produzione

La preparazione del banco NON SHALL contenere nessuna cancellazione distruttiva
ancorata alla cartella di ESECUZIONE: il server di produzione non ha una cartella
dati separata, quindi quel percorso è il SUO — dentro ci stanno i cookie, la
memoria locale, l'ultimo indirizzo di ogni superficie e gli accessi salvati. Ogni
corsa lanciata dal checkout li cancellava, e le superfici si risvegliavano
sloggate e bianche.

Il database azzerato SHALL essere quello del banco, e la pulizia dello stato dei
navigatori SHALL restare dentro la cartella dati del banco.

Il ponte dei terminali del banco SHALL avere un socket DEDICATO, e lo smontaggio
SHALL uccidere SOLO quello: mai una terminazione per NOME, che porterebbe via
anche il ponte di produzione con dentro le sessioni vive.

I binari di supporto dei terminali SHALL avere il bit di esecuzione: arrivano
dal pacchetto senza, e il ponte muore nel proprio autotest prima di mettersi in
ascolto — tre giri su tre di spec rosse per una ragione che non era il codice.

#### Scenario: una cancellazione ancorata alla cartella di esecuzione
- **GIVEN** una rimozione costruita da quel percorso
- **THEN** il banco SHALL fallire

#### Scenario: lo smontaggio del ponte
- **GIVEN** la fine di una corsa
- **THEN** SHALL essere terminato solo il ponte del banco

### Requirement: E2E-GATE-07 — Un selettore prende UN file, e i banchi lunghi restano fuori dal cancello rapido

Un selettore generato per eseguire una singola spec SHALL selezionare UN SOLO
file: gli argomenti posizionali sono ESPRESSIONI REGOLARI sul percorso, non nomi
di file — misurato su un albero di alcune centinaia di spec, cinque collisioni,
con un nome breve che ne tirava dentro tre.

Il difetto SHALL essere RIPRODOTTO nel banco: il nome nudo usato come espressione
SHALL produrre collisioni, altrimenti il caso è morto e va tolto.

I banchi di MISURA lunghi SHALL portare l'etichetta che li tiene fuori dal
cancello rapido, sia sul raggruppamento sia sul singolo caso, e la
configurazione SHALL escluderli davvero: uno solo dei tre senza etichetta ha
tinto di rosso un commit il cui contenuto non c'entrava niente, dopo un minuto per
tentativo e due ritentativi.

La revisione del navigatore voluta dal server e quella voluta dal banco SHALL
COINCIDERE: due revisioni diverse producono un eseguibile cercato dove non c'è.

Il timeout predefinito dei casi SHALL essere alzato sopra quello dello strumento
in ENTRAMBI i posti che lo governano — la configurazione e la riga di comando di
OGNI script — e i due SHALL portare lo STESSO numero: nessun collegamento tiene
insieme quei due posti, e toglierne uno riapre metà del difetto in silenzio.

#### Scenario: un nome di spec breve
- **GIVEN** un basename che compare in più percorsi
- **THEN** il selettore generato SHALL comunque prenderne uno solo

#### Scenario: uno script che lancia i test
- **GIVEN** uno script senza il timeout dichiarato
- **THEN** il banco SHALL fallire

### Requirement: E2E-GATE-08 — Il banco notturno CHIUDE ciò che apre, e il lavoro di scrittura porta la propria identità

Il flusso notturno SHALL CHIUDERE da sé la segnalazione che ha aperto, quando
torna verde. Il ramo che lo fa esiste — ma misurato su venti corse, in ognuna
risultava SALTATO: non è mai stato eseguito in produzione.

L'apertura e la chiusura SHALL usare la STESSA etichetta, il passo dell'esito
SHALL girare ANCHE quando la suite passa, e la PROMESSA scritta nella
segnalazione SHALL corrispondere al codice che dovrebbe mantenerla.

Nel flusso di verifica, OGNI passo dopo la preparazione SHALL portare la guardia
che lo fa girare comunque: prima erano decine di passi in fila senza condizioni,
e un rosso a metà abortiva il resto — misurato, un mese in cui nulla a valle è
stato misurato. La PREPARAZIONE SHALL restare a fallimento immediato, e i passi
che avevano già una condizione SHALL conservarla.

Ogni scrittura sul sistema di versione dentro una spec SHALL portare la propria
IDENTITÀ, inline o da un supporto condiviso: questo repository l'ha già pagata
tre volte, e l'ultima ha portato giù il ramo principale. Il rilevatore SHALL
essere visto riconoscere il caso nudo e perdonare quello vestito.

#### Scenario: un passo di verifica senza guardia
- **GIVEN** un passo dopo la preparazione senza la condizione
- **THEN** il banco SHALL fallire

#### Scenario: un commit dentro una spec
- **GIVEN** una scrittura senza identità dichiarata
- **THEN** il banco SHALL fallire

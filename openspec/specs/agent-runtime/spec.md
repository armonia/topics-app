## Purpose

Il motore che fa lavorare un agente SENZA una riga di comando in mezzo: come
finisce un turno, come si tiene la conversazione dentro la finestra, cosa gli è
permesso fare, e quando la sua memoria si restituisce.

## Background

TOGLIERE LA RIGA DI COMANDO IN MEZZO COSTA ~206 MB PER DISCORSO IN MENO, e in
cambio obbliga a riscrivere qui dentro tutto ciò che quella riga di comando
faceva gratis: l'autenticazione, la potatura della conversazione, i permessi, lo
sfratto delle sessioni ferme. Ognuno di questi è già stato un guasto vero.

TRE ESEMPI, TUTTI MISURATI. Uno stop scriveva sempre «l'ha chiesto l'utente»,
perché un segnale porta il segnale e non la ragione — e così uno spegnimento del
server si è spacciato per un pulsante premuto a mano. La mappa delle sessioni non
la svuotava nessuno: ogni discorso che aveva avuto un turno teneva la propria
conversazione INTERA nel processo, con ~127 discorsi al giorno e un processo che
oscillava fra 284 MB e 2 GB. E il catalogo dei modelli si era fermato a una
generazione indietro: la guardia scartava la scelta perché non era in elenco, e
OGNI scheda girava sul modello vecchio mentre l'interfaccia ne scriveva un altro
in due punti diversi.

## Requirements

### Requirement: RT-01 — Uno stop porta la sua CAUSA, e l'uscita non è MAI muta

Un annullamento SHALL portare la RAGIONE per cui è avvenuto, e la ragione SHALL
arrivare fino a chi gestisce la fine del turno. Un segnale porta il segnale, non
il motivo: dedurne uno FISSO significa che uno spegnimento del server si presenta
come un pulsante premuto a mano, e chi legge cerca un gesto che nessuno ha fatto.

Un annullamento NON DICHIARATO NON SHALL far inventare una causa: l'assenza è
un'informazione.

L'uscita su annullamento NON SHALL essere MUTA: SHALL essere chiamato l'esito di
annullamento, non un ritorno silenzioso. Senza, non arriva né una conclusione né
un errore, e il cartello che spiega cos'è successo — che parte dalla
finalizzazione — non parte mai.

Uno spegnimento SHALL annullare OGNI turno vivo con la propria causa.

Un comando esterno in esecuzione SHALL ASCOLTARE il segnale e chiudersi SUBITO,
non alla fine del comando: guardare il segnale solo in cima al giro significa
restare dentro un'attesa lunga mentre il processo sta uscendo. Un segnale GIÀ
annullato NON SHALL nemmeno far partire il comando. La chiusura anticipata SHALL
essere DICHIARATA come tale, non come un'uscita senza codice.

Senza segnale il comportamento SHALL restare quello di prima.

#### Scenario: annullamento dentro un comando lungo
- **GIVEN** un annullamento mentre un comando esterno è in esecuzione
- **THEN** il turno SHALL finire subito, e l'esito SHALL dire che è stato interrotto

#### Scenario: annullamento senza ragione dichiarata
- **GIVEN** un annullamento senza causa
- **THEN** NON SHALL essere inventata nessuna causa

### Requirement: RT-02 — Un rinnovo alla volta, e il file delle credenziali non esiste MAI a metà

Il rinnovo di una credenziale a scadenza SHALL essere SERIALIZZATO fra i
processi: la credenziale di rinnovo RUOTA a ogni giro, quindi due rinnovi
paralleli si invalidano a vicenda e il risultato è restare sloggati. N processi
concorrenti SHALL produrre UN solo rinnovo.

Il ripiego a un indirizzo diverso da quello ufficiale SHALL essere ammesso SOLO
verso il loopback, riconosciuto come TALE: un indirizzo che porta il loopback nel
percorso o nelle credenziali dell'URL NON SHALL passare. Un valore assente o
malformato SHALL valere il predefinito, non un buco.

La scrittura SHALL essere ATOMICA: il file NON SHALL MAI esistere a metà — la
stessa credenziale la legge anche la riga di comando ufficiale, e troncarla
significa lasciare sloggata anche quella.

La riscrittura SHALL AGGIORNARE i campi che riguardano il rinnovo e CONSERVARE
tutto il resto del file, compresi i campi che non conosciamo. In un formato a più
account SHALL essere toccato SOLO l'account letto.

Il file SHALL restare leggibile SOLO dal proprietario.

Un file ILLEGGIBILE — troncato da un guasto precedente — NON SHALL bloccare il
rinnovo: SHALL essere riscritto da capo. Un file ASSENTE SHALL essere creato.

#### Scenario: sei processi che rinnovano insieme
- **GIVEN** più processi che trovano la credenziale scaduta
- **THEN** SHALL essere fatto un solo rinnovo

#### Scenario: un campo che non conosciamo
- **GIVEN** un file con campi estranei
- **THEN** SHALL sopravvivere alla riscrittura

### Requirement: RT-03 — La conversazione si pota PRIMA di riempire la finestra, e resta VALIDA

La conversazione SHALL essere alleggerita PRIMA di raggiungere il tetto della
finestra, con un margine: potarla al tetto significa potarla quando è già tardi.

La finestra SHALL essere quella del modello che sta servendo, e la variante a
finestra lunga SHALL essere riconosciuta PRIMA della famiglia. L'ordine dei
controlli è il difetto: con la famiglia controllata per prima, due famiglie su
quattro uscivano dichiarando la finestra corta pur avendo quella lunga, e la
conversazione veniva compattata a un quinto dello spazio che aveva davvero.

Un modello SCONOSCIUTO SHALL prendere il valore PRUDENTE, mai il più generoso.

La RICHIESTA INIZIALE SHALL sopravvivere IDENTICA: è ciò che dice all'agente
perché sta lavorando. La CODA RECENTE SHALL restare intatta.

Ogni richiesta di strumento SHALL conservare la propria risposta: una potatura
che le separa produce una conversazione che l'interfaccia del modello RIFIUTA. I
risultati vecchi SHALL essere SVUOTATI, non CANCELLATI — svuotarli toglie il peso
e lascia in piedi la struttura.

L'originale NON SHALL essere modificato: chi chiama decide se sostituirlo.

Una conversazione troppo corta per essere potata SHALL restare com'è, e una
vuota SHALL costare zero.

#### Scenario: la variante a finestra lunga
- **GIVEN** un modello con il suffisso della finestra lunga
- **THEN** SHALL essere dichiarata la finestra lunga, su qualunque famiglia

#### Scenario: dopo la potatura
- **GIVEN** una conversazione potata
- **THEN** ogni richiesta di strumento SHALL avere ancora la propria risposta

### Requirement: RT-04 — La storia si ricostruisce dal database, e si RIPARA senza inventare risposte

Dopo un riavvio la conversazione SHALL essere ricostruita dalle righe salvate: un
discorso con dentro del lavoro vero NON SHALL sentirsi rispondere che non c'è
niente.

Un turno TAGLIATO A METÀ NON è una risposta e SHALL essere scartato; le righe
senza testo NON SHALL entrare. Una storia che comincia con l'assistente SHALL
essere tagliata fino alla prima domanda; senza nessuna domanda SHALL essere
VUOTA, mai mezza. Due turni consecutivi dello stesso ruolo SHALL essere ricuciti,
e l'ORDINE fra «togli l'ultima domanda» e «fondi» SHALL essere quello che
conserva la domanda rimasta senza risposta. Un ruolo sconosciuto SHALL cadere su
quello dell'utente invece di far saltare il turno.

Una richiesta di strumento rimasta SENZA risposta SHALL essere POTATA, e NON
SHALL essere inventata nessuna risposta al suo posto: è la differenza fra
riparare e falsificare. Il TESTO dell'assistente attorno SHALL sopravvivere — era
lavoro vero — ma un messaggio che conteneva SOLO quella richiesta SHALL sparire,
perché un contenuto vuoto è a sua volta rifiutato.

La verifica SHALL essere POSIZIONALE: una risposta separata dalla domanda da un
altro messaggio NON è una risposta, e una risposta che compare nel messaggio
sbagliato non conta.

Una storia SANA SHALL passare IDENTICA, senza costo.

#### Scenario: una richiesta di strumento orfana
- **GIVEN** una richiesta di strumento senza la sua risposta
- **THEN** SHALL essere potata, e NESSUNA risposta SHALL essere inventata

#### Scenario: una risposta lontana dalla sua domanda
- **GIVEN** una risposta separata dalla domanda da un altro messaggio
- **THEN** la domanda SHALL essere considerata orfana

### Requirement: RT-05 — Il suffisso della finestra lunga ESCE dall'identificativo e diventa una richiesta

Un identificativo di modello che porta il suffisso della finestra lunga SHALL
essere tradotto in DUE cose: il nome NUDO, e la richiesta della finestra. Mandare
l'identificativo col suffisso significa chiedere un modello che non esiste.

Il suffisso SHALL valere solo in CODA: lo stesso testo in mezzo non è una
variante. Un identificativo senza suffisso SHALL restare identico.

Le due richieste — quella permanente e quella della finestra — SHALL viaggiare
in UNA sola intestazione separate da virgola: due intestazioni con lo stesso nome
vengono collassate e l'ultima vince in silenzio.

Un rifiuto specifico della finestra lunga SHALL diventare una FRASE
comprensibile, non un errore grezzo; ogni ALTRO errore SHALL restare INTATTO —
travestire ciò che non si capisce manda a cercare la cosa sbagliata.

#### Scenario: il suffisso in mezzo
- **GIVEN** un identificativo che porta quel testo non in coda
- **THEN** NON SHALL essere trattato come variante

#### Scenario: un rifiuto diverso
- **GIVEN** un errore che non riguarda la finestra lunga
- **THEN** SHALL restare intatto

### Requirement: RT-06 — Il catalogo dei modelli coincide con ciò che il codice sa davvero eseguire

Il catalogo offerto SHALL contenere il modello PREDEFINITO: la guardia scarta
ciò che non è in elenco, e un predefinito fuori catalogo viene scartato come
tutti gli altri.

La finestra lunga SHALL essere RAGGIUNGIBILE: almeno un identificativo che la
porta SHALL essere offerto, e ogni identificativo con la finestra lunga SHALL
avere anche la propria versione NUDA.

NON SHALL esserci doppioni né nomi vuoti.

Il banco SHALL essere visto MORDERE: il catalogo di PRIMA del guasto SHALL essere
BOCCIATO da questi stessi controlli. Senza questa prova, un banco verde non
distingue «il catalogo è aggiornato» da «il controllo non guarda niente».

#### Scenario: il catalogo di prima del guasto
- **GIVEN** il catalogo fermo alla generazione precedente
- **THEN** il banco SHALL fallire

#### Scenario: un identificativo a finestra lunga
- **GIVEN** un identificativo con la finestra lunga nel catalogo
- **THEN** SHALL esistere anche la sua versione nuda

### Requirement: RT-07 — Il difetto NON è «tutto permesso», e l'elenco dell'irreversibile è il criterio

Il livello di autonomia PREDEFINITO NON SHALL essere quello che permette tutto:
le righe di comando partivano così, ma quel valore descriveva un programma
altrui — qui l'esecuzione è NOSTRA. Un valore SCONOSCIUTO SHALL cadere sul
predefinito, mai su quello permissivo.

I livelli SHALL restare TRE e distinti. Al livello che CHIEDE, leggere e cercare
SHALL essere sempre consentito e scrivere ed eseguire SHALL essere negato con un
motivo che l'agente possa USARE. Al livello intermedio il lavoro normale SHALL
passare e le operazioni CHE NON SI ANNULLANO SHALL essere fermate, con un motivo
che lo dica.

L'elenco dell'irreversibile SHALL essere l'UNICO criterio con cui cresce: ogni
riga SHALL essere una cosa che non si annulla. Il caso peggiore — la
cancellazione ricorsiva della radice o della cartella personale — SHALL essere
compreso.

I FALSI POSITIVI che renderebbero il livello inservibile SHALL essere verificati
come PASSANTI: un comando di uso quotidiano che somiglia a uno distruttivo deve
passare, o il livello viene spento da chi lo usa.

Il filtro lavora sul TESTO, quindi un falso positivo È POSSIBILE: SHALL essere
DICHIARATO, con una via d'uscita praticabile. Un limite noto e scritto è una
scelta; lo stesso limite non scritto è una sorpresa.

#### Scenario: un comando che somiglia a uno distruttivo
- **GIVEN** un comando di uso quotidiano col nome simile
- **THEN** SHALL passare

#### Scenario: un valore di autonomia sconosciuto
- **GIVEN** un livello non riconosciuto
- **THEN** SHALL valere il predefinito, non quello permissivo

### Requirement: RT-08 — Una sessione ferma si sfratta, un turno vivo MAI

Le sessioni tenute in memoria SHALL essere SFRATTATE dopo un tempo di inattività:
senza, ogni discorso che ha avuto un turno tiene la propria conversazione INTERA
nel processo finché il server non riparte.

Il confine SHALL essere STRETTO, non largo: esattamente al tetto la sessione
RESTA.

Un turno VIVO NON SHALL essere toccato MAI, per quanto vecchia sia la sessione.

Il banco SHALL provare che quella guardia MORDE: senza di essa il caso del turno
vivo SHALL fallire. Un caso verde che resterebbe verde anche senza la protezione
che dovrebbe verificare non prova niente.

#### Scenario: esattamente al tetto
- **GIVEN** una sessione ferma da esattamente il tempo del tetto
- **THEN** SHALL restare

#### Scenario: una sessione vecchia con un turno vivo
- **GIVEN** una sessione oltre il tetto ma con un turno in corso
- **THEN** NON SHALL essere sfrattata

### Requirement: RT-09 — I comandi di Topics sono gli STESSI, e un guasto in uno non uccide il turno

I comandi propri di Topics SHALL essere raggiungibili anche dall'agente nativo, e
SHALL essere la STESSA implementazione usata dalle righe di comando: due
implementazioni degli stessi comportamenti divergono al primo rimedio applicato a
una sola.

SHALL essere tradotti nella forma che l'interfaccia del modello richiede.

Il profilo ridotto usato per il lavoro dispacciato SHALL offrirne MENO: gli
schemi si pagano a OGNI chiamata.

NESSUN nome SHALL collidere con i comandi di programmazione, che passano da
un'altra strada.

Un comando SCONOSCIUTO SHALL DIRLO, non esplodere. Un gestore che SOLLEVA SHALL
diventare un RISULTATO DI ERRORE e il turno SHALL sopravvivere: un'eccezione che
risale uccide il turno per un comando andato storto.

#### Scenario: un gestore che solleva
- **GIVEN** un comando il cui gestore fallisce
- **THEN** SHALL diventare un risultato di errore, e il turno SHALL continuare

#### Scenario: un nome inventato
- **GIVEN** un comando che non esiste
- **THEN** SHALL essere dichiarato sconosciuto

### Requirement: RT-10 — Cambiare il motore predefinito NON lascia nessuno senza agenti

Il motore PREDEFINITO SHALL essere scelto in modo che chi NON ha ciò che serve
resti comunque con un motore funzionante: un aggiornamento NON SHALL lasciare una
bacheca che non dispaccia più. Nessun risparmio di memoria vale quel prezzo.

Un motore REGISTRATO ma non CONNESSO NON SHALL prendere il posto di chi risponde.
Senza NIENTE di connesso SHALL restare l'unico registrato, mai «nessuno».

Una scelta ESPLICITA di fornitore SHALL vincere sul motore.

Un percorso assoluto che NON ESISTE NON SHALL essere dichiarato connesso: un
comando che contiene una barra non è per ciò stesso un comando presente, e
crederlo fa entrare in graduatoria un motore che al primo turno fallisce.

Nella tabella degli agenti esterni SHALL entrare SOLO quello che qualcuno ha
CHIESTO — dall'ambiente o dalle impostazioni salvate, che SHALL contare allo
stesso modo.

Il banco NON SHALL misurare le credenziali di chi lo esegue: un caso verde a casa
e rosso altrove sullo stesso codice misura la macchina, non la regola.

#### Scenario: il motore predefinito non è installato
- **GIVEN** nessun motore predefinito disponibile
- **THEN** SHALL restare quello precedente, non «nessuno»

#### Scenario: un percorso assoluto inesistente
- **GIVEN** un comando assoluto che non esiste sul disco
- **THEN** NON SHALL essere dichiarato connesso

### Requirement: RT-11 — Il runtime si prova contro l'interfaccia VERA, non solo a unità

SHALL esistere un banco che esercita il motore contro l'interfaccia REALE del
modello: streaming, uso degli strumenti, permessi, memoria della richiesta e
sessioni concorrenti. Le parti pure si provano a unità, ma «l'agente lavora
davvero» non è una proprietà di una funzione pura.

La prova di una modifica al disco SHALL essere LETTA DAL DISCO, non dal racconto
che l'agente ne fa.

Al livello che CHIEDE l'agente NON SHALL toccare il disco per quanto glielo si
chieda. Al livello intermedio un comando irreversibile SHALL essere rifiutato E
il turno SHALL restare vivo.

I punti di memorizzazione del prefisso NON SHALL ACCUMULARSI: oltre il numero
massimo consentito l'intera richiesta viene rifiutata, e un turno che muore dopo
qualche giro per un'ottimizzazione di costo è peggio dell'ottimizzazione.

Più sessioni insieme SHALL vivere in UN SOLO processo, con storie SEPARATE.

Gli strumenti SHALL essere confinati alla cartella di lavoro, e il confine SHALL
essere calcolato per PERCORSO RELATIVO: una cartella vicina con lo stesso
prefisso di nome resta FUORI.

Una modifica AMBIGUA NON SHALL scrivere niente e SHALL dirlo; una su testo
ASSENTE SHALL dire che non l'ha trovato; una ricerca senza risultati NON SHALL
essere un errore.

#### Scenario: una cartella vicina con lo stesso prefisso
- **GIVEN** un percorso fuori dalla cartella di lavoro ma con lo stesso prefisso
- **THEN** SHALL restare fuori

#### Scenario: un comando irreversibile al livello intermedio
- **GIVEN** un comando che non si annulla
- **THEN** SHALL essere rifiutato, e il turno SHALL restare vivo

### Requirement: EFFORTRES-01 — L'impegno si risolve per gradini, e un valore ignoto NON diventa un valore

La risoluzione dell'impegno SHALL scendere per gradini dichiarati: una scelta
esplicita dell'app vince su tutto; poi la variabile d'ambiente specchiata; poi la
configurazione della persona; poi il valore predefinito.

Un valore NON RICONOSCIUTO SHALL risolversi in NIENTE — nessun sovrascrittura
passata, nessun distintivo mostrato — invece di diventare un valore a caso.

La configurazione della persona SHALL vincere sul predefinito, mai declassarlo, e
SHALL leggere solo le chiavi al livello di radice: una chiave dentro una tabella
è di un'altra cosa.

La scelta per argomento SHALL vincere anche sulla variabile dell'app, SHALL
essere insensibile a maiuscole e spazi, e un valore nullo, vuoto o sconosciuto
SHALL cadere sul predefinito d'ambiente. Senza né scelta né ambiente SHALL restare
il predefinito dichiarato.

Gli ALIAS deprecati SHALL essere ancora onorati, con UN avviso; la forma nuova
SHALL vincere in silenzio.

Il selettore per argomento sul percorso del terminale SHALL leggere la scelta
dalla riga; un argomento senza scelta SHALL cadere sul predefinito globale; un
identificativo assente NON SHALL produrre nessuna interrogazione né errore; e un
argomento inesistente, o un'interrogazione fallita, NON SHALL bloccare
l'accensione.

Il tetto ai risultati degli strumenti esterni SHALL esistere per difetto, SHALL
essere spostabile con un intero, e un valore ILLEGGIBILE NON SHALL spegnerlo in
silenzio: chi scrive un numero vuole un tetto.

#### Scenario: un livello di impegno sconosciuto
- **GIVEN** un valore fuori vocabolario
- **THEN** NON SHALL essere passato nessun sovrascrittura

#### Scenario: un tetto illeggibile
- **GIVEN** un valore non numerico
- **THEN** il tetto NON SHALL essere spento

### Requirement: PROMPT-01 — Il prompt dice COME aspettare, e i tre strumenti restano distinti

La direttiva di lingua SHALL essere UNA riga e SHALL nominare la lingua; con una
lingua scelta SHALL CHIUDERE il prompt, che è dove si legge per ultima.

Il prompt SHALL contenere la parte sui processi.

**SHALL dire COME aspettare**, perché è la scelta che un agente sbaglia più
spesso: il sorvegliante per le attese lunghe, l'attesa diretta per quelle corte.
Il sorvegliante SHALL essere offerto SE C'È.

Sui comandi in secondo piano il prompt NON SHALL vietare, ma SHALL dire DA COSA
DIPENDE che il risveglio arrivi davvero.

**I tre strumenti SHALL restare DISTINTI**: quello che chiude e sveglia, quello
che tiene e torna, e quello che dipende. Confonderli è come si aspetta per sempre
qualcosa che era già finito.

#### Scenario: senza il sorvegliante disponibile
- **GIVEN** lo strumento non presente
- **THEN** NON SHALL essere offerto

#### Scenario: una lingua scelta
- **GIVEN** la lingua dichiarata
- **THEN** la direttiva SHALL chiudere il prompt

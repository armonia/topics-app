## Purpose

Come un agente chiede una cosa a una persona, dove quella domanda arriva, e come
è scritta. È l'unico momento in cui il lavoro si ferma ad aspettare un essere
umano, quindi è anche l'unico in cui perdere il messaggio costa un turno intero.

## Background

TRE PEZZI, TRE MODI DI SBAGLIARE. Riconoscere che un attrezzo è una DOMANDA e
non un'azione; consegnarla a chi la deve vedere; scriverla in modo che si legga.
Ognuno dei tre ha già rotto qualcosa: un modello che manda cinquanta domande in
una volta, un pannello ancora cliccabile su un turno che lo sweeper aveva
dichiarato morto, e una frase italiana lunga disegnata dentro un blocco di
codice, che in una colonna stretta diventa una riga sola da scorrere in
orizzontale.

## Requirements

### Requirement: ASK-01 — Una domanda si riconosce, e un attrezzo malformato non si butta via

Il sistema SHALL riconoscere come domanda un attrezzo il cui nome è quello
nativo o il ponte che Topics espone, e SHALL trattarli allo STESSO modo: la
riga di comando in modalità non interattiva non registra l'attrezzo nativo, e
senza il ponte una domanda non arriverebbe mai.

Il riconoscimento SHALL essere per nome ESATTO e non per prefisso.

Un attrezzo generico SHALL contare come domanda solo quando dichiara uno schema
di risposta.

Un contenuto MALFORMATO NON SHALL essere scartato: SHALL essere consegnato
grezzo, così che si veda che qualcosa è stato chiesto. Una domanda singola
illeggibile dentro un gruppo SHALL cadere da sola, senza portarsi via le altre;
se cadono tutte, il gruppo intero SHALL diventare grezzo.

Il numero di domande e di opzioni SHALL essere LIMITATO: un modello che sbaglia
non deve poter riempire lo schermo di controlli. Un'opzione sola non è una
scelta, e una domanda che ne offre meno di due SHALL essere scartata.

Un errore restituito dall'attrezzo — un tempo scaduto, per esempio — SHALL
chiudere lo stato di attesa esattamente come una risposta.

#### Scenario: un nome che somiglia
- **GIVEN** un attrezzo il cui nome comincia come quello della domanda ma non coincide
- **THEN** NON SHALL essere trattato come una domanda

#### Scenario: una domanda rotta fra quelle buone
- **GIVEN** un gruppo in cui una domanda non ha testo
- **THEN** SHALL cadere quella sola, e le altre SHALL restare

### Requirement: ASK-02 — L'attesa è fatta di tratti brevi, e nessuno muore mentre il pannello è a schermo

L'attesa di una risposta NON SHALL essere una connessione tenuta aperta a lungo:
SHALL essere una successione di tratti brevi che si richiamano. La prima domanda
vera è morta proprio così, su una connessione ferma a zero byte che il client ha
chiuso per inattività.

Una sessione SHALL avere UNA domanda in volo: una seconda SHALL soppiantare la
prima, e la prima SHALL essere rigettata invece di restare appesa.

Il cronometro SHALL partire al PRIMO tratto e i successivi SHALL essere muti,
altrimenti un sondaggio ogni pochi secondi terrebbe viva la domanda per sempre.

Lo stato «c'è una domanda in attesa» SHALL essere letto dalla domanda e NON dal
tratto in corso: nei buchi fra un tratto e l'altro il turno sembrerebbe muto, e
qualcuno lo chiuderebbe.

La decisione se chiudere una domanda vecchia SHALL essere una funzione a tre
esiti — niente, rimanda, chiudi — e SHALL sbagliare dal lato di NON uccidere:
quando non si sa se il processo è vivo, SHALL rimandare.

Una risposta che arriva quando nessuno sta più aspettando SHALL essere
BUFFERIZZATA per una finestra breve, non persa.

Annullare una domanda SHALL produrre un errore dell'attrezzo, mai una risposta
inventata.

> Il difetto che ha prodotto questa regola: uno sweeper degli stream fermi
> chiudeva il turno dopo tre minuti di silenzio mentre il pannello era ancora
> cliccabile, con ventidue minuti sul cronometro.

#### Scenario: una risposta dopo la scadenza di un tratto
- **GIVEN** un tratto già scaduto e una risposta che arriva subito dopo
- **THEN** la risposta SHALL essere consegnata al tratto successivo

#### Scenario: non si sa se il processo è vivo
- **GIVEN** una domanda vecchia e nessuna informazione sul processo
- **THEN** SHALL essere rimandata, non chiusa

### Requirement: ASK-03 — Se la sessione appartiene a un task, la domanda arriva sulla card

Quando la sessione che chiede appartiene a un task, la domanda SHALL comparire
nel FILO di quella card e non soltanto nella scheda della sessione: è la card
che una persona guarda.

L'introduzione SHALL dire CHI sta chiedendo, distinguendo la sessione del task da
una sua sessione di lavoro figlia.

Ogni task SHALL avere UNA domanda instradata alla volta, e i tratti successivi
della stessa domanda NON SHALL riscrivere il commento.

La risposta SHALL essere consegnata alla sessione che ha chiesto — che può essere
una figlia e non il coordinatore — e il registro SHALL essere svuotato COMUNQUE,
riuscita o no: una domanda che resta appesa dopo che si è risposto è peggio di
una domanda senza risposta.

Una risposta vuota NON SHALL essere consegnata e NON SHALL lasciare la domanda
appesa.

Una sessione che non appartiene a nessun task SHALL restare nella propria scheda.

#### Scenario: risponde il coordinatore per una figlia
- **GIVEN** una domanda instradata da una sessione figlia
- **WHEN** si risponde dalla card
- **THEN** la risposta SHALL raggiungere la figlia

### Requirement: ASK-04 — Una domanda si legge in verticale

Una domanda trasportata nel filo SHALL potersi rendere in prosa invece che dentro
un recinto di codice, e la conversione NON SHALL cambiare ciò che il lettore
delle OPZIONI vede: i bottoni continuano a leggere la forma originale.

Un testo che non contiene un recinto di domanda SHALL essere restituito
IDENTICO.

Un recinto MALFORMATO — aperto e mai chiuso, o vuoto — NON SHALL essere toccato:
meglio un blocco brutto che una frase mangiata da un'espressione regolare.

Il testo prima e dopo il recinto SHALL essere conservato.

> I blocchi di codice si disegnano con lo scorrimento orizzontale e senza andare
> a capo. Una frase italiana lunga, in una colonna stretta, diventava una riga
> sola da scorrere di lato.

#### Scenario: un blocco di codice vero
- **GIVEN** un commento che contiene un blocco di codice di un linguaggio
- **THEN** SHALL essere restituito invariato

### Requirement: PERM-01 — Un permesso si risolve per corrispondenza SCRITTA, mai indovinando

Una richiesta di permesso SHALL essere identificata dalla coppia sessione più
identificativo della chiamata, MAI dalla sola sessione: la riga di comando emette
più richieste nello stesso turno — misurate a **170 ms** di distanza — e una
chiave per sessione le confonderebbe.

Rispondere a una richiesta NON SHALL rispondere a un'altra.

**Un identificativo sconosciuto NON SHALL risolversi MAI, nemmeno quando c'è una
sola richiesta aperta.** L'euristica «ce n'è una sola, quindi è quella» è
esattamente ciò che è vietato: un sì dato al posto di un altro è il peggiore
degli errori possibili qui dentro. Una corrispondenza SCRITTA invece SHALL
risolversi — perché è una corrispondenza, non un indovinello — e SHALL morire
insieme alla propria richiesta.

L'attesa SHALL essere fatta di tratti brevi che si richiamano, perché una
richiesta ferma a zero byte muore lato client per inattività e nessuna pazienza
lato server la salva. Una decisione arrivata PRIMA che qualcuno si metta in
attesa NON SHALL perdersi; una decisione consegnata senza nessuna richiesta
aperta NON SHALL essere messa da parte per nessuno.

Il tratto che scade SHALL essere normale amministrazione, non la fine della
richiesta. Ma i tratti successivi NON SHALL rimettere a zero l'orologio della
RICHIESTA, o l'interrogazione periodica la terrebbe viva per sempre — e l'età
esposta SHALL essere quella della più VECCHIA, o l'esenzione dalle reti di
sicurezza non finirebbe mai.

Passare la sessione a un regime libero SHALL sbloccare TUTTE le richieste aperte
di QUELLA sessione, dicendo quali, e SHALL riportare anche gli identificativi
delle righe a schermo — altrimenti il pannello resta disegnato su una richiesta
che non esiste più. NON SHALL toccare le altre sessioni.

L'annullamento di una sessione SHALL sbloccare tutte le sue attese con un errore
LEGGIBILE; l'annullamento singolo SHALL toccare solo la propria.

#### Scenario: un identificativo che non conosciamo
- **GIVEN** una decisione per un identificativo sconosciuto, con una sola richiesta aperta
- **THEN** NON SHALL essere risolta

#### Scenario: due richieste nello stesso turno
- **GIVEN** due richieste di permesso aperte insieme
- **THEN** rispondere a una NON SHALL rispondere all'altra

### Requirement: PERM-02 — Nel dubbio il pannello SI DISEGNA, e il bersaglio si giudica sul bersaglio

Il pannello del permesso SHALL essere disegnato sulla riga che gli corrisponde, e
in caso di dubbio SHALL essere RIDISEGNATO. Il verso è dichiarato: **un pannello
in più è visibile e si corregge; uno in meno è una richiesta che nessuno vedrà
mai.**

Quando l'identificativo non corrisponde a nessuna riga, SHALL essere usata
l'ULTIMA riga in attesa con lo STESSO nome di attrezzo, e la corrispondenza SHALL
essere SCRITTA come alias. Una riga già CONCLUSA NON SHALL essere un bersaglio, e
un attrezzo DIVERSO in attesa NON SHALL attirare il pannello.

«Già disegnato» SHALL essere giudicato sul BERSAGLIO, non sull'identificativo di
partenza: dopo un alias sono due cose diverse.

Il contenuto strutturato della riga SHALL avere la precedenza sull'elenco più
vecchio quando entrambi esistono, in ENTRAMBE le direzioni: sia per ridisegnare
sia per non ridisegnare. Quando il contenuto strutturato non copre la riga SHALL
essere usato l'elenco.

Un contenuto illeggibile, di forma inattesa o vuoto NON SHALL far cadere niente:
SHALL portare a ridisegnare.

#### Scenario: la riga è già conclusa
- **GIVEN** una riga con lo stesso nome di attrezzo ma già terminata
- **THEN** NON SHALL essere usata come bersaglio

#### Scenario: dati illeggibili
- **GIVEN** un contenuto della riga che non si riesce a interpretare
- **THEN** il pannello SHALL essere ridisegnato

### Requirement: PERM-03 — Un piano si fa approvare, e approvare non è preselezionato

Quando un turno in modalità di pianificazione si conclude avendo prodotto un
PIANO, il sistema SHALL chiedere di approvarlo.

Con più piani nello stesso turno SHALL vincere l'ULTIMO: il modello riscrive il
piano dopo aver letto altro, e approvare una versione superata è approvare
qualcosa che nessuno ha proposto.

NON SHALL essere chiesto: fuori dalla modalità di pianificazione — lì un piano
scritto è una nota di lavoro — su un turno INTERROTTO o in errore (non ha
proposto, ha smesso), e su un piano VUOTO, che non è una domanda.

La richiesta SHALL essere una domanda ORDINARIA, resa dal pannello che esiste
già: introdurre una superficie parallela per questo caso significherebbe
mantenerne due.

**Approvare SHALL essere consigliato ma NON preselezionato**: l'approvazione non
deve poter avvenire senza un gesto. L'opzione SHALL dichiarare che l'autonomia
cambia — non deve succedere di nascosto.

Approvare e rifiutare SHALL essere distinguibili. La risposta a un'ALTRA domanda
NON SHALL essere letta come una decisione sul piano, e nemmeno una risposta di
testo libero.

#### Scenario: due piani nello stesso turno
- **GIVEN** un turno che ha prodotto due piani
- **THEN** SHALL essere proposto l'ultimo

#### Scenario: un turno interrotto
- **GIVEN** un turno in pianificazione terminato per interruzione
- **THEN** NON SHALL essere chiesta nessuna approvazione

### Requirement: ASK-05 — Rispondere si può SCRIVENDO in chat, e il testo va alla domanda

Chi risponde a una domanda SCRIVENDO nel campo della chat SHALL vedere il proprio
testo arrivare ALLA DOMANDA, non finire in coda: la coda si svuoterebbe solo dopo
aver fatto la cosa che l'agente non sta facendo, e chi ha risposto resta fermo
fino allo scadere dell'attesa — un'ora e mezza, col cronometro che scorre.

Con una domanda a schermo il campo SHALL DICHIARARLO — nell'invito e nel comando
di invio — e NON SHALL comparire nessuna bolla in coda.

#### Scenario: si scrive con una domanda aperta
- **GIVEN** una domanda a schermo e del testo scritto in chat
- **THEN** il testo SHALL essere consegnato come risposta, non accodato

#### Scenario: l'invito del campo
- **GIVEN** una domanda a schermo
- **THEN** il campo SHALL dichiarare che si sta rispondendo

### Requirement: ASK-06 — Il pannello si risponde a STEP, il consiglio si vede, e nulla è preselezionato

Un pannello di domanda SHALL essere azionabile a schermo e la risposta SHALL
tornare a chi l'ha chiesta, facendo RIPRENDERE il turno.

Più domande insieme SHALL essere presentate UNA ALLA VOLTA, con l'avanzamento
dichiarato, il passo avanti DISABILITATO finché non c'è una risposta, il ritorno
indietro che CONSERVA quanto scelto, e UN SOLO invio finale con tutte le
risposte.

L'opzione CONSIGLIATA SHALL essere segnalata come tale, comunque il modello
l'abbia dichiarata, e il segnale NON SHALL restare dentro il titolo dell'opzione.
NESSUNA opzione SHALL essere PRESELEZIONATA: una scelta preselezionata è una
scelta che qualcuno non ha fatto.

La possibilità di rispondere LIBERAMENTE SHALL esistere, e scrivere nel campo
libero SHALL selezionarla da sé.

Mentre il pannello è a schermo NON SHALL comparire un cronometro di lavoro: non si
sta lavorando, si sta aspettando una persona.

Il pannello SHALL SOPRAVVIVERE a un'attesa lunga, attraverso decine di tratti
brevi: chi si alza dalla scrivania deve ritrovarlo lì.

#### Scenario: tre domande insieme
- **GIVEN** più domande in una sola richiesta
- **THEN** SHALL essere presentate una alla volta, con un solo invio finale

#### Scenario: l'opzione consigliata
- **GIVEN** un'opzione dichiarata consigliata
- **THEN** SHALL essere segnalata, e NON SHALL essere preselezionata

### Requirement: PERM-04 — I tre esiti di un permesso, e quello che libera la sessione libera SOLO questa

Un pannello di permesso SHALL dire COSA si sta per fare e con QUALI argomenti, e
SHALL risolversi in un CLICK. NON SHALL offrire una risposta libera: non è una
domanda, è una decisione.

Gli esiti SHALL essere DISTINTI: consentire ORA, consentire SEMPRE, liberare la
SESSIONE, e NEGARE. Negare SHALL tornare a chi ha chiesto come un NO, non come un
silenzio — ogni richiesta senza canale di risposta diventava un no muto.

«Sempre» SHALL scrivere una regola, e la volta successiva NESSUNO SHALL essere
disturbato. La regola SHALL essere RITROVABILE e RITIRABILE dalle impostazioni, e
dopo il ritiro la richiesta SHALL tornare a essere posta.

Liberare QUESTA conversazione NON SHALL liberare le altre.

Il pannello SHALL essere dipinto dal SERVER e SHALL sopravvivere a un
caricamento da zero: seminarlo già pronto prova che il pannello funziona, non che
il server sappia produrlo — ed è esattamente il caso in cui non compariva.

Una decisione NON RICONOSCIUTA SHALL essere un rifiuto dichiarato: né un sì per
inerzia, né un no muto. Un click su un pannello che non ha più nessuno sotto
SHALL DIRLO, invece di sparire.

Gli strumenti PROPRI di Topics NON SHALL MAI chiedere il permesso di essere sé
stessi: per mostrare un pannello servirebbe il permesso di mostrare un pannello.

#### Scenario: «sempre», poi il ritiro
- **GIVEN** una regola scritta e poi ritirata dalle impostazioni
- **THEN** la richiesta successiva SHALL tornare a essere posta

#### Scenario: una decisione sconosciuta
- **GIVEN** un esito non riconosciuto
- **THEN** SHALL essere rifiutato esplicitamente

### Requirement: PERM-05 — Un piano si fa approvare anche quando lo strumento per chiederlo non esiste

Nella modalità in cui il modello può solo pianificare, lo strumento per chiedere
l'approvazione NON è fra quelli esposti: il modello non può agire e non può
chiedere. A schermo restava il cartello che dichiara un turno chiuso senza
prodotto, sopra una colonna di azioni riuscite, e il piano non si vedeva.

Topics SHALL chiedere l'approvazione LEI, con lo STESSO pannello di ogni altra
domanda.

Il piano SHALL essere MOSTRATO e RESO come testo formattato, non come blocco
grezzo. Lo strumento dichiarato SHALL essere il PIANO, non l'azione che il
modello avrebbe voluto compiere, e NON SHALL nominare il file che avrebbe
toccato.

Su un piano NON SHALL essere offerta una risposta libera.

La domanda SHALL comparire SOPRA il campo di scrittura e ACCANTO ad esso, non
persa in mezzo alla conversazione.

Approvare SHALL ALZARE l'autonomia, o il turno riparte nella stessa trappola.

Lo stesso cancello SHALL valere per un piano scritto in sola PROSA, dove non
esiste nessuna riga di strumento a cui appendere la domanda.

#### Scenario: un piano in sola prosa
- **GIVEN** un piano senza nessuna riga di strumento
- **THEN** l'approvazione SHALL essere chiesta lo stesso

#### Scenario: approvare
- **GIVEN** un piano approvato
- **THEN** l'autonomia SHALL essere alzata

### Requirement: PERM-06 — Il canale umano taglia corto sulle NOSTRE mani, e la decisione trova la richiesta anche per NOME

Una richiesta di permesso su uno strumento PROPRIO di Topics SHALL essere
consentita SUBITO, senza aprire nessun appuntamento e senza dipingere nessun
pannello: per mostrare un pannello servirebbe il permesso di mostrare un
pannello.

Una riga già DIPINTA come in attesa NON SHALL essere ridipinta; una NON dipinta
SHALL essere marcata e SHALL far partire il fotogramma del pannello.

La decisione SHALL ritrovare la propria richiesta anche quando torna con
l'identificativo della RIGA invece che quello dello strumento: senza l'alias
scritto al momento dell'attesa, il clic cade nel vuoto.

Una decisione non riconosciuta SHALL essere un rifiuto di richiesta, non un sì
per inerzia; un pannello senza più nessuno sotto SHALL essere un conflitto
dichiarato, non un successo muto. Un rifiuto SHALL essere consegnato COM'È e
SHALL restare scritto sulla riga.

«Passa a libero» SHALL consentire ORA senza far vedere quella decisione a chi ha
chiesto, SHALL alzare l'autonomia della sola sessione corrente, SHALL lasciare
una TRACCIA con chi e quando, SHALL essere REVERSIBILE, e NON SHALL lasciare
appesi altri pannelli già aperti.

Una regola SHALL richiedere un modello; un carattere jolly NUDO NON SHALL essere
una regola. Un percorso che non appartiene a questo canale NON SHALL essere
rivendicato.

#### Scenario: uno strumento nostro
- **GIVEN** una richiesta di permesso su uno strumento di Topics
- **THEN** SHALL essere consentita subito, senza pannello

#### Scenario: la decisione torna con l'identificativo della riga
- **GIVEN** un clic che porta l'identificativo della riga
- **THEN** la richiesta SHALL essere ritrovata

### Requirement: ASK-07 — La bozza di una risposta è PER DOMANDA, scade, e la corruzione non rompe il pannello

Ciò che si scrive in un pannello prima di rispondere SHALL sopravvivere a un
ricaricamento, e SHALL essere conservato PER DOMANDA, non per sessione: la bozza
di una domanda NON SHALL comparire sotto un'altra.

Rispondere SHALL cancellare la bozza. Svuotare tutto SHALL cancellare, non
lasciare un registro vuoto.

Una bozza VECCHIA NON SHALL riapparire mesi dopo sotto una domanda nuova: SHALL
esistere una scadenza, e una pulizia che toglie le scadute lasciando le vive.

Un contenuto CORROTTO NON SHALL rompere il pannello.

Un avanzamento senza risposta NON SHALL contare come una risposta a metà.

#### Scenario: due domande diverse
- **GIVEN** una bozza scritta su una domanda
- **THEN** NON SHALL comparire sotto un'altra

#### Scenario: uno storage corrotto
- **GIVEN** un contenuto illeggibile
- **THEN** il pannello SHALL aprirsi lo stesso

### Requirement: ASK-08 — Il testo libero vale come risposta SOLO quando non c'è niente da indovinare

Il testo scritto in chat SHALL valere come risposta a una domanda SOLO se la
domanda è UNA e la sua forma lo permette.

Il testo NON SHALL essere agganciato a un'opzione: rispondere con la prima
quando qualcuno ha scritto «boh, la prima» è un indovinello.

Per un'APPROVAZIONE il testo libero NON SHALL MAI valere: fra due opzioni
esatte, «vai» e «no direi» sono un indovinello — e indovinare male ESEGUE un
piano che si voleva rifiutare. Il gesto è il pulsante, e il campo di scrittura non
deve promettere il contrario.

Con PIÙ domande, o con una forma che richiede una struttura, SHALL restare il
pannello: la prosa non riempie uno schema.

Una domanda in attesa rimasta appesa in un turno PRECEDENTE NON SHALL essere
considerata aperta: è il fantasma di uno stream perso, e mandarle una risposta la
farebbe sparire nel nulla. Un testo VUOTO NON SHALL essere una risposta.

#### Scenario: un'approvazione
- **GIVEN** una domanda di approvazione e del testo scritto
- **THEN** il testo NON SHALL valere come risposta

#### Scenario: una domanda appesa da un turno precedente
- **GIVEN** un'attesa rimasta da un turno finito
- **THEN** NON SHALL essere considerata aperta

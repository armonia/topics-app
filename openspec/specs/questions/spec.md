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

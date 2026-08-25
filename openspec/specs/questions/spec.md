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

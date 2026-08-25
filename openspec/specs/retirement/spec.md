## Purpose

Cosa succede alle cose che un task si lascia dietro: le pane aperte, le sessioni
di terminale, i contesti browser, le tab, e l'immagine che dichiarava il
risultato. Il ritiro non è la cancellazione — è la dichiarazione che una risorsa
non rappresenta più niente, scritta dove qualcuno la possa leggere invece che
dedotta dal silenzio.

## Background

IL RITIRO È UN FATTO, NON UN'ASSENZA. La tabella `retirements` tiene una riga
per ogni cosa ritirata con il MOTIVO accanto, e i motivi non sono decorazione:
al 25/08/2026 sono 1.829 righe, e si dividono in `backfill:archived` (725),
`tab-close` (555), `reconcile:registry` (478) e `archive` (71). Sono quattro
strade diverse per arrivare allo stesso stato, e senza il motivo scritto non si
distingue una pane chiusa da chi lavora da una pane che il riconciliatore ha
trovato senza padrone.

L'ANTEPRIMA È IL CASO CHE SPIEGA IL RESTO. Su 291 card con un'immagine di
risultato, 21 sono state ritirate — e venti di quelle ventuno con questa
motivazione: «l'immagine era byte per byte identica a quella di altre card: non
era evidenza di questo lavoro». Un'anteprima che non prova niente è peggio di
nessuna anteprima, perché occupa il posto della prova e sembra una. Ritirarla
lascia la card senza immagine E con scritto perché — che è l'unica forma in cui
un'assenza si può verificare.

## Requirements

### Requirement: RETIRE-01 — Il ritiro è una riga scritta, e la prima vince

Il sistema SHALL tenere UN registro dei ritiri — specie, riferimento, istante,
motivo — e SHALL scriverlo da un punto solo. Prima che quel registro esistesse
la stessa domanda si faceva a tre posti diversi e le tre risposte divergevano:
misurato il 03/08/2026, undici sessioni di terminale vive per tab chiuse a
luglio, e due topic ancora «aperti» chiusi da settimane.

La PRIMA scrittura SHALL vincere: `retired_at` risponde a «quando è stato
chiuso», non a «quando ne abbiamo parlato l'ultima volta». Un secondo ritiro
sullo stesso riferimento NON SHALL spostare l'istante né il motivo, e SHALL
dichiarare di non aver cambiato niente — è la riga stessa a rendere idempotente
tutto ciò che le sta sopra.

Le specie SHALL restare separate: ritirare una pane non ritira il topic che
porta lo stesso identificatore.

Un ritiro SHALL essere reversibile, e anche la ritrattazione SHALL dire se ha
cambiato qualcosa.

«Aperto» SHALL richiedere DUE cose insieme: che il registro non porti un ritiro,
e che il fatto — la riga del topic, la sessione viva — sia ancora lì.

#### Scenario: ritiro ripetuto
- **GIVEN** una risorsa già ritirata
- **WHEN** la si ritira di nuovo
- **THEN** l'istante e il motivo SHALL restare quelli della prima volta
- **AND** l'operazione SHALL dichiarare di non aver scritto niente

#### Scenario: due specie, due registri
- **GIVEN** una pane e un topic con lo stesso identificatore
- **THEN** ritirare l'una NON SHALL ritirare l'altro

### Requirement: RETIRE-02 — Chiudere una tab ritira ciò che conteneva, e si ferma lì

Quando una pane viene chiusa il sistema SHALL ritirare anche il suo contenuto:
la chat che portava SHALL essere archiviata, la sessione di terminale SHALL
essere ritirata e il suo processo chiuso. La cascata SHALL fermarsi a quel
livello: nessuna pane ne trascina un'altra, e nessun altro task viene toccato.

Una pane di servizio, che non porta né una chat né un terminale, SHALL ritirare
sé stessa e nient'altro.

Il TIMBRO SHALL precedere la conseguenza, sempre. Se il processo muore a metà
deve restare lo stato «so che va ritirato e non l'ho fatto», che il riconcilio
sa recuperare — mai il suo contrario.

Ogni conseguenza SHALL essere isolata dalle altre: un'archiviazione che fallisce
NON SHALL impedire il ritiro della sessione di terminale.

Il segnale di chiusura SHALL essere il TOMBSTONE, mai la semplice assenza della
pane dallo snapshot. L'idratazione fra dispositivi è un'UNIONE: un telefono che
non ha mai saputo di una pane la manda assente senza che nessuno l'abbia chiusa.

Il contenuto da ritirare SHALL essere letto dal verbale di chiusura prima che
dallo snapshot precedente: quello porta il contenuto ESATTO al momento della
chiusura, compresi i metadati di terminale che una pane nuda non ha sempre.

Una ritrattazione SHALL essere applicata PRIMA dei ritiri dello stesso
aggiornamento, e SHALL toccare anche il contenuto: riaprire solo la pane
lascerebbe il topic timbrato «ritirato» mentre la chat è di nuovo a schermo.

#### Scenario: assenza senza tombstone
- **GIVEN** uno snapshot in cui una pane non compare, e nessun tombstone per lei
- **THEN** NON SHALL essere ritirato niente

#### Scenario: tombstone su una pane ancora viva
- **GIVEN** un tombstone che arriva mentre la pane è ancora nello snapshot
- **THEN** SHALL essere trattato come uno stato di transito, e si SHALL aspettare
  l'aggiornamento successivo

#### Scenario: un marcatore illeggibile
- **GIVEN** un tombstone privo dell'istante, o uno snapshot che non è un oggetto
- **THEN** NON SHALL essere deciso niente, in nessuna delle due direzioni

#### Scenario: una conseguenza che fallisce
- **GIVEN** una pane che porta sia una chat sia un terminale, e un'archiviazione
  che solleva un errore
- **THEN** la sessione di terminale SHALL essere ritirata lo stesso

#### Scenario: una scrittura rifiutata
- **GIVEN** un aggiornamento respinto dal controllo di concorrenza
- **THEN** NON SHALL essere archiviato niente e NON SHALL essere timbrato niente

### Requirement: RETIRE-03 — Il riconcilio è asimmetrico, e lo è di proposito

Il riconcilio fra il registro e i fatti SHALL muoversi in una direzione sola:
quando il FATTO dice ritirato e il registro dice aperto, SHALL chiudere il
registro; quando il registro dice chiuso e il fatto tace, SHALL timbrare il
fatto e NON SHALL riaprire niente.

La simmetria sarebbe un difetto, non una raffinatezza: riaprire un topic che
qualcuno ha archiviato, solo perché il registro non ne sapeva nulla,
resusciterebbe una chat che l'utente aveva chiuso.

Il riconcilio SHALL essere convergente: un secondo giro subito dopo il primo
NON SHALL scrivere niente.

Una riapertura fatta da una persona NON SHALL essere annullata dal riconcilio
successivo.

#### Scenario: il registro è indietro
- **GIVEN** un topic archiviato e un registro che lo dà per aperto
- **THEN** il registro SHALL essere chiuso

#### Scenario: il fatto è indietro
- **GIVEN** un registro che dà una risorsa per ritirata e un fatto che tace
- **THEN** il fatto SHALL essere timbrato
- **AND** NON SHALL essere riaperto niente

#### Scenario: riaperto da una persona
- **GIVEN** una chat riaperta da chi la stava usando
- **WHEN** il riconcilio gira
- **THEN** la chat SHALL restare aperta

### Requirement: RETIRE-04 — Una nota che dichiara l'anteprima assente smette quando l'anteprima arriva

Il sistema SHALL riconoscere le note che affermano «questa card non ha
un'anteprima» e SHALL smettere di mostrarle quando la card un'anteprima ce l'ha.
La nota NON SHALL essere cancellata: la storia resta, cambia solo cosa si legge
adesso.

Il riconoscimento SHALL avvenire sul TESTO e non sulla categoria della nota, e
SHALL essere ancorato all'inizio della stringa. Le note in questione portano la
stessa categoria di molte altre, e ciò che le rende obsolete è quello che dicono;
l'ancora distingue la nota vera dalla frase di una persona che la cita.

Una nota che parla del server d'anteprima e non della card NON SHALL entrare in
questo insieme.

Un'anteprima di RIPIEGO generata dal server NON SHALL far tacere la nota:
non è evidenza del lavoro, quindi l'affermazione «non c'è un'anteprima di questa
card» resta vera.

#### Scenario: l'anteprima è arrivata
- **GIVEN** una card con una nota «anteprima ritirata» e un'immagine vera
- **THEN** la nota SHALL essere considerata superata

#### Scenario: solo un ripiego
- **GIVEN** una card la cui unica immagine è la scheda di consegna generata dal server
- **THEN** la nota SHALL restare valida

### Requirement: RETIRE-05 — Una sessione si parcheggia solo dopo due avvistamenti, e non si cancella mai

Il sistema SHALL censire le sessioni vive che nessuna superficie nomina più, e
il censimento SHALL essere SENZA EFFETTI: conta e riferisce, non agisce.

Una sessione SHALL essere considerata nominata se la trova ANCHE UNA SOLA delle
forme in cui una superficie può nominarla — il registro globale delle pane, il
layout di progetto, le pane di un progetto, una tab autonoma — e SHALL essere
risparmiata anche quando compare soltanto nella pila delle pane appena chiuse.
La generosità è deliberata: la domanda è «qualcuno la sta ancora usando?», e
qualunque risposta parziale vale sì.

Le sessioni ATTACCATE e quelle dei sotto-agenti NON SHALL mai essere candidate,
qualunque cosa dicano le superfici.

L'azione, quando c'è, SHALL essere il PARCHEGGIO e mai la cancellazione: un
falso positivo su un parcheggio costa un click, su una cancellazione costa una
conversazione.

Il parcheggio SHALL richiedere DUE giri consecutivi che nominano la stessa
candidata. Un solo avvistamento NON SHALL bastare, e una pane che ricompare fra i
due giri SHALL annullare il conteggio. In sessantotto giri fra il 04/08 e il
10/08/2026 il censimento non ha mai nominato una sessione: la soglia esiste
perché il primo avvistamento vero sarà quasi sempre un artefatto.

Un elenco di superfici VUOTO NON SHALL produrre candidate per nessun numero di
giri: zero righe non è «nessuno la usa», è «non ho letto niente».

Una riga di stato illeggibile NON SHALL far saltare il censimento né inventare
riferimenti.

Il parcheggio SHALL avere un interruttore, e da spento il censimento SHALL
continuare a contare.

#### Scenario: nominata una volta sola
- **GIVEN** una sessione nominata da una sola delle superfici
- **THEN** NON SHALL essere candidata

#### Scenario: il primo avvistamento
- **GIVEN** una sessione che nessuno nomina, al primo giro
- **THEN** NON SHALL essere parcheggiata

#### Scenario: nessuna superficie da leggere
- **GIVEN** zero righe di stato
- **THEN** NON SHALL essere parcheggiato niente, per quanti giri si facciano

### Requirement: RETIRE-06 — La raccolta dei browser orfani gira una volta sola, e ha un pavimento

Il sistema SHALL chiudere all'AVVIO i processi browser rimasti senza padrone,
riconosciuti dal marchio che porta il pid di chi li ha aperti, insieme ai loro
processi figli. La raccolta SHALL girare SOLO al boot: trattare un pid marcato
come proprio equivale a dire «è il residuo di un pid riciclato», che è vero
all'avvio e falso — e distruttivo — in ogni altro momento.

Un PAVIMENTO SHALL rifiutare tre bersagli qualunque cosa dica il piano: il
processo di sistema, l'intero gruppo di processi, e il server stesso. Il
pavimento SHALL essere provato contro un piano che li includa: è la sola forma
in cui una difesa si dimostra.

Una fotografia dei processi che NON risponde SHALL valere «non ho guardato», mai
«è pulito», e il sistema SHALL dirlo invece di procedere.

Un processo già morto fra la lettura e la chiusura NON SHALL fermare il resto
del piano.

La chiusura SHALL essere immediata e non negoziata: su un processo giudicato
senza padrone un'uscita pulita non compra niente, e un browser che si impunta
lascerebbe in piedi esattamente la perdita che la raccolta esiste per chiudere.

Un avvio senza orfani SHALL essere silenzioso.

#### Scenario: un piano bacato
- **GIVEN** un piano che includa il processo di sistema o il server stesso
- **THEN** quei bersagli SHALL essere rifiutati, e il rifiuto SHALL essere detto

#### Scenario: la fotografia non risponde
- **GIVEN** una lettura dei processi che fallisce
- **THEN** NON SHALL essere chiuso niente
- **AND** il sistema SHALL dichiarare di non aver guardato

### Requirement: RETIRE-07 — Le tab di un task le scrive il server, e le porta via l'archiviazione

Le tab di browser aperte per un task SHALL essere scritte dal SERVER e non solo
dal client: un task dispacciato mentre nessuna finestra è aperta non avrebbe
altrimenti nessuno che le registri, e arriverebbe in review senza il proprio
risultato.

L'identità di un CONTESTO SHALL essere distinta per nome: due nomi diversi SHALL
dare due tab diverse, o la seconda pagina consegnata sovrascrive la prima. Le
forme che un contesto può assumere NON SHALL potersi sovrapporre fra loro — il
gemello dentro lo spazio di lavoro compreso, che deve restare riconducibile alla
propria tab o il login salvato non lo eredita.

La scrittura SHALL essere idempotente per contesto — mai un duplicato, l'indirizzo
e il titolo aggiornati sul posto — e un titolo SHALL poter essere sostituito solo
da uno di autorità pari o maggiore, nell'ordine persona › agente › automatico.

Una riscrittura IDENTICA NON SHALL scrivere né annunciare niente: bruciare un
numero di sequenza senza cambiare nulla fa lavorare a vuoto ogni client.

Un errore di persistenza NON SHALL far fallire l'apertura del browser.

L'ARCHIVIAZIONE di un task SHALL portare via le sue chiavi di stato, quelle di
tutto il suo sottoalbero comprese, a qualunque profondità. Un task `done` ma NON
archiviato SHALL conservarle: misurato l'11/08/2026, 84 delle 91 righe accumulate
appartenevano proprio a quel caso, ed è la falla che questa regola tappa.

Lo smontaggio SHALL avvenire in due tempi: prima la transazione che legge e
cancella le chiavi, e SOLO DOPO il commit la chiusura dei contesti, ciascuna
best-effort. Un contesto che non esiste più NON SHALL far fallire la pulizia.

Il ripasso all'avvio SHALL rifiutarsi di considerare orfana qualunque chiave
quando la tabella dei task è VUOTA: una tabella vuota è un errore di lettura, non
un permesso a svuotare tutto.

#### Scenario: due scritture identiche
- **GIVEN** una tab già registrata
- **WHEN** arriva la stessa identica registrazione
- **THEN** NON SHALL essere scritto né annunciato niente

#### Scenario: un task chiuso ma non archiviato
- **GIVEN** un task `done` che nessuno ha archiviato
- **THEN** le sue chiavi SHALL restare

#### Scenario: la tabella dei task è vuota
- **GIVEN** un ripasso all'avvio con zero task in tabella
- **THEN** NON SHALL essere considerata orfana nessuna chiave

### Requirement: RETIRE-08 — Si spazza solo ciò che porta il NOSTRO marchio, e «zero righe» non è «tutto pulito»

I processi di browser che il sistema avvia SHALL portare un MARCHIO che ne
dichiara il ruolo e chi li possiede, e la spazzata SHALL toccare SOLO quelli.
Un processo che non porta quel marchio NON SHALL essere toccato MAI: sulla stessa
macchina girano browser di altri strumenti, e ucciderli è un danno fuori dal
proprio dominio.

**Essere senza padre NON vuol dire essere orfani.** Dei cinque processi senza
padre trovati il 12/08/2026 — sulla stessa macchina dove ne erano vivi 28 per
1.461 MB — DUE erano ausiliari di un browser VIVO e legittimo. Il criterio SHALL
essere il possessore scritto nel marchio, non la parentela.

Un marchio che nomina il processo CORRENTE, all'avvio, SHALL essere trattato come
un identificativo RICICLATO: quel processo non può averlo scritto.

Due server vivi in parallelo SHALL risparmiarsi a vicenda.

Gli ausiliari SHALL essere attribuiti al proprio browser; quelli che non sono
attribuibili a nessuno NON SHALL essere toccati — muoiono da soli col processo
che li ha creati. Il profilo condiviso NON SHALL portare a uccidere l'ausiliario
di un browser vivo.

**Un'uscita VUOTA NON SHALL valere «tutto pulito»**: il piano SHALL dichiarare
quante righe ha letto, o «non ho trovato niente» e «non ho guardato» si leggono
uguali.

Il piano SHALL essere DETERMINISTICO e ORDINATO, e SHALL nominare gli
identificativi con il proprio motivo: un elenco senza motivi non è contestabile
da nessuno.

#### Scenario: un browser di un altro strumento
- **GIVEN** un processo di browser senza il nostro marchio
- **THEN** NON SHALL essere toccato

#### Scenario: nessuna riga letta
- **GIVEN** una lettura che non ha prodotto righe
- **THEN** il piano SHALL dichiarare di non aver visto niente, distinto da «pulito»

### Requirement: RETIRE-09 — Si parcheggia alla SECONDA conferma, e uno stato vuoto non è una conferma

Una sessione giudicata orfana NON SHALL essere parcheggiata alla PRIMA
osservazione: SHALL servire una seconda conferma in un giro successivo. Una
sessione ricomparsa fra i due giri NON SHALL essere parcheggiata.

**Uno stato dell'interfaccia VUOTO NON È «nessuno la mostra».** È l'errore che
trasforma questo meccanismo in un massacro: zero righe lette danno un insieme di
riferimenti vuoto, e quindi TUTTE le sessioni risultano orfane. Un giro che non
ha visto nessuna struttura NON HA GUARDATO, e NON SHALL agire.

Un giro BLOCCATO NON SHALL lasciare conferme al giro successivo, e SHALL dire
PERCHÉ si è bloccato.

Con l'interruttore spento SHALL essere fatto il censimento e NON SHALL essere
toccato niente.

Con più orfane insieme SHALL essere parcheggiata solo quella che ha la seconda
conferma.

Il resoconto SHALL NOMINARE gli identificativi parcheggiati — «due orfane» non è
smentibile da nessuno — e SHALL distinguere «non ho parcheggiato» da «aspetto la
conferma».

#### Scenario: lo stato dell'interfaccia è vuoto
- **GIVEN** un giro in cui non si legge nessuna struttura di riferimento
- **THEN** NON SHALL essere parcheggiato niente

#### Scenario: ricomparsa fra i due giri
- **GIVEN** una sessione orfana al primo giro e presente al secondo
- **THEN** NON SHALL essere parcheggiata

### Requirement: RETIRE-10 — Una riga appesa si chiude solo se nessuno può più rispondere — tranne il permesso

Una chiamata di attrezzo rimasta APPESA SHALL essere chiusa con un errore SOLO
quando la sessione che la teneva è morta. Bollarla interrotta mentre la sessione
è viva è il modo in cui una domanda VIVA diventava un avviso col tasto «riprova»
al primo ricaricamento del codice.

Su una sessione VIVA un attrezzo in corso può ancora consegnare e una domanda può
ancora essere risposta: NON SHALL essere toccati.

**Il PERMESSO è l'eccezione, e ha una ragione:** il suo appuntamento muore col
processo, quindi resta a schermo un pannello che invita a un gesto che non può
più arrivare — successo il 07/08/2026 con due pannelli rimasti su turni morti,
mentre il processo continuava a elencare la sessione. Il permesso SHALL essere
chiuso anche a sessione viva: il peggio che può fare è un lampo, mentre non
chiuderlo lascia una bugia permanente — e se la sessione è davvero viva, il
pannello si ridisegna da sé.

Ciò che è GIÀ finito NON SHALL essere riscritto: un errore già scritto da chi
sapeva di più SHALL restare, e un istante di fine già registrato NON SHALL essere
spostato.

#### Scenario: una domanda su una sessione viva
- **GIVEN** una domanda a schermo e la sessione ancora viva
- **THEN** NON SHALL essere chiusa

#### Scenario: un permesso su una sessione viva
- **GIVEN** un pannello di permesso e la sessione ancora viva
- **THEN** SHALL essere chiuso comunque

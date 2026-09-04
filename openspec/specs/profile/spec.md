## Purpose

Il profilo di una persona: quanto ha lavorato, chi lo può vedere, e cosa esce
fuori da Topics quando lo si mette in un README. Sono tre domande diverse e solo
la prima è un calcolo — le altre due sono confini.

## Background

I NUMERI VENGONO SOLO DALLE TABELLE CHE QUALCUNO SCRIVE DAVVERO. Tre tabelle
esistono nello schema e sono strutturalmente vuote su questa installazione. Un
profilo che le leggesse mostrerebbe «0 sessioni» a chi ha lavorato per mesi, e
«0» non si legge come «dato mancante»: si legge come «non hai fatto niente».

IL COSTO NON È UN NUMERO SOLO. Le righe scritte prima che il campo di rilettura
della cache esistesse hanno un costo gonfiato fino a dieci volte, e non è
ricostruibile a posteriori. Sommarle a quelle buone produce un totale che sembra
una misura. Restano due grandezze separate: quello che si è misurato, e quante
righe non si è potuto misurare.

LA CACHE SI CONTA UNA VOLTA SOLA, E LE DUE CONVENZIONI SONO OPPOSTE. Sui
messaggi i token del prompt includono già la rilettura; sui turni degli agenti no
e va sommata. Trattarle allo stesso modo mostrava 18,03 miliardi di token contro
9,89 reali — un fattore 1,82.

## Requirements

### Requirement: PROFILE-01 — Un numero mancante si dichiara, non si finge zero

Le statistiche di profilo SHALL essere calcolate SOLO da tabelle che il sistema
scrive davvero, e le tabelle strutturalmente vuote NON SHALL essere lette.

I token della cache SHALL essere contati UNA VOLTA SOLA, rispettando la
convenzione della fonte: dove il totale del prompt li include già NON SHALL
essere sommati di nuovo, dove li esclude SHALL esserlo.

Il costo SHALL essere diviso in due grandezze MAI sommate fra loro: quello
effettivamente misurato, e il NUMERO di righe che non è stato possibile misurare.
Le seconde SHALL essere CONTATE, non nascoste: una riga esclusa in silenzio è un
buco che nessuno vede.

Le statistiche NON SHALL essere messe in cache. Un numero che dice «questo sei tu
oggi» calcolato su una cache mostra ieri.

Un database vuoto o non ancora pronto SHALL produrre la forma vuota, mai un
errore: il profilo è la pagina che si apre per prima.

#### Scenario: un turno quasi tutto rilettura
- **GIVEN** un turno in cui la rilettura della cache è quasi tutto il prompt
- **THEN** il totale NON SHALL essere quasi il doppio di quello vero

#### Scenario: righe di costo non misurabili
- **GIVEN** righe scritte prima che la rilettura fosse registrata
- **THEN** SHALL essere contate a parte, e NON SHALL entrare nel totale misurato

### Requirement: PROFILE-02 — Un giorno di lavoro conta anche se non ci hai parlato

Un giorno SHALL contare come attivo anche quando l'unica traccia è lavoro della
board — un task portato a termine — senza nessun messaggio scritto. Chi dispaccia
e lascia lavorare gli agenti sta lavorando.

La serie degli ultimi trenta giorni SHALL essere CONSECUTIVA e completa: i giorni
senza attività SHALL comparire come zero esplicito, non essere saltati. Una serie
con i buchi tolti disegna una costanza che non c'è stata.

La striscia di giorni consecutivi SHALL tollerare la giornata in corso: la
mattina, prima di aver fatto qualcosa, la striscia di ieri SHALL essere ancora
viva. Un giorno intero saltato SHALL azzerarla.

La presenza «adesso» SHALL distinguere le sessioni APERTE da quelle che stanno
davvero lavorando, e i turni vivi NON SHALL essere sommati ai task della board:
sono due popolazioni diverse contate due volte.

#### Scenario: solo lavoro della board
- **GIVEN** un giorno con un task completato e nessun messaggio
- **THEN** SHALL contare come giorno attivo

#### Scenario: la mattina presto
- **GIVEN** una striscia viva fino a ieri e nessuna attività oggi
- **THEN** la striscia SHALL essere ancora contata

### Requirement: PROFILE-03 — Cinque interruttori, e l'email è l'unico spento di partenza

La visibilità di un profilo SHALL essere governata da interruttori distinti —
profilo, statistiche, email, elenchi di chi segue, ultima presenza — e ognuno
SHALL agire da solo.

L'email SHALL essere l'unico SPENTO di default: è l'unico dato che serve a
raggiungere una persona fuori da Topics.

Gli interruttori SHALL essere leggibili e scrivibili SOLO dal proprietario: a
chiunque altro SHALL essere rifiutato anche in scrittura, e una scrittura
rifiutata NON SHALL toccare il database. La scrittura SHALL essere PARZIALE, e
SHALL ignorare le chiavi sconosciute e i valori che non sono booleani — una
stringa NON SHALL essere convertita in un valore di verità.

A profilo chiuso la persona SHALL diventare irraggiungibile: assente dalla
rubrica e dagli elenchi, e il profilo stesso SHALL rispondere come se non
esistesse — indistinguibile da un identificativo inventato. Il proprietario SHALL
continuare a vedersi.

Un legame di «seguo» già esistente SHALL essere sempre CANCELLABILE, anche verso
un profilo chiuso. Chiudere il proprio profilo non deve poter intrappolare
qualcun altro in una relazione che non può sciogliere.

La stessa regola sull'ultima presenza SHALL valere ovunque quel dato compaia,
elenchi dei membri di un'organizzazione compresi: una manopola che vale in un
posto solo non è una manopola.

#### Scenario: uno sconosciuto chiede gli interruttori
- **GIVEN** una persona diversa dal proprietario
- **THEN** lettura e scrittura SHALL essere rifiutate, e il database SHALL restare intatto

#### Scenario: profilo chiuso, legame esistente
- **GIVEN** un profilo chiuso e qualcuno che già lo segue
- **THEN** un nuovo legame SHALL essere rifiutato e quello esistente SHALL potersi sciogliere

### Requirement: PROFILE-04 — La rubrica non è l'elenco di tutti

L'elenco delle persone SHALL contenere SOLO chi condivide un'organizzazione con
chi guarda, più chi lo segue e chi è seguito da lui. NON SHALL mai essere la
tabella intera.

Un legame di «seguo» SHALL rendere raggiungibile un profilo anche senza
organizzazione in comune, nelle DUE direzioni. Il legame SHALL essere
ASIMMETRICO: seguire qualcuno non fa risultare che quel qualcuno segua te.

Il conteggio di chi segue SHALL essere calcolato PER CHI GUARDA, non letto grezzo
dalla tabella: un numero che comprende persone che il lettore non può vedere è un
numero che non corrisponde all'elenco sotto.

Seguire sé stessi SHALL essere rifiutato ESPLICITAMENTE, non ignorato in
silenzio.

L'elenco delle persone NON SHALL toccare la rete: un profilo agganciato a un
servizio esterno senza dati in cache SHALL comunque comparire, senza nessuna
chiamata in uscita.

#### Scenario: nessuna organizzazione in comune, un legame sì
- **GIVEN** due persone senza organizzazioni condivise, una segue l'altra
- **THEN** entrambe SHALL comparire nella rubrica dell'altra

#### Scenario: la rubrica non chiama fuori
- **GIVEN** una richiesta dell'elenco persone
- **THEN** SHALL essere fatte ZERO chiamate di rete

### Requirement: PROFILE-05 — Il biglietto da visita si regge da solo, e non disegna quello che non ha

Il riquadro pubblicabile del profilo — quello destinato a un README letto fuori
da Topics — SHALL essere AUTOSUFFICIENTE: nessun carattere tipografico esterno,
nessuna immagine collegata, nessun foglio di stile remoto. Viene scaricato una
volta sola da un proxy e servito da lì per sempre; tutto ciò che non è dentro non
arriverà mai.

Con tutti i giorni a zero, il grafico dell'attività NON SHALL essere disegnato:
una linea piatta a metà altezza racconta una costanza inventata. Il riquadro
vuoto è il dato.

I numeri grandi SHALL essere abbreviati, il costo NO: è l'unico numero che
qualcuno può confrontare con un estratto conto. Un costo misurato pari a zero
SHALL essere detto a parole — la macchina è di chi la usa — invece di stampare
una cifra a zero che sembra una misura. Un costo con righe non misurate SHALL
dichiararsi come minimo, non come totale.

Qualunque testo libero che finisce nel riquadro SHALL essere neutralizzato: un
nome ostile NON SHALL produrre struttura né rompere il documento.

#### Scenario: nessuna attività in trenta giorni
- **GIVEN** trenta giorni tutti a zero
- **THEN** NON SHALL essere disegnata nessuna linea

#### Scenario: un nome che contiene struttura
- **GIVEN** un nome con dentro dei tag
- **THEN** il documento SHALL restare valido e il nome SHALL restare testo

### Requirement: PROFILE-06 — La pagina chiesta sopravvive al secondo montaggio, e scade

Quando si chiede di aprire una pagina del profilo, la richiesta SHALL restare
disponibile finché non viene consumata ESPLICITAMENTE: leggerla NON SHALL
cancellarla. Il pannello arriva a pezzi e si monta due volte, e la prima lettura
si mangiava la richiesta lasciando la seconda a mani vuote.

La richiesta SHALL SCADERE dopo una finestra breve, e oltre quella finestra SHALL
restare persa anche alle letture successive: una richiesta immortale si aggancia
al primo gesto scollegato che apre quel pannello mezz'ora dopo.

Fra due richieste in successione SHALL vincere l'ULTIMA.

#### Scenario: doppio montaggio del pannello
- **GIVEN** una richiesta di pagina letta una prima volta
- **THEN** SHALL essere ancora leggibile alla seconda

#### Scenario: passata la finestra
- **GIVEN** una richiesta più vecchia della finestra di validità
- **THEN** SHALL essere nulla, e restare nulla

### Requirement: PROFILE-07 — Chi è stato TOLTO resta visibile, in una coda a parte

Una persona revocata SHALL restare VISIBILE in una coda separata: la colonna che
la marca era letta in cinque punti e nessuna schermata poteva scriverla, quindi
una persona invitata per sbaglio restava nel database per sempre, fuori da ogni
elenco.

Chi è tolto SHALL stare SOLO fra i tolti e chi è presente SOLO fra i presenti:
nessuna sovrapposizione, nessuna sparizione. Con nessun tolto la coda SHALL
essere vuota; con tutti tolti l'elenco vivo SHALL essere vuoto e NESSUNO SHALL
sparire.

I tolti SHALL SOPRAVVIVERE alla lettura della risposta del server: un filtro
applicato lì li faceva non arrivare affatto. Una risposta senza elenco, o
assente, NON SHALL essere un errore: è un elenco vuoto.

Ogni persona tolta SHALL avere il proprio gesto di cancellazione, sulla persona
GIUSTA. Senza nessun tolto NON SHALL essere disegnata né la coda né un titolo che
annuncia una sezione vuota.

Il motivo di un rifiuto SHALL comparire, e durante un'operazione i gesti SHALL
essere disabilitati.

#### Scenario: tutti tolti
- **GIVEN** nessuna persona viva
- **THEN** nessuno SHALL sparire

#### Scenario: nessun tolto
- **GIVEN** nessuna persona revocata
- **THEN** NON SHALL essere disegnato nessun titolo

### Requirement: AUTHOR-01 — Sullo schermo va un NOME, l'identità resta nel dettaglio

La riga di chi ha scritto SHALL mostrare un NOME leggibile, e MAI un ruolo di
sistema o un identificativo. Le tre righe che questo esiste per correggere sono
«user» dove l'app sa il nome, «dispatcher» dove ha agito l'app, e otto caratteri
di identificativo dove va un nome.

Le righe della persona che sta guardando SHALL portare il SUO nome. Senza un
proprietario noto SHALL restare una PERSONA generica, non un ruolo di sistema.

Un agente NON SHALL mostrare il proprio esadecimale, ma SHALL conservarlo PER
INTERO nel dettaglio che il chiamante mette nel suggerimento: il nome sta sullo
schermo, l'identità sta nel dettaglio, e niente si perde per strada.

Una FRASE non è un nome: SHALL ricadere sul generico invece di stamparne metà.
Chi verifica SHALL avere un nome proprio, distinto sia dalla persona sia
dall'agente.

Nessun nome SHALL essere MAI vuoto, per qualunque cosa arrivi dal disco. Ogni
chiave di nome SHALL esistere nel dizionario.

#### Scenario: un agente
- **GIVEN** una riga scritta da un agente
- **THEN** SHALL mostrare un nome, e l'identificativo SHALL restare intero nel dettaglio

#### Scenario: dati storti sul disco
- **GIVEN** un autore illeggibile
- **THEN** il nome mostrato NON SHALL essere vuoto

### Requirement: BANNER-SHARE-01 — Un link che funziona solo su questo computer NON è condivisibile, e lo DICE

Il markdown del banner del profilo SHALL essere costruito sull'origine con cui
qualcun altro può raggiungerlo, e quando quell'origine NON è pubblica il testo
copiato SHALL essere ACCOMPAGNATO da un avviso.

Il difetto non si risolve inventando un dominio: finché il banner esce da una
macchina personale, nessuna stringa lo rende raggiungibile. Si risolve DICENDOLO,
prima di incollare — perché altrimenti si scopre solo dopo, che è il momento
peggiore.

SHALL contare come NON pubblici il nome locale della macchina, l'indirizzo di
ciclo interno e gli indirizzi di rete locale: sono tutti indirizzi che dentro un
documento condiviso diventano un'immagine rotta per chiunque, chi ha copiato
compreso appena apre quel documento da un altro computer.

Il nome SHALL finire nella query correttamente codificato e NON SHALL rompere il
markdown. Senza nome NON SHALL essere scritta una query vuota.

#### Scenario: da un indirizzo locale
- **GIVEN** l'app aperta su un indirizzo non raggiungibile da fuori
- **THEN** il markdown SHALL esserci, accompagnato dall'avviso

#### Scenario: da un indirizzo pubblico
- **GIVEN** un'origine raggiungibile da fuori
- **THEN** il markdown SHALL essere pronto, senza avvisi

### Requirement: PUBLIC-PROFILE-URL-01 — Sotto il guscio desktop l'origine della pagina NON è un indirizzo

«Copia link» del profilo pubblico SHALL costruire l'URL da un'origine che
qualcun altro può aprire. Sotto Tauri l'origine della pagina è
`tauri://localhost` (macOS) o `http://tauri.localhost` (altrove): NON SHALL
finire nel link. In quel caso SHALL usarsi l'origine http su cui il server
risponde, e la riga sotto il link SHALL dire fin dove quell'indirizzo arriva.
Con il relay attivo SHALL vincere l'indirizzo del relay, che arriva ovunque.

#### Scenario: guscio macOS
- **GIVEN** l'origine della pagina è `tauri://localhost` e il server risponde su un'origine http
- **THEN** il link SHALL usare l'origine http del server

#### Scenario: relay attivo
- **GIVEN** il relay è abilitato con un indirizzo pubblico
- **THEN** il link SHALL usare l'indirizzo del relay

#### Scenario: nel browser
- **GIVEN** l'origine della pagina è già un indirizzo http
- **THEN** il link SHALL usare quella, come prima

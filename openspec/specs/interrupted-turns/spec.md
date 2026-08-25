## Purpose

Un turno che si ferma prima di finire deve DIRLO, e dire chi l'ha fermato. È
l'unico caso in cui il silenzio del prodotto assomiglia perfettamente al suo
funzionamento normale.

## Background

«PENSO ABBIANO INTERROTTO INVOLONTARIAMENTE» (20/08/2026, su due chat che
sembravano a posto e non lo erano). Una chat ferma a metà frase, con dentro un
attrezzo chiuso come interrotto e nessuna riga che lo spiegasse: a schermo è
identica a una chat che ha finito.

QUANTO ERA GRANDE. Misurato sul database di produzione il 20/08: **1.082 turni,
dal primo agosto, con un attrezzo chiuso come «interrotto» e nessun blocco che
lo spiegasse.** Non un caso limite — il caso normale.

E LE PENNE SONO TRE. Il testo dell'interruzione lo scrivono tre punti diversi del
codice. Riconoscerne due su tre lasciava muta una riga su 1.175.

## Requirements

### Requirement: INTERRUPT-01 — Un turno tagliato dalla macchina si spiega, e una chat sana non prende cartelli

Un turno la cui ULTIMA cosa è un attrezzo — cioè stava lavorando — SHALL essere
riconosciuto come TAGLIATO, e SHALL ricevere una spiegazione scritta.

Un turno che finisce PARLANDO NON SHALL essere toccato: è il modo normale di
finire, e senza questa distinzione ogni chat sana si sarebbe presa un cartello a
ogni riavvio del server.

Un turno che ha GIÀ una spiegazione NON SHALL riceverne una seconda, e la
riparazione SHALL essere RIPETIBILE: alla seconda passata non scrive più. Un
cartello per ogni avvio si accumula.

SHALL essere toccata solo l'ULTIMA riga, e solo se serve: le righe storiche già
chiuse bene non si riaprono.

Una riga che non è dell'assistente, o che non ha contenuto, NON SHALL essere
giudicata. Una sessione che non esiste NON SHALL far fallire l'avvio.

#### Scenario: la chat ha finito parlando
- **GIVEN** un turno il cui ultimo contenuto è testo
- **THEN** NON SHALL ricevere nessun cartello

#### Scenario: seconda passata
- **GIVEN** un turno già spiegato
- **THEN** la riparazione NON SHALL scrivere di nuovo

### Requirement: INTERRUPT-02 — «Interrotto» all'INIZIO è un verdetto, in mezzo è l'output di un comando

Il riconoscimento di un'interruzione SHALL essere ANCORATO all'inizio del testo.
La stessa parola che compare più avanti — dentro l'uscita di un comando che la
menziona — NON SHALL valere come verdetto.

**Un errore VERO di un comando NON SHALL essere trattato come un'interruzione.**
È la distinzione che impedisce di mascherare una prova fallita da riavvio del
server: due cose che chiedono azioni opposte.

TUTTE le penne che scrivono un testo di interruzione SHALL essere riconosciute.
Riconoscerne due su tre lasciava muta una riga su 1.175, e una riga muta è
indistinguibile da una sana.

La presenza di PROSA accanto a un attrezzo interrotto NON SHALL nascondere il
turno morto: il verdetto ci va lo stesso.

Chi ha già una spiegazione NON SHALL riceverne una seconda; la bonifica SHALL
riparare i muti e LASCIARE STARE tutti gli altri — i sani, i già spiegati, quelli
ancora in volo, quelli fuori finestra. Ripassare NON SHALL accumulare.

Senza contenuto non SHALL essere emesso nessun verdetto.

#### Scenario: un comando che stampa la parola
- **GIVEN** l'uscita di un comando che contiene «interrotto» a metà frase
- **THEN** NON SHALL valere come verdetto di interruzione

#### Scenario: un comando che fallisce davvero
- **GIVEN** un attrezzo terminato con un errore vero
- **THEN** NON SHALL essere trattato come un'interruzione

### Requirement: INTERRUPT-03 — Il cartello dice CHI ha fermato, e non promette bottoni che non ci sono

Un turno annullato SHALL ricevere un cartello che dice PERCHÉ, e le cause SHALL
essere distinte: spegnimento del server, cane da guardia, limite di tempo — e
ciascuna col proprio testo, perché chiedono cose diverse a chi legge.

Uno stop premuto da una PERSONA NON SHALL produrre nessun cartello: non si spiega
a qualcuno ciò che ha appena fatto lui.

Un riavvio interno e un turno rifiutato perché ce n'era già uno in volo NON SHALL
produrre cartelli: non sono fini di niente.

Un annullamento SENZA causa dichiarata SHALL parlare lo stesso, ma NON SHALL
inventare un colpevole. Una causa ignota non è uno stop dell'utente.

**Il cartello NON SHALL promettere un'azione che non c'è.** Il bottone di ripresa
compare solo su un turno che non ha prodotto NIENTE — premerlo su un turno che ha
già risposto in parte duplicherebbe la risposta — quindi su un turno che HA
prodotto il cartello non SHALL nominarlo. E se il turno riprende DA SOLO, non
SHALL essere chiesto nessun gesto a nessuno.

Il titolo scritto nel registro NON SHALL attribuire a una persona ciò che ha
fatto la macchina.

L'elenco dei cartelli riconosciuti come «nostra interruzione» SHALL contenere
ogni testo che il sistema produce OGGI, e SHALL riconoscerli con e senza il segno
che li apre. Un elenco rimasto indietro rispetto ai propri testi è un cancello
che non morde.

I guasti VERI — quelli deterministici, che ripetuti si ripeterebbero — NON SHALL
essere riconosciuti come riprendibili.

#### Scenario: turno che ha già prodotto
- **GIVEN** un turno annullato che aveva già scritto qualcosa
- **THEN** il cartello NON SHALL promettere il bottone di ripresa

#### Scenario: stop di una persona
- **GIVEN** un turno fermato a mano
- **THEN** NON SHALL essere scritto nessun cartello

### Requirement: INTERRUPT-04 — La lapide di un turno vuoto si riusa, ma solo se è davvero una lapide

Quando un cartello di turno vuoto è seguito poco dopo dalla risposta VERA, quella
riga SHALL poter essere RIUSATA invece di lasciare due righe di cui una bugiarda.
Misurato su tutto l'archivio: 14 cartelli, 8 seguiti dalla risposta vera entro
due minuti.

Il riuso SHALL essere rifiutato per una riga che non è dell'assistente, per una
riga ANCORA VIVA — rubare una riga in scrittura è peggio del problema che risolve
— per una risposta vera per quanto corta, per una riga con attrezzi sotto, e per
una riga che porta contenuto oltre al solo cartello.

La finestra di tempo SHALL essere una CINTURA DI SICUREZZA, non il criterio
principale: il confine SHALL essere INCLUSO, e una riga NATA DOPO l'istante
chiesto NON SHALL essere riusata — un orologio disallineato non deve poter
riscrivere il futuro.

Un contenuto illeggibile o una data illeggibile NON SHALL essere interpretati a
favore: non si tocca.

Il testo cercato SHALL essere quello che il codice scrive DAVVERO, o il riuso
smette di funzionare in silenzio il giorno che qualcuno riscrive la frase.

#### Scenario: la riga è ancora viva
- **GIVEN** una riga ancora in scrittura
- **THEN** NON SHALL essere riusata

#### Scenario: una data illeggibile
- **GIVEN** una riga con un istante che non si riesce a leggere
- **THEN** NON SHALL essere riusata

### Requirement: NOTICE-01 — Il cartello che il server scrive, il client lo RICONOSCE

Il server decide il cartello di interruzione e lo scrive come blocco d'errore; il
client decide il banner e il bottone che rimanda. Sono DUE moduli in DUE alberi
diversi, provati ognuno per conto suo — e se le loro idee di «cartello»
divergono, il server ne scrive uno che il client non disegna, o il client accende
un bottone su un turno che non lo prevede. Nessuna delle due prove per conto suo
lo vedrebbe.

OGNI cartello che il server scrive SHALL essere RICONOSCIUTO dal client.

Un turno che ha prodotto del LAVORO NON SHALL offrire di rimandare: rimandare
rifarebbe tutto.

Uno stop chiesto A MANO NON SHALL accendere niente: nessun blocco, nessun banner
— è una decisione, non un guasto.

#### Scenario: un cartello nuovo lato server
- **GIVEN** un cartello che il client non conosce
- **THEN** la verifica SHALL fallire

#### Scenario: uno stop a mano
- **GIVEN** un'interruzione chiesta dalla persona
- **THEN** NON SHALL comparire nessun banner

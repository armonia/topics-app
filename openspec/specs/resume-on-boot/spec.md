## Purpose

Cosa succede alle chat che il riavvio del server ha interrotto a metà frase.
Nessuno le ha fermate: le ha fermate la macchina, e la macchina se ne fa carico.

## Background

DUE DESTINI OPPOSTI PER LO STESSO GESTO. Un turno di un provider a riga di
comando gira in un processo FIGLIO che lo spegnimento non tocca: al riavvio
viene ritrovato e riadottato, e chi guardava vede una pausa. Un turno del
runtime interno vive DENTRO il server: quando il processo muore non resta niente
da riadottare, e la chat resta ferma per sempre. Stessa applicazione, stesso
gesto di chi la usa — salvare un file — e nessuno dei due destini scelto da chi
lo subisce.

E QUELLO BRUTTO NON LO DICEVA NEMMENO. Fino al 18/08/2026 il riavvio azzerava il
turno senza scrivere niente nel filo: si vedeva solo un cartello dentro il blocco
dell'attrezzo, non un messaggio leggibile.

PERCHÉ UN BOTTONE NON BASTA. «Riprova» compare solo quando il turno non ha
prodotto NIENTE — ed è giusto così, rimandare un messaggio a cui l'agente ha già
risposto in parte è un modo di perdere lavoro. Ma la chat interrotta a metà frase
cade proprio fuori da quel caso, quindi il bottone non c'era e il cartello ne
prometteva uno.

## Requirements

### Requirement: RESUME-01 — Si riprende solo ciò che ha interrotto LA MACCHINA

Un turno SHALL essere ripreso da solo quando a fermarlo è stata una decisione
della MACCHINA: lo spegnimento del server, un cane da guardia, un limite di
tempo.

Un turno fermato da una PERSONA NON SHALL essere ripreso, mai. E un turno
annullato senza una causa registrata NON SHALL essere ripreso: senza sapere
perché si è fermato, riprenderlo è indovinare al posto di chi lo ha fermato.

Un turno finito BENE, o finito con un errore vero, NON SHALL essere ripreso: non
c'è niente da riprendere.

Una chat ARCHIVIATA o inesistente NON SHALL ricevere niente: non si scrive dove
la persona non guarda.

Se qualcuno sta GIÀ parlando in quella chat, la ripresa NON SHALL accavallarsi.

Una ripresa SHALL avvenire UNA volta sola. Due avvii di fila NON SHALL riprendere
due volte lo stesso turno.

Un messaggio della persona rimasto SENZA RISPOSTA — nessuna riga di risposta
dopo di lui, nessun turno vivo su quella chat, più vecchio dei due minuti che
un turno vivo impiega a scrivere la propria riga — SHALL contare come
interruzione della MACCHINA: prima il cartello nel filo (RESUME-02), poi il
rimando, con la stessa finestra e lo stesso tetto. Una chat che appartiene a
una card della board NON SHALL essere ripresa da qui: la riprende il dispatcher.

#### Scenario: fermato da una persona
- **GIVEN** un turno interrotto da chi lo stava guardando
- **THEN** NON SHALL essere ripreso

#### Scenario: un messaggio senza risposta
- **GIVEN** una chat la cui ultima riga è della persona, da più di due minuti, senza turno vivo
- **THEN** SHALL comparire il cartello nel filo e il messaggio SHALL essere rimandato una volta

#### Scenario: due riavvii di fila
- **GIVEN** un turno già ripreso a un avvio precedente
- **THEN** NON SHALL essere ripreso di nuovo

### Requirement: RESUME-02 — Prima si SPIEGA, poi si riprende — e senza spiegazione non si riprende

Quando l'avvio azzera un turno rimasto a metà, SHALL scrivere nel filo un
messaggio LEGGIBILE, non solo uno stato dentro il blocco di un attrezzo.

La ripresa SHALL essere subordinata alla spiegazione: **senza il cartello scritto
nel filo la ripresa NON SHALL scattare.** È l'ordine che chiude il buco del
20/08 — una chat ripresa senza che nessuno abbia spiegato perché si era fermata
lascia chi guarda a chiedersi cosa sia successo.

Il cartello SHALL essere riconosciuto camminando il FILO, non solo interrogando
la tabella, e SHALL essere abbastanza specifico: un cartello generico NON SHALL
bastare a far scattare una ripresa. I testi VERI presi dall'archivio NON SHALL
farla scattare per caso.

Ogni sessione azzerata nello stesso avvio SHALL ricevere il PROPRIO messaggio, e
il messaggio NON SHALL toccare le altre sessioni. La sua posizione nel filo SHALL
essere l'ultima; su una sessione vuota SHALL essere la prima.

Il contenuto SHALL cominciare con il segno che l'interfaccia riconosce per
mostrare l'avviso e l'azione di ripresa.

#### Scenario: nessuna spiegazione scritta
- **GIVEN** un turno morto e nessun cartello nel filo
- **THEN** la ripresa NON SHALL scattare

#### Scenario: due sessioni azzerate insieme
- **GIVEN** due sessioni resettate nello stesso avvio
- **THEN** ciascuna SHALL ricevere il proprio messaggio

### Requirement: RESUME-03 — In dubbio si TIENE, e non si risponde a una domanda di ieri

La decisione fra tenere e azzerare SHALL basarsi sul fatto che il processo figlio
sia ancora vivo. Quando l'elenco dei figli vivi NON è confermato, TUTTO SHALL
essere tenuto: è il ripiego sicuro, perché azzerare un turno vivo distrugge
lavoro mentre tenerne uno morto costa soltanto un cartello in più.

La ripresa SHALL avere una FINESTRA di tempo: non si risponde a una domanda di
ieri. Fuori dalla finestra il turno resta com'è.

Se l'ULTIMA parola nel filo è della persona, la ripresa NON SHALL scattare: ha
già ripreso lei.

In assenza dei dati su cui decidere, NON SHALL essere deciso niente.

Una sessione senza nessun turno a metà NON SHALL subire nessun cambiamento.

#### Scenario: elenco dei figli vivi non confermato
- **GIVEN** un avvio in cui non si riesce a sapere quali figli siano vivi
- **THEN** nessun turno SHALL essere azzerato

#### Scenario: la persona ha già scritto
- **GIVEN** un turno interrotto seguito da un messaggio della persona
- **THEN** NON SHALL essere ripreso

### Requirement: BOOTSCAN-01 — Il setaccio dell'avvio non si carica il database per trovare quattro righe

La ricerca degli strumenti rimasti «in corso» dopo un riavvio SHALL SCORRERE le
righe invece di materializzarle tutte: misurato sul database di produzione,
caricare trenta giorni di messaggi significa 8.354 righe per 706 MB di
contenuto, per trovarne quattro.

Scorrendo SHALL essere trovato ESATTAMENTE ciò che si trovava caricando tutto —
o il risparmio ha cambiato la risposta.

Le righe SCARTATE NON SHALL essere trattenute: ciò che sopravvive SHALL essere
proporzionale ai TROVATI, non agli esaminati. Un database senza strumenti in
corso NON SHALL trattenere niente.

Lo stato SHALL essere visto anche quando sta dentro un blocco COMPRESSO, e SHALL
essere riconosciuto OGNI stato «in corso», non solo il più comune: un solo stato
riconosciuto lascia gli altri appesi per sempre.

#### Scenario: un database senza strumenti in corso
- **GIVEN** nessuna riga da finalizzare
- **THEN** NON SHALL essere trattenuto niente

#### Scenario: uno stato dentro un blob compresso
- **GIVEN** una riga compressa che porta uno stato in corso
- **THEN** SHALL essere trovata

# remote-access Specification

## Purpose
TBD - created by archiving change complete-spec-coverage. Update Purpose after archive.
## Requirements
### Requirement: AUTHGATE-01 — Un nome che COMINCIA per «127.» non è il loopback, e il rebinding è la prova

Il riconoscimento dell'indirizzo locale SHALL essere per valore LETTERALE, mai
per prefisso. Un nome pubblico che comincia con le cifre del loopback, o col nome
della macchina locale seguito da altro, NON SHALL essere trattato come locale.

Non è teoria: esistono servizi di nomi con jolly gratuiti che risolvono
`<qualunque-cosa>` su `127.0.0.1`. Con il riconoscimento per prefisso, un sito
ostile che punta a uno di quei nomi otteneva **200 sul server vivo** su una rotta
che esegue comandi. La stessa protezione SHALL valere anche sulle LETTURE: chi
riesce a leggere la risposta ha già ottenuto ciò che voleva.

Un nome ribattezzato sull'indirizzo locale SHALL essere rifiutato **anche con
un'identità VALIDA**: l'identità dice chi sei, non da dove stai chiamando.

La sentinella interna che rappresenta «locale» NON SHALL poter essere inviata
come intestazione: un valore che collide con un marcatore interno è un modo di
entrare.

L'intestazione dell'ospite ASSENTE SHALL passare — chi è già sulla macchina non
la manda — ma assente INSIEME a un'origine dichiarata, su una richiesta che
MODIFICA, SHALL essere rifiutata.

Il controllo dell'origine SHALL coprire anche il socket PRIMARIO, non solo i suoi
sotto-percorsi: è il buco più facile da lasciare, perché il percorso nudo non
somiglia agli altri.

Un'origine OPACA SHALL essere rifiutata: una pagina che nasconde la propria
provenienza non ha diritto di scrivere.

I nomi della propria macchina SHALL essere riconosciuti anche SENZA punti e anche
PIENAMENTE QUALIFICATI col punto finale: sono le due forme che i sistemi di
scoperta locale producono, e rifiutarle chiude fuori il telefono di casa.

L'elenco delle origini ammesse SHALL essere riletto A OGNI CHIAMATA: metterlo in
cache al primo uso rende impossibile cambiarlo senza riavviare. E SHALL ammettere
SOLO ciò che elenca: nessun sosia per suffisso, nessuno schema declassato,
nessuna porta diversa.

#### Scenario: un nome jolly che risolve sul loopback
- **GIVEN** una richiesta il cui ospite dichiarato risolve sull'indirizzo locale ma non lo è letteralmente
- **THEN** SHALL essere rifiutata, anche con un'identità valida

#### Scenario: il socket primario
- **GIVEN** una connessione al percorso nudo del socket con origine forestiera
- **THEN** SHALL essere rifiutata

### Requirement: AUTHGATE-02 — Il caricamento accetta solo dentro le radici, e il percorso si risolve PRIMA

Un file caricato SHALL poter atterrare SOLO dentro una radice consentita, e il
confronto SHALL avvenire sul percorso RISOLTO, non sulla stringa.

Un fratello che condivide il PREFISSO del nome NON SHALL passare: la
somiglianza testuale non è contenimento. I salti verso l'alto SHALL essere
normalizzati prima del confronto.

Un collegamento simbolico che a stringa sembra dentro la radice ma RISOLVE fuori
SHALL essere rifiutato: è il modo con cui una cartella consentita diventa una
finestra su chiavi private.

**Senza nessuna radice configurata SHALL essere rifiutato TUTTO, non consentito
tutto.** Una configurazione mancante non è un permesso.

Le radici vuote e la radice assoluta SHALL essere scartate: accettare la radice
del disco apre l'intero sistema.

#### Scenario: un collegamento che punta fuori
- **GIVEN** un collegamento dentro la radice che risolve altrove
- **THEN** SHALL essere rifiutato

#### Scenario: nessuna radice configurata
- **GIVEN** una configurazione senza radici
- **THEN** ogni percorso SHALL essere rifiutato

### Requirement: PAIRING-01 — Chi bussa si presenta con un FATTO, e l'installazione ha un nome

La schermata che chiede di autorizzare un dispositivo SHALL dire DA DOVE arriva
la richiesta in parole, non solo con un numero: questa macchina, la rete di casa,
Internet, oppure sconosciuto.

Un indirizzo privato e uno pubblico si leggono allo stesso modo se non si sa
cosa significhi il prefisso — e distinguerli non è una cosa che chi possiede il
computer debba sapere per decidere se far entrare qualcuno. La differenza conta:
un dispositivo sulla rete locale è già dentro casa; qualcosa che arriva dal ponte
può essere il proprio telefono fuori casa oppure chiunque abbia ricevuto un link.

Il riconoscimento SHALL leggere gli ottetti come NUMERI, non come prefisso di
testo: l'intervallo privato che comincia con lo stesso ottetto di indirizzi
pubblici si distingue solo guardando il secondo.

Il rivestimento che incapsula un indirizzo vecchio dentro uno nuovo NON SHALL
cambiare la risposta.

Ciò che non si riconosce SHALL restare SCONOSCIUTO e NON SHALL diventare
«Internet»: non sapere non è la stessa cosa che sapere il caso peggiore.

Questo giudizio NON SHALL essere una decisione di accesso: nessun ramo di
autorizzazione SHALL leggerlo. Serve a mettere una frase accanto a un numero, e
la decisione resta di chi possiede la macchina. Per la stessa ragione il
riconoscimento del «locale» SHALL essere un DOPPIONE deliberato di quello che
governa il cancello: quello tiene una porta e non deve poter cambiare per ragioni
di presentazione — e questo è quello che qualcuno sarà tentato di allargare.

L'installazione SHALL avere un NOME leggibile. Finché ne esiste una sola la
domanda non si pone; dal momento che ce ne sono due — un portatile e un fisso,
l'installazione di prova accanto a quella vera, due persone sulla stessa rete —
«autorizza» diventa una richiesta senza soggetto.

Il nome SHALL stare in UNA riga: senza caratteri di controllo, senza a-capo, e
non più lungo di un limite dichiarato. Il suffisso che i sistemi di scoperta
locale appendono NON SHALL arrivare a chi legge. Il costo per ricavarlo SHALL
essere pagato UNA volta sola.

#### Scenario: un indirizzo pubblico che comincia come uno privato
- **GIVEN** un indirizzo il cui primo ottetto coincide con quello di un intervallo privato ma il secondo no
- **THEN** SHALL essere classificato come Internet

#### Scenario: un indirizzo che non si riconosce
- **GIVEN** un indirizzo assente o non riconosciuto
- **THEN** SHALL restare sconosciuto, NON «Internet»

### Requirement: PAIRING-02 — La coda dell'accoppiamento non si rifiuta MAI: si sfratta

Una richiesta di accoppiamento NON SHALL essere rifiutata perché «la coda è
piena». Misurato attraverso il ponte il 21/08/2026: la prima richiesta passava,
ogni successiva veniva respinta — e a essere respinto era il telefono di chi
possiede la macchina, non l'attaccante.

Il tetto totale SHALL essere alto abbastanza da non scattare nell'uso normale, e
quando si raggiunge SHALL essere SFRATTATA una richiesta, non rifiutata quella
nuova.

Lo sfratto SHALL colpire la più vecchia del gruppo PIÙ NUMEROSO — cioè di chi sta
inondando — e a parità di numero la più vecchia in assoluto. Una richiesta
legittima NON SHALL essere sfrattata finché esiste un gruppo più lungo del suo.

Il limite PER INDIRIZZO SHALL restare basso, e SHALL continuare a valere: lo
sfratto NON SHALL trasformarsi in un innalzamento del limite. Chi arriva al
proprio tetto NON SHALL toccare le richieste di un ALTRO indirizzo.

Gli indirizzi SCONOSCIUTI NON SHALL condividere una quota fra loro: due
sconosciuti non devono potersi sfrattare a vicenda.

Su una coda vuota non c'è niente da sfrattare, e sotto il tetto NON SHALL essere
sfrattato niente.

> Limite accettato e dichiarato: a una richiesta per indirizzo, chi inonda da
> molti indirizzi diversi a bassa intensità non è distinguibile da molte persone
> vere. È una scelta, non una svista.

#### Scenario: la coda è piena e arriva chi bussa una volta sola
- **GIVEN** la coda al tetto totale e una richiesta da un indirizzo nuovo
- **THEN** SHALL entrare, e a uscire SHALL essere una del gruppo più numeroso

#### Scenario: due indirizzi, uno al proprio tetto
- **GIVEN** un indirizzo che ha raggiunto il proprio limite
- **THEN** le richieste dell'altro indirizzo NON SHALL essere toccate

### Requirement: PAIRING-03 — Lo schermo di appaiamento è RAGGIUNGIBILE su uno schermo corto, e dice CHI È

Lo schermo di appaiamento SHALL SCORRERE, e la sua altezza minima SHALL seguire
l'altezza VIVA della finestra: misurato su uno schermo corto, il contenuto finiva
oltre il bordo visibile con nessun modo di raggiungerlo.

SHALL centrarsi SOLO quando avanza spazio: una centratura simmetrica taglia anche
la testata.

SHALL DIRE chi è — l'icona dell'applicazione, la versione e lo stato della chiave
— perché è la prima schermata che una persona vede e non deve sembrare una pagina
qualunque.

Il messaggio d'errore NON SHALL essere azzerato a ogni tentativo prima della
richiesta: produrrebbe un lampeggio a ogni ritentativo. SHALL essere azzerato al
successo.

#### Scenario: uno schermo corto
- **GIVEN** una finestra più bassa del contenuto
- **THEN** il contenuto SHALL essere raggiungibile scorrendo

#### Scenario: un ritentativo
- **GIVEN** un errore mostrato e un nuovo tentativo
- **THEN** il messaggio NON SHALL lampeggiare

### Requirement: PAIRING-04 — Chi chiede riceve un codice DA MOSTRARE, e la coda non chiude fuori chi arriva

Chi chiede di appaiarsi SHALL ricevere un codice DA MOSTRARE, non un campo dove
scriverlo, e il codice NON SHALL contenere caratteri ambigui.

Dallo stesso indirizzo SHALL essere SEMPRE possibile chiedere: oltre il tetto la
richiesta più VECCHIA lascia il posto, e il suo orologio SHALL SPEGNERSI invece di
restare armato per sempre. Applicato come RIFIUTO, bastavano pochi indirizzi con
poche richieste a testa perché da lì in poi non entrasse più NESSUNO — compreso il
proprietario col proprio telefono.

Il segreto per ritirare SHALL essere obbligatorio, e sbagliarlo SHALL essere
INDISTINGUIBILE dal non esistere: un identificativo inventato, un segreto
mancante e uno sbagliato SHALL dare la STESSA risposta. Il segreto NON SHALL MAI
comparire nel messaggio che annuncia l'appaiamento.

Una condivisione verso un PROPRIETARIO SHALL essere rifiutata — vede già tutto — e
il ruolo SHALL DISCENDERE dalla persona, mai risalire. Un ospite SHALL ricevere
SOLO ciò che gli è stato concesso, e l'elenco delle risorse permesse NON SHALL
contenere la porta che le espone tutte.

Togliere una condivisione SHALL togliere la riga; REVOCARE SHALL marcarla. Sono
due gesti diversi.

Con il canale remoto SPENTO NON SHALL essere più coniato niente, ma SHALL essere
ancora possibile REVOCARE: un interruttore che nasconde senza spegnere lascia
credere che sia chiuso.

La chiave SHALL uscire UNA volta sola, e l'elenco NON SHALL riproporla.

Il proprietario dell'installazione NON SHALL essere cancellabile, e chi ha ancora
un dispositivo VIVO NON SHALL essere cancellato.

Un membro SHALL dichiarare quando si è fatto vivo l'ultima volta, e un dispositivo
REVOCATO SHALL azzerare quella presenza.

#### Scenario: la coda delle richieste è piena
- **GIVEN** molti indirizzi che hanno già chiesto
- **THEN** una richiesta nuova SHALL comunque entrare, sfrattando la più vecchia

#### Scenario: un segreto sbagliato
- **GIVEN** un ritiro con il segreto errato
- **THEN** la risposta SHALL essere identica a quella di un identificativo inesistente

### Requirement: LOOPBACK-01 — La sonda del ciclo interno non è un cercatore di porte

La porta SHALL essere estratta dalle varie forme del ciclo interno, forma
esplicita compresa, e la porta IMPLICITA SHALL contare: una scheda su un indirizzo
locale senza porta è la porta predefinita del suo schema.

**Tutto ciò che NON è il ciclo interno SHALL valere NIENTE**: questa rotta non è
un cercatore di porte, e non deve poter diventarlo.

Il controllo di ascolto SHALL essere VERO mentre un server è su e FALSO appena si
spegne. Un server in ascolto SOLO sulla forma estesa dell'indirizzo locale NON
SHALL essere dato per morto: sono due indirizzi dello stesso posto.

Una porta LIBERA NON SHALL far aspettare l'intera scadenza: una diagnosi che
impiega quanto un guasto non è una diagnosi.

#### Scenario: un indirizzo che non è locale
- **GIVEN** un host esterno
- **THEN** NON SHALL essere estratta nessuna porta

#### Scenario: un server sulla sola forma estesa dell'indirizzo locale
- **GIVEN** un ascolto su quella forma
- **THEN** SHALL risultare vivo

### Requirement: LANGATE-01 — Il cancello d'origine si prova sul server VERO, o non si prova affatto

Togliere la barriera di rete locale NON produce nessun rosso nel resto della
suite: gira tutta su un'origine coerente con l'host, e nessuna prova asseriva un
rifiuto del cancello. Un cancello che nessuno vede mordere non è un cancello.

Una MUTAZIONE da un'origine ESTRANEA SHALL essere rifiutata; una dalla stessa
origine SHALL passare.

Una LETTURA senza credenziali e senza origine SHALL passare: nessun rifiuto è
sopravvissuto su quel ramo, e va dichiarato invece che scoperto.

Una MUTAZIONE senza l'intestazione di origine SHALL passare: chi non la manda non
è un browser.

Il patto della condivisione fra origini SHALL reggere: una lettura da un'altra
origine NON SHALL ricevere il permesso di leggerne la risposta.

Un aggiornamento a socket da un'origine estranea SHALL essere rifiutato.

#### Scenario: una mutazione da un'origine estranea
- **GIVEN** una richiesta con origine diversa
- **THEN** SHALL essere rifiutata

#### Scenario: una lettura da un'altra origine
- **GIVEN** una richiesta di sola lettura cross-origine
- **THEN** NON SHALL ricevere il permesso di leggerne la risposta

### Requirement: DEVICEUI-01 — Una revoca che non è passata non somiglia a una revoca riuscita

È la superficie di sicurezza: esiste perché «authorization is per device and can
be revoked at any time» sia vero anche per chi non usa `curl`. Revoca e
rinomina non leggevano mai `r.ok`, e il rifiuto scritto nella stessa banda del
caricamento veniva cancellato entro un secondo dal giro di ricarica che segue
ogni gesto.

Un gesto rifiutato SHALL lasciare il blocco d'errore del pannello, con il suo
«Riprova», e quel blocco SHALL sopravvivere alla ricarica che il gesto stesso
scatena.

Una rinomina rifiutata NON SHALL chiudere il campo: il nome digitato resta.

#### Scenario: la revoca viene rifiutata
- **GIVEN** un dispositivo in elenco e la rotta che risponde con un rifiuto
- **WHEN** si conferma il cestino
- **THEN** SHALL comparire il blocco d'errore con «Riprova»
- **AND** SHALL essere ancora lì dopo la ricarica dell'elenco

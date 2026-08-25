## Purpose

Cosa è concesso su QUESTA installazione, chi lo decide, e la separazione fra «un
servizio dice che hanno pagato» e «questa macchina può fare X».

## Background

IL SOGGETTO È L'INSTALLAZIONE, NON L'ACCOUNT. La licenza sta sull'installazione e
porta un numero di posti. Non è la persona, non è l'organizzazione, non è il
dispositivo — perché tutti e tre cambiano, si revocano e si sincronizzano da
fuori, mentre la macchina che hai davanti è l'unica cosa che resta la stessa. Il
suo identificativo è un file su disco, che sopravvive al ripristino del database
da un backup.

SI VERIFICA OFFLINE, E NON È UN DETTAGLIO. Il gettone è firmato e si controlla
con la sola chiave pubblica: nessuna chiamata, nessun servizio da raggiungere,
nessun momento in cui il prodotto smette di funzionare perché qualcosa non
risponde.

IL PAGAMENTO NON CONCEDE NIENTE. Il modulo del pagamento non ha una riga che dica
«da adesso puoi». Il massimo che un evento del fornitore di pagamento può fare è
PASSARE un gettone alla porta, che lo ricontrolla da capo. Tenerle separate
significa che il giorno in cui quell'account viene compromesso, o un evento viene
rigiocato, o qualcuno indovina l'indirizzo del richiamo, il peggio che ottiene è
un gettone che non verifica.

## Requirements

### Requirement: LICENSE-01 — In OGNI modo di andare male la macchina resta usabile, e ogni modo si spiega DIVERSAMENTE

Qualunque cosa vada storta nella verifica — gettone assente, firma non valida,
carico malformato, versione sconosciuta, scadenza passata — la macchina SHALL
restare PIENAMENTE usabile sul piano gratuito. Il prodotto NON SHALL avere uno
stato «non so, quindi mi fermo».

Ogni modo di andare male SHALL avere il PROPRIO motivo, e NON SHALL essere
riportato come gli altri: «malformato» e «firmato male» sono due diagnosi
diverse, e collassarle rende impossibile capire se il problema è il gettone o
chi l'ha scritto.

Una firma della lunghezza sbagliata SHALL essere MALFORMATA, non «firmata male».
Un terzo segmento inatteso NON SHALL essere lasciato cadere in silenzio.
Caratteri fuori dall'alfabeto previsto NON SHALL essere «ripuliti»: ripulire un
ingresso firmato significa verificare qualcosa di diverso da ciò che è arrivato.

Un carico con un campo del tipo sbagliato SHALL essere malformato, non
interpretato. Una versione o un piano che non si conoscono SHALL essere
RIFIUTATI, non reinterpretati sul più vicino.

Cambiare UN SOLO byte del carico SHALL invalidare la firma.

Il piano gratuito NON SHALL scadere e NON SHALL raggiungere nessun servizio.

I posti dichiarati SHALL essere tenuti entro limiti sensati: un numero fuori
scala in un gettone valido è comunque una cosa che non deve poter succedere.

#### Scenario: firma della lunghezza sbagliata
- **GIVEN** un gettone la cui firma non ha la lunghezza prevista
- **THEN** SHALL essere dichiarato malformato, non «firmato male»

#### Scenario: tutto va storto
- **GIVEN** qualunque forma di gettone non verificabile
- **THEN** la macchina SHALL restare pienamente usabile

### Requirement: LICENSE-02 — Il tetto dei posti non chiude fuori chi c'è già

L'accesso SHALL essere consentito SOTTO il tetto dei posti e negato AL tetto: il
confine è quello, e va verificato da entrambi i lati.

Un gruppo che ha già SFORATO il proprio tetto NON SHALL chiudere fuori NESSUNO di
chi c'è già dentro. Ridurre i posti — o superarli per qualunque ragione — non
deve trasformarsi in una serrata: chi lavorava continua a lavorare.

Il piano gratuito SHALL avere UN posto, e quel posto è chi possiede la macchina:
il primo invito è ciò che si paga.

Un gettone valido SHALL portare con sé i propri posti e SHALL aprire l'accesso
remoto.

#### Scenario: gruppo oltre il tetto
- **GIVEN** un gruppo che ha superato i posti disponibili
- **THEN** nessuno di quelli già dentro SHALL essere escluso

#### Scenario: esattamente al tetto
- **GIVEN** un gruppo che ha occupato tutti i posti
- **THEN** un ingresso ulteriore SHALL essere negato

### Requirement: LICENSE-03 — Il fornitore di pagamento è un canale, non una porta

Il modulo del pagamento NON SHALL concedere niente da sé. Un evento di quel
fornitore SHALL poter solo CONSEGNARE un gettone alla verifica, che lo ricontrolla
da capo. Un richiamo contraffatto contenente un gettone inventato SHALL produrre
lo stesso esito che si avrebbe se non fosse mai arrivato.

La firma del richiamo SHALL essere verificata sull'intero corpo: cambiare UN
carattere SHALL invalidarla, e l'istante SHALL essere DENTRO ciò che si firma —
altrimenti un messaggio vecchio si rigioca cambiando solo l'ora.

**Senza segreto configurato NON SHALL essere accettato NIENTE, nemmeno una firma
corretta.** L'assenza di configurazione non è una scorciatoia.

Un'intestazione assente, vuota o priva dei propri campi SHALL essere MALFORMATA,
non «firma sbagliata». Un istante non numerico SHALL essere dichiarato tale e NON
SHALL diventare uno zero che si legge come «molto vecchio». Fuori tolleranza
SHALL essere un RIGIOCO, e il motivo SHALL dirlo.

Una configurazione assente NON SHALL sollevare: SHALL valere «non configurato».
Un valore vuoto o di soli spazi SHALL valere assente; uno spazio DENTRO il valore
SHALL essere trattato come un incollaggio storto, non come una chiave.

Le due funzioni — incasso e richiamo — SHALL essere assi SEPARATI: una configurata
e l'altra no è uno stato legittimo.

Lo stato esposto pubblicamente NON SHALL lasciar trapelare niente della chiave.

#### Scenario: richiamo senza segreto configurato
- **GIVEN** un richiamo con una firma valida e nessun segreto configurato
- **THEN** NON SHALL essere accettato

#### Scenario: istante non numerico
- **GIVEN** un'intestazione il cui istante non è un numero
- **THEN** SHALL essere dichiarato tale, non trattato come zero

### Requirement: LICENSE-04 — La lettura risponde SEMPRE, e un disco che non scrive NON è un gettone rifiutato

La lettura della licenza SHALL rispondere sempre positivamente: senza gettone col
piano gratuito, e SENZA nemmeno il servizio innestato SHALL rispondere lo stesso,
nel verso PIÙ LIBERO.

Un gettone di un'ALTRA macchina, o SCADUTO, SHALL essere rifiutato DICENDO quale
dei due è il motivo.

Un guasto di INFRASTRUTTURA — la cartella di stato che non accetta scritture —
NON SHALL essere riportato come un gettone rifiutato: gettone perfetto, macchina
giusta, pagamento riuscito, e un rifiuto che manda a cercare il problema
nell'unico posto dove non c'è.

Un corpo SENZA gettone SHALL essere una richiesta sbagliata, non un rifiuto di
licenza.

La licenza SHALL potersi TOGLIERE: una licenza inamovibile non si sposta di
macchina.

#### Scenario: la cartella di stato non scrivibile
- **GIVEN** un gettone valido e un disco che rifiuta la scrittura
- **THEN** NON SHALL essere riportato come gettone rifiutato

#### Scenario: nessun gettone
- **GIVEN** nessuna licenza installata
- **THEN** la lettura SHALL rispondere col piano gratuito

### Requirement: LICENSE-05 — Ogni motivo ha la sua frase, e i sette non si appiattiscono su uno

Ognuno dei motivi per cui una licenza non vale SHALL avere una CHIAVE PROPRIA:
nessuno SHALL cadere su quella di un altro. Due di essi — «tutto a posto» e
«nessun gettone» — NON SHALL dire niente; gli altri SHALL parlare, tutti.

SHALL essere distinto ciò che è COLPA NOSTRA da ciò che non lo è: una chiave di
verifica assente è un guasto nostro, un gettone scaduto o di un'altra macchina
no. Il predicato SHALL distinguere davvero, e il banco SHALL mostrarlo su
entrambi i lati.

L'acquisto SHALL essere possibile solo con il servizio di pagamento configurato E
un'installazione identificata; il canale di ritorno NON SHALL entrare in questa
decisione — sono assi separati.

Il piano gratuito NON SHALL scadere, quindi NON SHALL produrre nessun numero di
giorni. Un residuo di poche ore SHALL essere ZERO giorni, non uno; una scadenza
già passata SHALL dare un numero NEGATIVO, non zero — sono due informazioni
diverse. La soglia dell'avviso SHALL essere verificata da entrambi i lati.

I posti dichiarati SHALL avere un MINIMO di due — uno non si vende, è il piano
gratuito — e un TETTO. I numeri storti SHALL cadere sul minimo invece di
viaggiare.

Ogni motivo e ogni rifiuto dell'acquisto, generico compreso, SHALL avere la
propria frase in ENTRAMBE le lingue, e il criterio della verifica SHALL essere
visto FUNZIONARE su una chiave inventata.

#### Scenario: ventitré ore alla scadenza
- **GIVEN** meno di un giorno residuo
- **THEN** SHALL essere zero giorni, non uno

#### Scenario: un numero di posti non valido
- **GIVEN** un valore non numerico
- **THEN** SHALL cadere sul minimo

### Requirement: LICENSE-06 — Un rifiuto per posti esauriti si LEGGE e si MOSTRA

Il rifiuto per posti esauriti SHALL portare lo STESSO codice sul server e
sull'interfaccia, e la risposta SHALL essere LETTA: il difetto non era il
disegno — era che la risposta non veniva letta affatto, e il modulo si chiudeva
su un rifiuto senza dire niente.

Il messaggio SHALL esistere in ENTRAMBE le lingue e SHALL dire cosa si PUÒ fare,
non solo cosa non si può.

Il rifiuto NON SHALL buttare via quello che la persona aveva appena scritto.

#### Scenario: il server rifiuta
- **GIVEN** un rifiuto per posti esauriti
- **THEN** SHALL comparire un messaggio che dice cosa si può fare

#### Scenario: dopo il rifiuto
- **GIVEN** del testo appena inserito
- **THEN** NON SHALL essere cancellato

### Requirement: LICENSE-07 — Chi CONIA e chi VERIFICA si accordano sul byte, e il conio non sposta l'autorità

Lo strumento che CONIA un gettone e il modulo che lo VERIFICA SHALL accordarsi su
COSA si firma — il segmento codificato, non i byte del contenuto. Firmare l'altra
cosa produce gettoni che non verificano, e il motivo che esce è indistinguibile da
una chiave sbagliata.

L'accordo SHALL essere provato ESEGUENDO lo strumento vero, non simulandolo.

Un gettone di un'ALTRA installazione NON SHALL valere qui; una chiave DIVERSA NON
SHALL verificare; uno scaduto SHALL riportare al piano gratuito senza bloccare
niente.

Senza la chiave privata lo strumento SHALL RIFIUTARSI invece di inventare, e i
posti fuori scala SHALL essere rifiutati ALLA FONTE.

Le chiavi usate dal banco NON SHALL essere quelle di produzione, e il banco SHALL
verificarlo.

Il nome del campo che porta il gettone attraverso il canale di pagamento SHALL
essere lo STESSO ai due capi: sbagliarlo non rompe nessun banco — chi conia scrive
in un campo che nessuno legge, il canale risponde che non c'era nessun gettone, e
chi ha pagato resta sul piano gratuito senza che niente diventi rosso.

Il ciclo SHALL fermarsi al primo giro: l'evento della NOSTRA scrittura NON SHALL
generarne un altro. Al rinnovo SHALL essere coniato una volta sola.

Il conio automatico NON SHALL spostare l'AUTORITÀ: un gettone inventato dentro un
evento autentico SHALL restare senza effetto.

#### Scenario: il campo che porta il gettone
- **GIVEN** un nome diverso ai due capi
- **THEN** il banco SHALL fallire

#### Scenario: un gettone inventato in un evento autentico
- **GIVEN** una firma valida e un gettone falso
- **THEN** la licenza SHALL restare quella di prima

### Requirement: MINT-01 — Non si conia a chi non ha pagato, e il ciclo si ferma

Il servizio di conio SHALL coniare per un abbonamento NUOVO, ATTIVO e con
un'installazione dichiarata. NON SHALL coniare per un abbonamento disdetto, senza
installazione, o senza fine periodo — e senza fine periodo NON SHALL inventare una
scadenza. Posti fuori scala SHALL fermarsi PRIMA della firma.

La scadenza SHALL essere la fine del periodo PIÙ la grazia. I posti SHALL essere
sommati su TUTTE le righe, non letti dalla prima; se le righe non li dicono SHALL
esserci un ripiego dichiarato; e una fine periodo sulla RIGA SHALL valere quanto
quella sull'abbonamento.

**IL CICLO SI FERMA.** Scrivere il gettone nei metadati genera l'evento che torna
qui: senza uno stop il servizio scriverebbe per sempre. Lo stesso stato NON SHALL
riconiare. Ma al RINNOVO SÌ — il periodo si è spostato e il gettone vecchio
scadrebbe prima — e a un cambio di POSTI sì, perché chi compra tre postazioni in
più le vuole adesso. Dopo una rotazione di chiave SHALL riconiare anche se il
gettone vecchio è ancora buono. La tolleranza SHALL essere di un giorno e non di
un istante: un secondo di deriva NON SHALL far riscrivere.

Gli eventi che non conosciamo, e un corpo che non è un evento, NON SHALL
sollevare.

Il gettone che esce SHALL verificarsi davvero, e SHALL valere per l'installazione
per cui è stato coniato e non per un'altra.

Il gestore SHALL coniare e SCRIVERE il gettone nei metadati. Una firma sbagliata,
un segreto assente, una chiave privata assente, un rifiuto di scrittura, un evento
che non ci riguarda e una richiesta che non è un webhook SHALL avere ciascuno la
propria risposta, DISTINTA.

**Il gettone NON SHALL finire nei registri**: una riga di registro è il posto meno
sorvegliato in cui possa stare una licenza.

Le scritture verso il servizio di pagamento NON SHALL MAI sollevare: una rete che
non risponde SHALL essere dichiarata. La chiave del servizio SHALL stare
nell'ambiente. Un ambiente vuoto NON SHALL sollevare: SHALL dire che manca tutto.
Una variabile di soli spazi SHALL valere ASSENTE, non «configurato male», e una
chiave privata storta NON SHALL diventare una chiave a metà.

#### Scenario: lo stesso stato una seconda volta
- **GIVEN** un evento generato dalla scrittura del gettone stesso
- **THEN** NON SHALL essere coniato niente

#### Scenario: un abbonamento disdetto
- **GIVEN** un abbonamento non attivo
- **THEN** NON SHALL essere coniato niente

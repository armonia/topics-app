# Delta: outbound (posta-e-google)

## ADDED Requirements

### Requirement: OUTBOUND-01 — La configurazione vive solo nell'ambiente, e ciò che manca si dice per nome

Gli indirizzi, gli account e i percorsi delle CLI SHALL essere letti SOLO da
`process.env`, e NON SHALL comparire in nessun file tracciato: il repo è
pubblico e `tests/unit/no-third-party-emails.test.ts` (GATE-07) è rosso su un
indirizzo personale in un file tracciato.

Le variabili sono `TOPICS_MAIL_CLI`, `TOPICS_MAIL_ACCOUNT`, `TOPICS_MAIL_FROM`,
`TOPICS_MAIL_ACCOUNTS` (forma `conto:indirizzo,conto:indirizzo`),
`TOPICS_MAIL_EDM_CLI`, `TOPICS_MAIL_EDM_FROM`, `TOPICS_GOOGLE_CLI`,
`TOPICS_GOOGLE_CONFIG_DIR`, `TOPICS_GOOGLE_CLIENT_SECRET`, e si scrivono in
`~/.topics-server-env`, che `scripts/start-prod.sh` sorgia.

Una variabile mancante o malformata SHALL produrre un errore che NOMINA la
variabile e dice dove si scrive. NON SHALL esistere nessun ripiego silenzioso su
un account diverso da quello chiesto: un invio partito dall'indirizzo sbagliato
è peggio di un invio non partito.

Il lettore SHALL esporre i NOMI degli account disponibili e NON SHALL mai
scrivere un indirizzo in un log o in un errore: un errore su un account
sconosciuto elenca i nomi, non le caselle.

La casella Exchange SHALL essere riconosciuta per INDIRIZZO: la voce di
`TOPICS_MAIL_ACCOUNTS` il cui indirizzo è `TOPICS_MAIL_EDM_FROM` SHALL usare
`TOPICS_MAIL_EDM_CLI` come trasporto, le altre `TOPICS_MAIL_CLI`. Nessun nome di
account SHALL essere scritto nel codice.

#### Scenario: manca una variabile
- **GIVEN** un ambiente senza `TOPICS_MAIL_CLI`
- **THEN** l'errore SHALL nominare `TOPICS_MAIL_CLI` e il file dove si scrive
- **AND** NON SHALL partire nessun processo

#### Scenario: la lista degli account è malformata
- **GIVEN** `TOPICS_MAIL_ACCOUNTS` senza il carattere `:` in una voce
- **THEN** l'errore SHALL nominare la variabile e la forma attesa

#### Scenario: un account non dichiarato
- **GIVEN** una richiesta con un account che non è nella lista
- **THEN** SHALL essere rifiutata elencando i NOMI disponibili
- **AND** NON SHALL ripiegare sull'account predefinito

### Requirement: OUTBOUND-02 — Una CLI si chiama per ARGV, e il suo eseguibile si trova senza PATH

Destinatario, oggetto, corpo e parametri arrivano da un MODELLO. SHALL essere
passati alla CLI come ELEMENTI DI UN ARRAY di argomenti, e NON SHALL mai essere
composti in una stringa data a una shell: `; rm -rf`, `$(...)`, virgolette e a
capo SHALL arrivare al processo figlio come UN argomento, letterale.

Il percorso dell'eseguibile SHALL venire dalla variabile. Se non è assoluto
SHALL essere risolto su un elenco di cartelle DICHIARATO, perché sotto launchd
il `PATH` non contiene `/usr/local/bin` né `/opt/homebrew/bin`; un eseguibile
non trovato SHALL dare un errore che nomina la variabile e il valore cercato.

L'ambiente del figlio SHALL portare `TOPICS_GOOGLE_CONFIG_DIR` e
`TOPICS_GOOGLE_CLIENT_SECRET` quando la chiamata è per Google.

#### Scenario: un destinatario che sembra un comando
- **GIVEN** un destinatario `vittima@esempio.test; rm -rf /`
- **THEN** il figlio SHALL ricevere quella stringa come un solo `argv[n]`
- **AND** nessun comando SHALL essere eseguito

#### Scenario: eseguibile non assoluto
- **GIVEN** `TOPICS_MAIL_CLI` con un nome nudo e nessuna cartella dichiarata che lo contiene
- **THEN** l'errore SHALL nominare la variabile e il nome cercato

### Requirement: OUTBOUND-03 — Prima di ogni invio una persona dice sì, e il sì vale per QUEL messaggio

L'invio di un messaggio e ogni chiamata Google che SCRIVE SHALL essere precedute
da una conferma umana IMPOSTA DAL SERVER: NON SHALL dipendere dalla descrizione
dello strumento, e un agente NON SHALL poterla saltare chiamando direttamente la
rotta.

La conferma SHALL passare per il canale umano che la board già usa: la domanda
esce nel thread della card come commento con risposte rapide quando la sessione
appartiene a un task, e come pannello sulla riga dello strumento in attesa
quando la sessione è una chat.

La conferma SHALL essere legata al MESSAGGIO: la chiave della domanda SHALL
derivare dal contenuto (destinatario, oggetto, corpo, account, allegati), e una
risposta che non porta quella chiave NON SHALL valere come sì. Un sì dato una
volta NON SHALL valere per il messaggio successivo, e NESSUNA regola permanente
(«consenti sempre») SHALL poter coprire un invio.

La domanda SHALL contenere il MESSAGGIO che sta per partire: mittente,
destinatario, oggetto e il corpo (tagliato a una lunghezza dichiarata, e il
taglio SHALL essere annunciato). Una conferma che mostra solo il destinatario e
un conteggio di caratteri è una firma su una busta chiusa, e la board dice già
la stessa cosa altrove: se chiedi «confermi X?», chi risponde deve poter vedere
X.

Gli ALLEGATI SHALL essere NOMINATI nella domanda, con nome e peso: un conteggio
(«Allegati: 1») non si può leggere, e il workspace di una card è l'intera
cartella del progetto, dove sta anche il database. Un file che nessuno ha visto
nominare è un file che nessuno poteva fermare.

La riga dello strumento su cui la domanda viene dipinta SHALL essere trovata
anche quando il tool è registrato col NOME NUDO: il runtime nativo pubblica gli
strumenti di Topics senza il prefisso della flotta, e su questa macchina è il
runtime della grande maggioranza dei topic. Un confronto esatto sul solo nome
prefissato significa nessuna riga, nessun pannello, e ogni invio in chat
rifiutato con «nessuno poteva confermare».

La ricerca di quella riga NON SHALL dipendere da una scrittura DIFFERITA. La
colonna che porta le chiamate di un turno moderno (`blocks`) passa da un
throttle che rimanda fra 1 e 15 secondi tutto ciò che non è la prima scrittura
del turno: un `send_mail` che non è il primo strumento del suo turno non è
ancora sulla riga quando il cancello la legge. Prima di leggere, il cancello
SHALL forzare la scrittura pendente del turno vivo. «Non ancora persistita» NON
SHALL essere trattata come «non c'è nessuno a cui chiedere»: quel rifiuto è
secco — lo strumento solleva sul rifiuto e non c'è una seconda gamba — e taglia
ogni invio che non sia il primo strumento del turno.

Il cancello SHALL considerare la domanda POSTA solo quando il commento è stato
scritto davvero. Il registro delle domande instradate è per TASK e non guarda il
testo: una voce lasciata da una domanda di un turno interrotto faceva uscire
l'instradamento SENZA scrivere niente, e il valore di ritorno veniva letto come
«chiesto». Una domanda nuova SHALL sostituire quella che trova nel registro
della stessa sessione, e la sostituita SHALL essere chiusa con una riga sua: un
blocco di risposta rapida che cambia testo sotto gli occhi senza dirlo è peggio
del silenzio.

Se la risposta non arriva, o non è quella di consenso, NON SHALL partire niente
e lo strumento SHALL dirlo con la ragione.

#### Scenario: la persona legge cosa firma
- **GIVEN** una conferma di invio aperta
- **THEN** la domanda SHALL contenere il corpo del messaggio
- **AND** la traccia lasciata dopo NON SHALL contenerlo

#### Scenario: la persona legge cosa allega
- **GIVEN** una conferma di invio con un allegato
- **THEN** la domanda SHALL contenere il NOME del file, non solo quanti sono

#### Scenario: il tool è registrato col nome nudo
- **GIVEN** una riga che porta `send_mail` senza prefisso di flotta
- **THEN** la conferma SHALL essere dipinta su quella riga

#### Scenario: la persona non risponde
- **GIVEN** una conferma aperta e nessuna risposta
- **THEN** NON SHALL partire nessun processo
- **AND** lo strumento SHALL riportare che la conferma non è arrivata

#### Scenario: due messaggi di fila
- **GIVEN** un primo messaggio confermato e inviato
- **WHEN** l'agente ne manda un secondo
- **THEN** SHALL essere chiesta una NUOVA conferma

#### Scenario: una risposta che riguarda un'altra domanda
- **GIVEN** una risposta la cui chiave non è quella di questo messaggio
- **THEN** NON SHALL valere come consenso

#### Scenario: la riga dello strumento non è ancora stata scritta
- **GIVEN** un invio che non è il primo strumento del suo turno, con la
  scrittura dei blocchi ancora in attesa del throttle
- **THEN** la domanda SHALL essere dipinta lo stesso
- **AND** l'invio NON SHALL essere rifiutato con «nessuno poteva confermare»

#### Scenario: nel registro c'è una domanda di un turno interrotto
- **GIVEN** una voce lasciata da un `ask_user_question` mai risposto sulla
  stessa sessione
- **THEN** la domanda sull'invio SHALL comparire sulla card
- **AND** quella vecchia SHALL essere chiusa con una riga che lo dice

### Requirement: OUTBOUND-04 — `send_mail` e `google_call` sono strumenti dell'agente

Il server MCP di Topics SHALL pubblicare `send_mail` (destinatario, oggetto,
corpo, account fra quelli dichiarati, allegati presi dal workspace della card) e
`google_call` (servizio, risorsa, sotto-risorsa, metodo, `params` e `body` come
JSON).

Gli allegati SHALL essere risolti DENTRO il workspace della sessione: un percorso
che esce dalla cartella SHALL essere rifiutato. Il contenimento SHALL essere
deciso sul percorso REALE, con i link simbolici gia' risolti (sia del candidato
sia del workspace): `resolve()` normalizza `../` e NON segue un link, e un
agente che ha una shell nella propria worktree scrive `ln -s <segreto> allegato`
in un comando.

LA CONFERMA SHALL VINCOLARE I BYTE, NON IL NOME. Risolvere il percorso congela
una stringa, e fra la domanda e lo spawn c'è l'attesa della persona: nello
stesso workspace l'agente sostituisce il file (o lo ripunta a un link) e parte
altro, con la persona che ha letto «preventivo.pdf (9 B)». Al momento della
domanda gli allegati SHALL essere LETTI e copiati in una cartella di appoggio
privata del server (permessi 0700, fuori da ogni workspace), e ciò che viene
passato alla CLI SHALL essere quella copia. La domanda SHALL portare nome, peso
e l'impronta (sha256, in forma breve) dei byte congelati, e l'identità del
messaggio SHALL comprendere quell'impronta: byte diversi sono un messaggio
diverso, quindi una domanda nuova, non un sì ereditato. Le copie SHALL essere
cancellate quando l'invio finisce, e quelle che nessuno ha più chiuso SHALL
scadere. Il totale degli allegati SHALL avere un tetto dichiarato: i byte
passano dalla RAM del server, e oltre il limite che una casella accetta l'invio
non sarebbe comunque arrivato.

Le chiamate Google che LEGGONO (`list`, `get`, e simili) NON SHALL chiedere
conferma; quelle che SCRIVONO SHALL chiederla, e un metodo che non si sa
classificare SHALL contare come scrittura. `watch` SHALL contare come
SCRITTURA: sembra un osservatore e non lo è, crea un'iscrizione push che
sopravvive alla chiamata.

`google_call` NON SHALL essere una seconda porta della posta. I metodi di Gmail
che SPEDISCONO (`users messages send`, `users drafts send`, e le loro forme
brevi) SHALL essere rifiutati con un errore che rimanda a `send_mail`: sono un
ELENCO esplicito, non una regola sul verbo, e il confronto SHALL ignorare
maiuscole e spazi. Un atto ha una porta sola, e quella che sa mostrare il
messaggio esiste già.

Ogni chiamata che scrive SHALL essere riassunta in una forma LEGGIBILE. Se il
corpo porta un campo `raw` in base64 SHALL essere decodificato e mostrato come
mittente, destinatario, oggetto e testo; nessun campo SHALL essere troncato
senza che il taglio sia annunciato. `body: {"userId":"me","raw":"Rnjvbto..."}`
tagliato a 300 caratteri è la stessa busta chiusa che OUTBOUND-03 vieta.

Entrambi gli strumenti SHALL attendere la persona a GAMBE CORTE, come
`ask_user_question`: una richiesta HTTP tenuta aperta a zero byte muore per
timeout di socket dal lato del client.

#### Scenario: un metodo sconosciuto
- **GIVEN** `google_call` con un metodo che non è nell'elenco dei letti
- **THEN** SHALL chiedere conferma prima di eseguirlo

#### Scenario: un allegato fuori dal workspace
- **GIVEN** un allegato che risolve fuori dalla cartella della sessione
- **THEN** SHALL essere rifiutato e NON SHALL partire nessun invio

#### Scenario: un allegato che e' un LINK verso l'esterno
- **GIVEN** dentro il workspace un link simbolico a un file fuori dal workspace
- **THEN** SHALL essere rifiutato e NON SHALL aprire nessuna conferma

#### Scenario: l'allegato cambia mentre la persona legge
- **GIVEN** un allegato confermato e, durante l'attesa, lo stesso nome che punta
  a un altro contenuto
- **THEN** SHALL partire il contenuto che la persona ha visto nominare e pesare
- **AND** il percorso passato alla CLI NON SHALL essere quello del workspace

#### Scenario: una chiamata Google che spedisce
- **GIVEN** `google_call` con `gmail users messages send`
- **THEN** SHALL essere rifiutata rimandando a `send_mail`
- **AND** NON SHALL aprire nessuna conferma e NON SHALL eseguire niente

#### Scenario: una scrittura Google che porta un messaggio
- **GIVEN** una scrittura Google il cui corpo contiene un `raw` in base64
- **THEN** la domanda SHALL mostrare destinatario, oggetto e testo in chiaro

#### Scenario: una risposta del server non si ri-manda
- **GIVEN** una gamba a cui il server risponde con un errore (400, 502)
- **THEN** lo strumento SHALL riportare QUELL'errore all'agente
- **AND** NON SHALL ripetere la richiesta: solo una richiesta che non e' mai
  arrivata SHALL essere ritentata, perche' una seconda POST che il server
  riceve, dopo la conferma, e' un secondo messaggio

### Requirement: OUTBOUND-05 — Ciò che esce dalla macchina lascia una traccia sulla card

Ogni invio riuscito e ogni scrittura Google riuscita SHALL lasciare un commento
di servizio nel thread della card che li ha prodotti: chi (l'account), cosa (lo
strumento e l'oggetto o la chiamata), a chi (il destinatario o la risorsa) e
l'esito. Il commento NON SHALL contenere il corpo intero del messaggio.

Anche un tentativo RIFIUTATO dalla persona o FALLITO SHALL lasciare la sua riga:
una decisione che ferma un invio è un fatto della card quanto l'invio. Vale
anche per un fallimento DOPO il sì che non sia la CLI (un eseguibile che la
variabile non trova più): la persona ha confermato e niente è partito, e senza
quella riga l'unica memoria di un invio rotto è il messaggio dell'agente.

Quando una scrittura Google porta un MESSAGGIO, la traccia SHALL nominare
destinatario e oggetto: «scrittura eseguita» con il solo metodo dice che
qualcosa è partito e niente su cosa.

Una sessione che non appartiene a nessuna card NON SHALL fallire per questo: la
traccia è il risultato dello strumento nella chat.

#### Scenario: confermato e non partito
- **GIVEN** un invio confermato e un eseguibile che non si trova
- **THEN** SHALL comparire un commento che dice FALLITO e nomina la variabile

#### Scenario: invio riuscito da una card
- **GIVEN** una sessione che appartiene a un task
- **WHEN** l'invio riesce
- **THEN** SHALL comparire un commento con account, destinatario, oggetto ed esito
- **AND** NON SHALL contenere il corpo del messaggio

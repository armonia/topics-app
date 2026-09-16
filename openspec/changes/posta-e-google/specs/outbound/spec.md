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

Se la risposta non arriva, o non è quella di consenso, NON SHALL partire niente
e lo strumento SHALL dirlo con la ragione.

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

### Requirement: OUTBOUND-04 — `send_mail` e `google_call` sono strumenti dell'agente

Il server MCP di Topics SHALL pubblicare `send_mail` (destinatario, oggetto,
corpo, account fra quelli dichiarati, allegati presi dal workspace della card) e
`google_call` (servizio, risorsa, sotto-risorsa, metodo, `params` e `body` come
JSON).

Gli allegati SHALL essere risolti DENTRO il workspace della sessione: un percorso
che esce dalla cartella SHALL essere rifiutato.

Le chiamate Google che LEGGONO (`list`, `get`, e simili) NON SHALL chiedere
conferma; quelle che SCRIVONO SHALL chiederla, e un metodo che non si sa
classificare SHALL contare come scrittura.

Entrambi gli strumenti SHALL attendere la persona a GAMBE CORTE, come
`ask_user_question`: una richiesta HTTP tenuta aperta a zero byte muore per
timeout di socket dal lato del client.

#### Scenario: un metodo sconosciuto
- **GIVEN** `google_call` con un metodo che non è nell'elenco dei letti
- **THEN** SHALL chiedere conferma prima di eseguirlo

#### Scenario: un allegato fuori dal workspace
- **GIVEN** un allegato che risolve fuori dalla cartella della sessione
- **THEN** SHALL essere rifiutato e NON SHALL partire nessun invio

### Requirement: OUTBOUND-05 — Ciò che esce dalla macchina lascia una traccia sulla card

Ogni invio riuscito e ogni scrittura Google riuscita SHALL lasciare un commento
di servizio nel thread della card che li ha prodotti: chi (l'account), cosa (lo
strumento e l'oggetto o la chiamata), a chi (il destinatario o la risorsa) e
l'esito. Il commento NON SHALL contenere il corpo intero del messaggio.

Anche un tentativo RIFIUTATO dalla persona o FALLITO SHALL lasciare la sua riga:
una decisione che ferma un invio è un fatto della card quanto l'invio.

Una sessione che non appartiene a nessuna card NON SHALL fallire per questo: la
traccia è il risultato dello strumento nella chat.

#### Scenario: invio riuscito da una card
- **GIVEN** una sessione che appartiene a un task
- **WHEN** l'invio riesce
- **THEN** SHALL comparire un commento con account, destinatario, oggetto ed esito
- **AND** NON SHALL contenere il corpo del messaggio

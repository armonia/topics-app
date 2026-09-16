# Tasks: posta-e-google

La barra: `bun test server/lib/outbound-*.test.ts server/routes/outbound.test.ts
server/mcp/outbound-tools.test.ts` verde, i rail leggeri verdi, e la CI della PR
verde. Ogni test deve essere ROSSO sul codice di prima: niente invii veri, mai,
nemmeno a se stessi — la CLI dei test è un finto eseguibile che registra `argv`
e l'ambiente in un file temporaneo.

## 1. Configurazione (OUTBOUND-01)

- [x] 1.1 `server/lib/outbound-config.ts`: legge posta e Google da un `env`
  INIETTATO (mai `process.env` globale dentro il modulo), valida la forma di
  `TOPICS_MAIL_ACCOUNTS`, espone i NOMI degli account e il trasporto di
  ciascuno (Exchange riconosciuta per indirizzo contro `TOPICS_MAIL_EDM_FROM`).
- [x] 1.2 Errori parlanti: nome della variabile e file dove si scrive. Nessun
  ripiego silenzioso su un altro account.
- [x] 1.3 Test: variabile mancante, lista malformata, account sconosciuto
  (elenca i nomi, non gli indirizzi), Exchange scelta per indirizzo.

## 2. Spawn per argv (OUTBOUND-02)

- [x] 2.1 `server/lib/outbound-cli.ts`: risoluzione dell'eseguibile (assoluto o
  su cartelle dichiarate, perché sotto launchd il `PATH` non ha
  `/usr/local/bin`), spawn con array di argomenti, mai una shell, con tetto di
  tempo e cattura limitata di stdout/stderr.
- [x] 2.2 Test con finto eseguibile: `argv` ed `env` registrati su file;
  destinatario con `; rm -rf`, oggetto con virgolette e a capo, corpo con
  `$(...)` arrivano come UN argomento e non eseguono niente.

## 3. Conferma per messaggio (OUTBOUND-03)

- [x] 3.1 `server/lib/outbound-gate.ts`: apre la domanda sul canale umano
  esistente (`beginAsk`/`waitForAnswer`), la instrada nel thread della card
  (`routeAskToTaskThread`) e dipinge il pannello sulla riga dello strumento in
  attesa quando la sessione è una chat.
- [x] 3.2 La chiave della domanda deriva dal contenuto: una risposta senza
  quella chiave non è un sì. Niente regole permanenti, niente sì ereditato.
- [x] 3.3 Test: nessuna risposta = nessun invio; risposta diversa da «Invia» =
  rifiuto; chiave di un altro messaggio = rifiuto; seconda chiamata = nuova
  domanda.

## 4. Le due rotte e la traccia (OUTBOUND-04, OUTBOUND-05)

- [x] 4.1 `server/routes/outbound.ts`: `POST /api/sessions/:key/outbound/mail` e
  `POST /api/sessions/:key/outbound/google`, a gambe corte (`pending`), con la
  conferma PRIMA dello spawn e la classificazione lettura/scrittura per Google
  (sconosciuto = scrittura).
- [x] 4.2 Allegati risolti dentro il workspace della sessione
  (`isInsideDir`), rifiuto esplicito fuori.
- [x] 4.3 Commento di servizio sulla card: chi, cosa, a chi, esito — mai il
  corpo. Anche per il rifiuto e per il fallimento.
- [x] 4.4 Montaggio in `server/routes/topics.ts` accanto al router del canale
  umano.
- [x] 4.5 Test di rotta sull'armatura di `permission.test.ts`: conferma che
  blocca, account non dichiarato, variabile mancante, iniezione, commento
  scritto, lettura Google senza conferma.

## 5. Strumenti MCP (OUTBOUND-04)

- [x] 5.1 `send_mail` e `google_call` in `server/mcp/topics-mcp-server.ts`:
  schema, annotazioni (`openWorldHint: true`), handler a gambe corte con
  `onProgress` come il pannello delle domande.
- [x] 5.2 Test: gli schemi, le annotazioni, il giro delle gambe, l'errore
  quando la conferma non arriva.

## 6. Documentazione (envelope + protocollo)

- [x] 6.1 `shared/board.ts`: una riga nell'envelope, perché un agente
  dispatchato legge SOLO quello.
- [x] 6.2 `docs/board-protocol.md`: la copia per gli umani, allineata.

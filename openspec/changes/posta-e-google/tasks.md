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
- [x] 4.2 Allegati risolti dentro il workspace della sessione sul percorso
  REALE (`realPathForNewEntry` + `isInsideDir`, come
  `browser-tool-dispatcher.ts`): un link che esce e' rifiutato. Nomi, peso e
  impronta degli allegati NELLA domanda di conferma; alla CLI va la COPIA
  congelata (8.1).
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

## 7. Giro di correzioni (review della PR)

- [x] 7.1 Contenimento degli allegati sul percorso REALE: `resolve()` non segue
  i link, `path-containment.ts` lo dichiara, e un agente con una shell scrive
  `ln -s <segreto> allegato.pdf` in un comando. Test con un link vero, in
  entrambe le direzioni (fuori = rifiutato, dentro = passa col file reale).
- [x] 7.2 La conferma NOMINA gli allegati (nome + peso): «Allegati: 1» è la
  busta chiusa che OUTBOUND-03 vieta due paragrafi sopra.
- [x] 7.3 Traccia sulla card anche quando un invio CONFERMATO non parte perché
  l'eseguibile non si trova (OUTBOUND-05), su posta e su Google.
- [x] 7.4 `findWaitingToolRow` riconosce il NOME NUDO e un altro punto di
  montaggio: il runtime nativo pubblica i tool senza prefisso, e senza questo
  ogni invio in chat veniva rifiutato con «nessuno poteva confermare». Stessa
  regola già scritta in `providers/ask-user-detector.ts`.
- [x] 7.5 `HttpAnswerError` in `topics-http.ts`: una RISPOSTA del server non si
  ritenta. Prima ogni non-2xx passava per socket caduto, quindi lo stesso corpo
  veniva ri-POSTato — e dopo la conferma la seconda POST è un secondo messaggio.
- [x] 7.6 `permission.ts` svuota il registro di `routeAskToTaskThread` anche
  dopo una risposta arrivata dal pannello: era il difetto ereditato che il
  cancello aggirava per sé e lasciava intatto per `ask_user_question`.

## 8. Secondo giro di correzioni (verifica avversaria)

- [x] 8.1 La conferma vincola i BYTE, non il nome: `lib/outbound-staging.ts`
  legge e copia gli allegati in una cartella privata del server (0700, fuori da
  ogni workspace) al momento della domanda, e alla CLI va quella copia. Nome,
  peso e sha256 breve nella domanda, l'impronta dentro il digest. Test: il file
  sostituito da un link DURANTE l'attesa.
- [x] 8.2 `google_call` non è più la seconda porta della posta: i metodi di
  Gmail che spediscono sono rifiutati con un rimando a `send_mail` (elenco
  esplicito, confronto insensibile a maiuscole e spazi), e ogni scrittura viene
  riassunta in chiaro — `raw` in base64 decodificato in mittente, destinatario,
  oggetto e testo, tagli sempre annunciati.
- [x] 8.3 `asked` dice la verità: `routeAskToTaskThread` restituisce `shown`, e
  una domanda nuova SOSTITUISCE quella che trova nel registro della stessa
  sessione (la vecchia viene chiusa con una riga sua). Una voce lasciata da un
  turno interrotto rendeva muta ogni conferma successiva.
- [x] 8.4 La riga su cui si dipinge non dipende più da una scrittura differita:
  `lib/turn-body-flush.ts` pubblica il flush del turno vivo e il cancello lo
  forza prima di leggere. Prima, un invio che non fosse il primo strumento del
  turno veniva rifiutato secco.

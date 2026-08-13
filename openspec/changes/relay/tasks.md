# Tasks — relay

Ogni passo è verificabile da solo. I primi due non toccano Cloudflare: si può
sapere se il disegno regge prima di aprire un conto.

## 0. Prima di scrivere codice

- [x] 0.1 **Verificare i termini di Cloudflare.** Sciolto per la parte che
  contava, con un residuo dichiarato.

  La vecchia sezione 2.8 («Limitation on Serving Non-HTML Content»), che è
  quella che avrebbe potuto vietarci il relay, **non esiste più**: ritirata a
  maggio 2023 e sostituita da una clausola specifica per la CDN. I termini
  supplementari dei Workers permettono esplicitamente contenuto HTML e non-HTML
  (immagini, audio) **tranne i file video**. Noi trasportiamo frame JSON: dentro
  senza forzature.

  Coincidenza utile: il vincolo che il co-browse a pixel NON passi dal Durable
  Object l'avevo messo per il COSTO (RELAY-02), e si scopre che è anche ciò che
  ci tiene lontani dall'unica categoria ancora ristretta. La stessa decisione
  paga due volte.

  **Il residuo**: non stiamo mettendo Cloudflare davanti al dominio di un
  cliente (quello sarebbe «Cloudflare for SaaS» e ha clausole sue). Stiamo
  facendo girare la NOSTRA applicazione sul nostro account, e i clienti ne sono
  utenti — cioè un SaaS normale sui Workers, che è ciò per cui il Developer
  Platform è venduto. Il rischio residuo è basso, ma non è una domanda da forum:
  se il prodotto cresce, va confermata leggendo il Self-Serve Subscription
  Agreement o chiedendo a Cloudflare. Non blocca la costruzione.
- [x] 0.2 **Misurare il traffico VERO di un turno.** Fatto su 1511 turni reali di
  101 giorni: 14,9 turni/giorno per utente, durata mediana 48,7 s, media 163 s,
  **20,4 GB-s a turno**. Stimavo 4 — cinque volte meno — ma stimavo anche 50
  turni al giorno invece di 15, e i due errori si annullavano. La conclusione
  regge ($0,11 a cliente) e adesso poggia su una misura. Numeri nel proposal.

## 1. Il protocollo, prima del trasporto

- [x] 1.1 `shared/relay-protocol.ts`: registrazione, apertura di una sessione
  ospite, inoltro, chiusura. Puro, con un test — così il trasporto diventa
  sostituibile e la scelta di Cloudflare resta reversibile davvero.
- [x] 1.2 Il **contratto di cifratura**: `shared/relay-crypto.ts`. AES-256-GCM
  (cifra E autentica: senza, un relay ostile non leggerebbe ma potrebbe
  SCRIVERE), IV casuale per busta che il chiamante non può passare, chiave nel
  frammento del link. 16 casi, compresi manomissione e oracolo.
- [x] 1.3 Un relay **finto in-process** per i test: due estremi, nessuna rete.
  È ciò che permette di provare RELAY-04 (arrivare non è essere autorizzati)
  senza dipendere da un servizio esterno.

## 2. Il lato macchina

- [x] 2.1 Connessione in USCITA (`server/services/relay-client.ts`), con attese
  crescenti che si fermano: insistere ogni secondo su un relay giù è rumore.
  Nessuna porta in ascolto.
- [x] 2.2 Nessuna scorciatoia di fiducia: chi arriva dal relay non diventa
  nessuno. Il link è una CAPACITÀ su una risorsa (migration 085), e la verifica
  passa dalla riga di `share_links` — non da un ruolo, non da una sessione.
- [x] 2.3 Il relay è spegnibile e l'app locale non se ne accorge: senza
  `baseUrl` il client non si collega e non esplode, con un caso apposta.

## 3. Il lato Cloudflare

- [x] 3.1 Worker + Durable Object per installazione — `relay/`, deployato su
  `topics-relay.topics-app.workers.dev`. Nome DIVERSO da `topics-landing`: un
  `wrangler deploy` senza `--name` sovrascriverebbe il sito.
- [x] 3.2 **API di ibernazione**: `state.acceptWebSocket()`, mai `ws.accept()`.
  Ne discende che i gestori sono metodi e che chi è ogni socket si legge dai
  TAG — l'unico stato che sopravvive allo sfratto dalla memoria.
  `new_sqlite_classes` nella migration, che è anche ciò che lo tiene sul piano
  GRATUITO.
- [ ] 3.3 `setWebSocketAutoResponse()` per i ping, che così non si pagano.
  Serve quando ci sarà traffico vero da mantenere vivo.
- [x] 3.4 Il co-browse a pixel NON passa di qui, e c'è un test di contratto —
  `relay/relay-contract.test.ts` — che copre anche l'ibernazione e RELAY-04.
  Testuale, perché entrambi i difetti sono invisibili a runtime: cambia solo la
  bolletta.

## 4. Il gesto, nell'interfaccia

- [x] 4.1 Il link si crea e si APRE: la pagina dell'ospite la serve il Worker
  (l'unico posto che c'è sempre — la macchina può essere spenta, ed è il caso
  che quella pagina deve saper raccontare). La parola «tunnel» non compare da
  nessuna parte. Manca solo il bottone in `ShareControl`.
- [ ] 4.2 Il link è la credenziale: scadenza visibile e revoca dove lo si crea.
  Il SERVER è pronto (`/api/auth/share-links`: scadenza obbligatoria con tetto
  a 30 giorni, chiave consegnata una volta sola, revoca che marca e non
  cancella, conteggio delle aperture). Manca il gesto nell'interfaccia.
- [x] 4.3 Macchina spenta → «Questa cosa non è raggiungibile adesso», col
  motivo e con la rassicurazione che il link resta valido. Scaduto e revocato
  si dicono INSIEME: distinguerli racconterebbe a chi prova quale dei due gli è
  capitato.

## 5. Prima di venderlo

- [ ] 5.1 Un tetto di consumo per installazione, con un allarme. Un cliente che
  per un difetto inonda il relay non deve poter produrre una bolletta a
  sorpresa.
- [ ] 5.2 Misurare il costo reale su un mese di uso vero e confrontarlo con la
  stima di questo documento. Se diverge, si aggiorna il documento — non si
  aggiusta il ricordo.

## 6. Reperti della verifica del 2026-08-08 — letti nel codice, non stimati

Questa sezione nasce da una revisione avversariale fatta mentre si valutava se
il relay potesse trasportare una SESSIONE invece di un link. Sta qui e non in una
chat perché una scoperta che vive in una conversazione è persa: nessuno dei punti
qui sotto è stato affrontato.

**Stato: la condivisione pubblica è SPENTA** (`TOPICS_RELAY_URL` commentata in
`~/.topics-server-env`, 2026-08-08, decisione di Attilio). Il Worker resta su e
da fermo non costa. Quindi tutto ciò che segue è dormiente — ma torna vivo il
giorno che si riaccende, e non si accorge di essere stato dimenticato.

- [ ] 6.1 **`share_links.key` è la chiave AES-256 IN CHIARO a riposo**
  (`085-share-links.sql:52`). È la scelta opposta a quella fatta per i gettoni
  di sessione, dove il DB tiene solo lo SHA-256 proprio perché «un backup, o una
  lettura del file server ancora da sandboxare, consegna dati ma non accessi»
  (`server/lib/device-auth.ts:19-24`). Qui non è aggirabile — è l'host che deve
  CIFRARE, quindi la chiave gli serve intera — ma la conseguenza va scritta e
  scelta: chi legge `data/topics.db` apre ogni link vivo. Con una scheda in sola
  lettura il raggio è una scheda; con una sessione dentro, non più.

- [ ] 6.2 **L'ingresso ospite del Durable Object non autentica nessuno, e
  l'`installationId` è pubblico per costruzione.** `relay/src/worker.ts:49`
  accetta `/s/:installationId` sulla sola forma del percorso;
  `relay-do.ts:61-75` assegna un `sessionId` a chiunque, senza `shareRef`, senza
  chiave, senza tetto. E `shared/relay-crypto.ts:125` mette l'`installationId`
  nel PERCORSO di ogni link condiviso. Quindi chiunque abbia mai ricevuto un
  link può, per sempre: aprire socket ospite illimitate, tenere sveglio il DO, e
  iniettare messaggi in entrata — che sono quelli che si pagano. Il tetto di 5.1
  non basta: quello limita il danno, non l'accesso.

- [ ] 6.3 **`/agent/:installationId` — il capo HOST — è dirottabile.**
  `relay-do.ts:52-59` assegna il tag host in base al solo percorso, prima di
  qualunque `hello`. Chi conosce l'`installationId` (vedi 6.2) può presentarsi
  come la macchina. La correzione naturale — leggere una credenziale a tempo di
  `fetch` — sbatte contro `relay/relay-contract.test.ts:96-98`, che vieta
  testualmente la parola `Authorization` nel sorgente del Worker. Il divieto è
  giusto (il relay non deve conoscere le credenziali di Topics) ma va rifatto
  per distinguere «non legge le credenziali dell'utente» da «non ha una propria
  autenticazione di trasporto».

- [x] 6.4 **RISOLTO.** `relay/relay-do.run.test.ts` istanzia `SessioneRelay` e lo
  guida come lo guida il runtime dei Worker: `fetch()` per l'aggancio, poi i
  METODI `webSocketMessage` e `webSocketClose`, che è l'unica forma ammessa
  quando si ibernà. Finto è solo il contorno (socket, tag, storage); il codice
  del relay è quello vero. Resta corretto ciò che il contract test presidia
  testualmente: l'ibernazione non ha sintomi osservabili a runtime.
  *Il rilievo originale, per memoria:* `relay-contract.test.ts:13-15`
  lo legge con `readFileSync` come STRINGA; non c'è miniflare, né
  `vitest-pool-workers`, né `unstable_dev` in tutto il repo, e nessun test
  collega `relay-client.ts` a `relay-do.ts`. Instradamento, sfratto,
  `guest-left`, `denied`, chiusura: zero copertura a runtime. Esistono due
  implementazioni del protocollo (`shared/relay-fake.ts`) e **nessuna delle due
  valida l'altra**.

- [ ] 6.5 **`gestisci` non ha test.** `server/services/relay-client.ts:104-124`
  è la funzione che un trasporto di sessione sostituirebbe per intero, e
  `relay-client.test.ts` esercita solo `__servi`. Il rifiuto indistinguibile
  (`:117-123`), citato come presidio anti-oracolo, vive in codice mai eseguito.

- [ ] 6.6 **«null = si chiude» è un commento, non un comportamento.**
  `shared/relay-protocol.ts:140` lo afferma, ma `relay-client.ts:141-144` fa
  `if (m) void gestisci(m)` — il messaggio invalido si ignora in silenzio e la
  socket resta aperta; `relay-do.ts:93-98` risponde `denied: bad-version` senza
  chiudere; `pagina-ospite.ts:128-136` non chiama nemmeno `leggiMessaggio`.
  Conseguenza: un deploy del Worker che cambi l'involucro non rompe
  rumorosamente gli host non aggiornati — degrada in silenzio.

- [ ] 6.7 **Prima di trasportare una sessione servono le fondamenta dei
  permessi.** L'allowlist degli ospiti (`server/lib/grants.ts:62-83`) è di sei
  prefissi e NON contiene `/api/ui-state`, `/api/projects`, `/ws/terminal/:id`,
  `/ws/browser/:id`; `:99-103` nega ogni metodo mutante tranne il logout. Non è
  un dettaglio da allargare: `grants.ts:9-16` spiega che spazi e tab «vivono
  dentro un blob JSON da ~56 KB in una riga sola di `ui_state` … Vanno promossi
  a righe PRIMA, ed è lavoro di fondamenta, non una voce in un enum». Nota che
  questo NON blocca il caso «il MIO telefono raggiunge il MIO Mac»: un
  dispositivo `owner` non è confinato. Blocca «un ospite ha una sessione vera».

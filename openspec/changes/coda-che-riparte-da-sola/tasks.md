# Tasks: coda-che-riparte-da-sola

I numeri fra parentesi sono quelli misurati nell'audit del 17/09
(`scratchpad/card-fino-a-done.md`): quante volte quel buco ha fermato una card
davvero, non in teoria.

## Tornata 1 — la coda riparte (KANBAN-75, 82, 83)

- [ ] T1.1 Esenzione «prima card» sul pavimento della MEMORIA: con zero agenti
      vivi e zero corse di check pre-review si ammette una card, e il verdetto lo
      dichiara. Il disco non ha esenzione. Vale anche per il `resume` di una card
      gia' al lavoro. (7 card ferme 45-51 h; `held2m >= 6 GB` 0 volte su 1455)
- [ ] T1.2 Test: `admissionBlock` sotto il pavimento con `inFlight = 0` e
      `checkRuns = 0` ammette; con un agente vivo no; il disco pieno non ammette mai.
- [ ] T1.3 I campioni del segnale di memoria sopravvivono al riavvio e si
      ricaricano applicando `MEM_SAMPLE_GAP_MS`. (28 finestre azzerate in 25,7 h,
      circa 56 min al giorno)
- [ ] T1.4 Test: campioni di 3 s ereditati danno un minimo; campioni di 10 min no.
- [ ] T1.5 Il riscaldamento della finestra non ruba la chiave di dedup al motivo
      vero, e il registro «gia' detto» decade al cambio della frase. (80 commenti
      su 80 con la frase sbagliata dopo il 15/09 17:49)
- [ ] T1.6 Test: `holdKey` distingue riscaldamento e pavimento.
- [x] T1.7 REGRESSIONE della T1.1, chiusa: il censimento («c'e' del nostro vivo
      qui?») decideva il RAMO della riga e il listino («c'e' del nostro che deve
      ancora spendere qui?») la CIFRA. Con le sole card parcheggiate sulla CI in
      volo la riga chiedeva `pavimento + prezzo + 0` = 10 GB a una macchina su
      cui nessuno spendeva. Ora il ramo e la cifra escono dallo stesso elenco
      (`spendingHere`), e l'esenzione resta sul censimento (`ourWorkRunning`):
      una card sulla CI tiene viva una sessione — 240 MB gia' dentro `held2m` —
      ma non ha nessuna fiammata futura da coprire.
- [x] T1.8 Test sulla banda 6-10 GB, che prima non copriva nessuno: con due card
      off-lane in volo e una terza in coda, 25 battiti per lettura.

      | held2m | prima | adesso |
      |---|---|---|
      | 4,8 GB | ferma | ferma (l'esenzione NON si ri-arma) |
      | 7,0 GB | FERMA | parte |
      | 8,0 GB | FERMA | parte |
      | 9,9 GB | FERMA | parte |
      | 12,0 GB | parte | parte |

## Tornata 2 — gli orologi muti (KANBAN-84)

- [ ] T2.1 `taskIdleDays` smette di contare `tasks.updated_at`, che il dispatcher
      riscrive ogni 60 s mentre trattiene la card. (7 card su 7, zero abbandoni
      in tutta la storia del log)
- [ ] T2.2 Test: ultimo commento a 9 giorni e chip riscritto adesso danno 9 giorni.
- [ ] T2.3 `WAIT_SERIES_MAX_MS` valutato anche fuori da `deferForWait`, con
      parcheggio `waited_out`. (2 card oltre il tetto da 45 e 31 h, zero parcheggi)
- [ ] T2.4 Test: `wait_since` a 5 ore e nessun turno partito produce il parcheggio.
- [ ] T2.5 Una card con `reopened_actor = 'human'` riparte con i commenti umani da
      `reopened_at` in poi, non col sollecito da turno interrotto. (3 card ferme
      da 45 h, 44 riavvii ciascuna)
      TRAPPOLA, verificata sul DB il 17/09: il testo della bocciatura e' scritto
      nello STESSO istante di `reopened_at`, non dopo — su `f981f62c` il commento
      `author='user' kind='comment'` e la riga `status` «review→in_progress`»
      hanno entrambi `2026-09-15T13:49:31`, e differiscono solo per i millisecondi.
      Un filtro `created_at > reopened_at` non trova niente e il fix sembra fatto
      mentre non fa nulla. Prendere i commenti umani a partire da `reopened_at`
      inclusivo, con una tolleranza all'indietro, e provarlo su quella card.
- [ ] T2.6 Test: reconcile su una card bocciata da un umano porta il testo umano.
- [ ] T2.7 Il tetto sulla durata vale solo su una serie ANCORA IN CORSO: con
      `wait_since` scritto e `dispatch_deferred_until` NULL un turno e' gia'
      ripartito senza ridichiarare l'attesa, e la card non si parcheggia.
      (misurato contro `origin/main` sulla forma di `c4d48d3e`: main la manda
      `in_progress` con un turno, il giudice di fuori la parcheggiava
      `waited_out` con zero turni)
- [ ] T2.8 La guardia su `commentIds` copre tutti e tre i chiamanti di
      `bufferResume`: `.slice(0,1)` su `clearSlotWait` e sul ramo di `resume` in
      attesa di slot lasciava 2576 test verdi in `server/services`.

## Tornata 3 — il verdetto CI azionabile (KANBAN-85)

- [ ] T3.1 Run terminale senza verdetto: un rerun, e se non si puo' il referto
      nomina il commit nuovo. (15 delle ultime 100 sha sono gia' in quello stato)
- [ ] T3.2 Il giro esce al primo rosso accertato, le altre righe CI diventano non
      misurate con quella ragione.
- [ ] T3.3 La sonda del conflitto si consuma solo su una risposta conclusiva.
      OSSERVATO IL 17/09, non piu' teorico: la bozza #78 aperta dalla consegna di
      `c4f53a85` ha risposto `mergeable UNKNOWN` alla prima lettura, 15 secondi
      dopo l'apertura. GitHub calcola la mergeability in modo pigro, quindi
      `UNKNOWN` e' la risposta NORMALE nei primi secondi, non un caso raro — ed e'
      proprio quella che oggi arma `conflictProbed` senza aver letto niente.
- [ ] T3.4 `ownCommits === 0` e' non misurato, non due verdi.
- [ ] T3.5 Il contratto fissa anche la forma dei nomi dei job e2e (un solo asse
      nella matrice).
- [ ] T3.6 Durante l'attesa la card porta il link della PR e della run, e la riga
      di attesa non attribuisce la misura al cancello della board. (15 min ciechi
      per consegna)
- [ ] T3.7 Il dettaglio della card dipinge `unknown` come non misurato, non rosso.
      (6 card storiche; con le righe CI `unknown` diventa l'esito piu' probabile
      dopo il verde)
- [ ] T3.8 Test per ciascuno dei sette.

## Tornata 4 — quel che resta aperto dopo il land

- [ ] T4.1 Un land che riallinea azzera `checks_commit` e dice che i verdetti CI
      si riferivano al commit misurato, non a quello fuso. (22 land su 32 negli
      ultimi 7 giorni hanno la riga di riallineamento, 18 muti)
      OSSERVATO IL 17/09 sul land di `c4f53a85`: il land ha creato `596e828dd`
      («Riporta main nel ramo prima del land») e poi il merge `20a271a11`, mentre
      `checks_commit` e `delivery_commit` sono rimasti entrambi `71e96ec13f`. La
      card dichiara quindi «CI verde» su un albero diverso da quello atterrato,
      alla prima consegna che quella frase l'ha potuta dire.
- [ ] T4.2 La bozza di PR e il ramo remoto si chiudono dopo il land, il rifiuto
      definitivo e l'archiviazione. (regime atteso: circa 94 card a settimana che
      lascerebbero la bozza aperta; gia' oggi 41 rami `topics/*` su origin, 39
      dentro `main`, nessuno cancellato)
      OSSERVATO IL 17/09 sul land di `c4f53a85`, e la forma del buco e' piu'
      stretta di come l'avevo scritta. La bozza #78 si e' chiusa DA SOLA come
      MERGED alle 00:37:56Z, un minuto dopo il land: il land fonde con
      `merge --no-ff`, quindi i commit del ramo diventano antenati di main, e
      appena main viene spinto GitHub marca la PR come fusa. Quindi la PR NON
      perde quando il land va a buon fine e main viene spinto. Perdono due cose:
      il RAMO remoto, sempre (dopo questo land i rami `topics/*` gia' dentro main
      erano 40, nessuno cancellato; l'ho tolto a mano e sono tornati 39), e la
      bozza quando la card esce da review senza un land — rifiuto definitivo,
      archiviazione — oppure quando main non viene spinto. Il fix vada su quelle
      due, non sul caso che si sistema da se'.
- [x] T4.3 `isChecksHold` incrocia il registro vivo del cancello invece di fidarsi
      della spia `running` nel DB, che solo un boot spegne. (89 boot hanno trovato
      una spia accesa; 1253 riarmi del giudice di stallo) → KANBAN-86.
      Il predicato e la passata stanno in `server/services/checks-lights.ts` e non
      piu' in `server.ts`, che non ha file di test: prima la meta' che decide
      davvero era coperta da niente. La passata riemette anche la consegna che
      questo processo tiene per la card di cui spegne la spia — senza, T4.3 e T4.4
      spingevano in direzioni opposte (spia onesta, card ferma, e tre soli boot
      prima di rinunciare).
- [x] T4.4 `pending_deliveries` conta i giri, e oltre N lo dice sulla card invece
      di rifare il giro muto. → KANBAN-87.
      Due difetti trovati dalla verifica avversaria e chiusi: il reset su commit
      nuovo saltava le righe nate con `commit_sha` NULL — cioe' proprio quelle che
      bruciano i giri, perche' la gamba interrotta scrive prima del checkout — e
      la clausola nominava `rounds` senza sondare la colonna, quindi su un DB
      ripristinato da backup il `catch` si mangiava la consegna intera.
- [x] T4.5 L'etichetta di un hold del provider dice la data quando non e' oggi, e
      oltre una durata diventa una domanda. (43 righe «resumes at 14:45» per un
      hold di 6 giorni) → KANBAN-88.
      La nota nel thread ha uno slot: il registro «gia' detto» vive nella closure
      del dispatcher e rinasce vuoto a ogni boot (~35 min), mentre l'attesa dura
      giorni — circa 300 paragrafi identici al giorno su 7 card.
- [x] T4.6 Test per ciascuno: `checks-lights.test.ts` (7),
      `pending-delivery-store.test.ts` (6, il file non esisteva),
      `tasks.delivery-survives-reload.test.ts` (il tetto dei giri),
      `task-dispatcher-provider-hold.test.ts` (cinque boot su tre giorni).
      Ogni guardia e' stata mutata e ha reso rossa la suite.

## Tornata 5 — il gemello: lo stesso pavimento frena ogni check

Osservato dal vivo il 17/09 sulla prima consegna che passa dalle righe CI
(`c4f53a85`, iniziata 01:38). `memoryWaiter` (`review-checks-brakes.ts:137`)
confronta lo STESSO minimo su 2 minuti con lo STESSO pavimento di 6 GB prima di
ogni comando, e la macchina legge 4,8-5,9. Righe vere del log:

```
[review-checks] "typecheck" waits: lowest free memory of the last 2 min 5.4 GB, under the 6 GB floor
[review-checks] "typecheck" starts after 372 s
[review-checks] "check:deadcode" waits: lowest free memory of the last 2 min 5.2 GB, under the 6 GB floor
```

A differenza dell'ammissione qui l'uscita c'e' (`MEMORY_WAIT_MAX_MS`, 30 min e
poi parte comunque), quindi non e' uno stallo: e' un ritardo fisso. Il tetto e'
**per GIRO, non per comando** — `spentMs` si accumula nella chiusura di
`memoryWaiter`, quindi quando un comando lo sfonda tutti i successivi partono
subito con `anyway` (ed e' per questo che il log stampa la stessa riga per
`check:deadcode` e per `static-rails`: il secondo non ha aspettato). Misurato su
questa consegna: i quattro comandi locali hanno impiegato **32 minuti dei quali
circa 30 di sola attesa**, su una macchina che nel frattempo `[memsig]` chiamava
`swap=calm`. Il prezzo e' quindi mezz'ora per consegna, non tre ore; con 121
ingressi in review in 7 giorni resta l'ordine delle decine di ore a settimana.

Un freno che spara sempre la sua valvola non e' un freno, e' un timer. La valvola
pero' e' l'unico pezzo che si puo' toccare: il pavimento e' montato una volta per
tutto il server, non per board, e la board `dancerooms-intq6i` ha come unico
check locale una suite unit — l'albero che il freno esiste per non far partire su
un Mac vuoto. Quindi resta, e quello che cambia e' quanto si aspetta: sotto
thrash aspettare compra memoria, a Mac calmo la lettura migliora di rado e a
tratti lunghissimi (`held2m >= 6 GB` nel 15,2% delle 1589 letture con un valore
in 29,1 ore, con 854 campioni consecutivi — 16,2 ore fra il primo e l'ultimo —
sotto il pavimento). CORREZIONE: avevo scritto «15,5% di 1553 letture» e «circa
quattordici ore». La percentuale era contata sulle righe invece che sulle letture
con un valore, e le quattordici ore erano il conteggio dei campioni convertito a
un campione al minuto invece della distanza fra i due timestamp. Rimisurato sul
log intero (`~/.claude/jarvis/logs/topics-server*.log`, 1654 righe `[memsig]`,
16/09 07:27Z - 17/09 12:33Z): 241 letture su 1589, tratto 07:27:57Z - 23:37:44Z.

- [x] T5.1 MISURATO, sulla consegna di `c4f53a85` conclusa il 17/09 alle 00:46Z,
      leggendo i `ms` di `checks_json`:

      | riga | esecuzione | coda |
      |---|---|---|
      | typecheck | 12,7 s | 0 s |
      | lint | 55,3 s | 0 s |
      | check:deadcode | 4,4 s | 0 s |
      | static-rails | 7,8 s | 0 s |

      **80 secondi di esecuzione in tutto.** Il giro ha impiegato 32 minuti dal
      primo comando all'ultimo, quindi circa 30 minuti e mezzo sono stati attesa
      del pavimento — 23 volte il lavoro che il freno stava proteggendo, su una
      macchina che nella finestra del giro leggeva `swap=calm` in 40 dei 42
      campioni sotto il pavimento. Le due righe CI hanno poi preso 624,7 s (unit)
      e 1065,8 s (e2e) di attesa della CI vera, che e' tempo di GitHub e non si
      tocca. CORREZIONE ai numeri di questa riga: nella finestra 23:41-00:27 il
      log ha 44 righe `[memsig]`, 2 sostenute, 42 sotto pavimento e 40 di quelle
      calme — non 46/3/43/41 come avevo scritto prima, e non «calmo per tutta la
      durata».
- [x] T5.3 PRIMA STESURA SBAGLIATA e rifatta: «a swap calmo il pavimento non
      trattiene» non indeboliva il pavimento, lo cancellava (sotto swap
      sostenuto il freno usciva gia' prima di leggerlo, quindi calmo era l'unico
      stato in cui decideva). Fatto invece: il pavimento resta in vigore calmo e
      sostenuto, e cambia la VALVOLA — tre minuti quando a trattenere e' il
      pavimento su un Mac calmo, i trenta di oggi sotto swap sostenuto. La riga
      del fail-open nomina la condizione letta in quell'istante, non l'ultima che
      quel comando aveva stampato (che per un comando mai in attesa e' nessuna).
- [x] T5.4 Le due valvole hanno un orologio ciascuna. Con un contatore solo il
      tempo di una condizione pagava l'altra: dieci minuti di swap sostenuto a
      5,2 GB e il comando partiva NELL'ISTANTE del verdetto calmo, senza che il
      pavimento l'avesse trattenuto un secondo — un episodio di thrash regalava
      l'esenzione dal pavimento per il resto del giro. Ogni tratto d'attesa e'
      addebitato alla condizione in vigore mentre passava; il caso e' fissato al
      tredicesimo minuto (dieci di swap + tre di pavimento).
- [x] T5.5 La riga del fail-open dice l'attesa VERA di quel comando e, accanto,
      cio' che il giro aveva speso di quel budget: prima stampava il budget al
      posto della durata, cioe' «dopo 3 minuti» per tre comandi che avevano
      atteso tre, zero e zero. Il log degli errori non ha timestamp: quella riga
      e' l'unica traccia che resta del giro.
- [x] T5.7 L'ORDINE DENTRO `holdReason` ERA UNA GUARDIA SCOPERTA. Con due
      orologi quell'ordine non sceglie piu' l'etichetta del log ma il BUDGET:
      spostando `room` prima di `spacing` la suite restava verde (29 pass / 0
      fail) mentre il comportamento cambiava — un giro sotto il pavimento mentre
      gira il comando di un altro giro passava da `heldBy: "spacing",
      budgetMs: 1800000` a `heldBy: "room", budgetMs: 180000`, e con la valvola
      calma gia' spesa partiva ATTRAVERSO i 120 s di spaziatura, cioe' la mandria
      del 15/09. Nessun test teneva insieme `held < floorGB` e un rilascio altrui
      in corso. Adesso due: uno sulla decisione e uno sul waiter con due giri,
      dove il secondo parte a 300 s e non a 180.
- [x] T5.8 DUE CAMBI CHE NON AVEVO DICHIARATO, scritti nel requisito e fissati da
      un test ciascuno invece che annullati. (a) Il tetto di un giro e' la somma
      delle due valvole, `maxWaitMs + min(3 min, maxWaitMs)`: 33 minuti in
      produzione, dove `checksMemoryFloor` monta senza `maxWaitMs`. E' il prezzo
      di non far pagare una condizione all'altra, e il caso peggiore vale tre
      minuti. (b) `MEMORY_WAIT_CALM_MAX_MS` e' un soffitto duro: il tetto del
      chiamante puo' solo accorciare la valvola calma. Nessun seam per alzarla,
      perche' nessun chiamante ne ha chiesto uno — il pavimento e' montato una
      volta per tutto il server.
- [x] T5.9 PREMESSA MIA FALSA, ritirata: avevo scritto che il rail
      `typecheck:e2e` era rosso su `origin/main` e avevo aggiunto due
      annotazioni di tipo a `tests/unit/no-third-party-emails.test.ts` per
      «ripararlo». Non era rosso: con il tsc pinnato dal repo,
      `tsc -p tsconfig.e2e.json --ignoreDeprecations 5.0` esce 0 sul file
      originale. Le due righe sono state annullate e il file e' tornato identico
      a main.
- [ ] T5.6 DA DECIDERE COL PROPRIETARIO, ancora aperta: il cancello cancellato
      insieme alla vecchia T5.2 riguardava il comportamento del pavimento a swap
      calmo, e la valvola da tre minuti lo cambia lo stesso — un `test:unit` da
      4-11 GB su questo Mac a 5,2 GB adesso parte dopo 3 minuti invece di 30. Il
      numero non e' stato approvato da nessuno. La forma giusta, se si chiude, e'
      un prezzo per COMANDO (l'albero unit non e' un typecheck) invece di un
      pavimento unico montato una volta per tutto il server: oggi il freno swap
      non ha nemmeno una vittima da interrompere, `SWAP_VICTIM_MIN_GB` = 1 GB
      contro un tsc misurato a 460 MB.

## Barra

- `bun run typecheck`, `bun run lint`, `bun run check:deadcode`, i rail statici, e
  i test dei moduli toccati: tutti verdi prima del push.
- La suite unit intera e gli e2e li misura la CI della PR, non il Mac.
- La prova che la tornata 1 funziona non e' un test: e' una card che parte con la
  macchina sotto il pavimento e nessun lavoro di Topics in volo.

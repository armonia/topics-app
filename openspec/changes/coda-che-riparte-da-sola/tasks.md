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
- [ ] T4.3 `isChecksHold` incrocia il registro vivo del cancello invece di fidarsi
      della spia `running` nel DB, che solo un boot spegne. (89 boot hanno trovato
      una spia accesa; 1253 riarmi del giudice di stallo)
- [ ] T4.4 `pending_deliveries` conta i giri, e oltre N lo dice sulla card invece
      di rifare il giro muto.
- [ ] T4.5 L'etichetta di un hold del provider dice la data quando non e' oggi, e
      oltre una durata diventa una domanda. (43 righe «resumes at 14:45» per un
      hold di 6 giorni)
- [ ] T4.6 Test per ciascuno.

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

Un freno che spara sempre la sua valvola non e' un freno, e' un timer. E il freno
ha gia' la misura giusta accanto a quella sbagliata: il verdetto sullo swap
misura il thrash vero, il pavimento misura un numero che qui non arriva mai.

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
      macchina che per tutta la durata leggeva `swap=calm`. Le due righe CI hanno
      poi preso 624,7 s (unit) e 1065,8 s (e2e) di attesa della CI vera, che e'
      tempo di GitHub e non si tocca.
- [ ] T5.2 Da decidere col proprietario (non toccare prima): a swap calmo il
      pavimento non trattiene un check, e resta guardia solo mentre lo swap e'
      sostenuto.

## Barra

- `bun run typecheck`, `bun run lint`, `bun run check:deadcode`, i rail statici, e
  i test dei moduli toccati: tutti verdi prima del push.
- La suite unit intera e gli e2e li misura la CI della PR, non il Mac.
- La prova che la tornata 1 funziona non e' un test: e' una card che parte con la
  macchina sotto il pavimento e nessun lavoro di Topics in volo.

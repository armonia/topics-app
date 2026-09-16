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
- [ ] T2.6 Test: reconcile su una card bocciata da un umano porta il testo umano.

## Tornata 3 — il verdetto CI azionabile (KANBAN-85)

- [ ] T3.1 Run terminale senza verdetto: un rerun, e se non si puo' il referto
      nomina il commit nuovo. (15 delle ultime 100 sha sono gia' in quello stato)
- [ ] T3.2 Il giro esce al primo rosso accertato, le altre righe CI diventano non
      misurate con quella ragione.
- [ ] T3.3 La sonda del conflitto si consuma solo su una risposta conclusiva.
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
- [ ] T4.2 La bozza di PR e il ramo remoto si chiudono dopo il land, il rifiuto
      definitivo e l'archiviazione. (regime atteso: circa 94 card a settimana che
      lascerebbero la bozza aperta; gia' oggi 41 rami `topics/*` su origin, 39
      dentro `main`, nessuno cancellato)
- [ ] T4.3 `isChecksHold` incrocia il registro vivo del cancello invece di fidarsi
      della spia `running` nel DB, che solo un boot spegne. (89 boot hanno trovato
      una spia accesa; 1253 riarmi del giudice di stallo)
- [ ] T4.4 `pending_deliveries` conta i giri, e oltre N lo dice sulla card invece
      di rifare il giro muto.
- [ ] T4.5 L'etichetta di un hold del provider dice la data quando non e' oggi, e
      oltre una durata diventa una domanda. (43 righe «resumes at 14:45» per un
      hold di 6 giorni)
- [ ] T4.6 Test per ciascuno.

## Barra

- `bun run typecheck`, `bun run lint`, `bun run check:deadcode`, i rail statici, e
  i test dei moduli toccati: tutti verdi prima del push.
- La suite unit intera e gli e2e li misura la CI della PR, non il Mac.
- La prova che la tornata 1 funziona non e' un test: e' una card che parte con la
  macchina sotto il pavimento e nessun lavoro di Topics in volo.

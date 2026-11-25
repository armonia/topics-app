# VERIFICA, quarto giro (09/10)

Il seguito di [VERIFICA-giro3.md](VERIFICA-giro3.md): i due aperti che il terzo giro aveva lasciato su #270 (#278) e i residui di T22.

## #278 · La chat «in corso» a lavoro finito e lo Stop in ritardo che chiudeva il turno risvegliato

- **La chat.** Per una chat la mappa dei compiti la riscrive intera il provider (lo snapshot del CLI, la fine del
  turno della route). Quando toglieva l'ultimo compito a un turno parcheggiato `watching`, nessuna riga del
  transcript lo diceva al tracker: la chat restava «in corso» fino al turno dopo (mediana 6 minuti, p90 55, su 200
  transcript). Ora lo store avvisa il tracker e il turno riposa, datato al suo Stop, dopo 5 s di quiete senza avvisi
  in coda: il CLI svuota la mappa qualche ms prima di accodare l'avviso che sveglia il turno. Una riga che sveglia il
  turno annulla lo svuotamento, e lo decide la fase, non il confronto fra l'ora della CLI e quella del server.
- **Lo Stop in ritardo.** Il CLI scrive la consegna di un avviso 0,8–5,7 s dopo lo Stop, dietro gli hook Stop
  sincroni. Se il tail la leggeva prima dell'hook, lo Stop chiudeva il turno appena aperto: `awaiting-user` col turno
  che girava e, su un terminale, due annunci invece di uno. Ora la riga che apre un turno data l'ordine degli hook
  come un hook: lo Stop partito prima arriva vecchio. Vale per il prompt, l'avviso consegnato e le righe `isMeta` con
  `turnOrigin` (scatto di un cron, messaggio di un'altra sessione: 146 righe su 2555 transcript). Su un terminale la
  riga più nuova di ogni hook apre il turno anche nello store, così un cron one-shot del turno prima esce come da
  disegno.
- Prove sul commit finale, Bun 1.4.2 e 1.3.8, copia ferma al commit: 11 casi della chat (4 rossi su main, poi le due
  corse trovate dal revisore, ciascuna rossa sul giro prima); 23 casi dello Stop in ritardo più 3 di `opened` (le 8
  forme in ritardo e i cron rossi prima, le forme in tempo verdi prima e dopo); i file toccati 138 su 138, tre giri per
  Bun; 33 file attorno a tracker, store e route della chat 500 su 500; 23 cancelli della CI su ogni commit.
- Mutazioni: 10 su 11 del primo giro uccise, poi tutte quelle dei giri successivi (`woke` muto, ogni riga che annulla,
  il vecchio confronto delle ore, `opened` vuoto, il tail senza `opened`, l'apertura nello store fuori dai suoi tre
  vincoli, meta mai, senza `turnOrigin`, senza `isMeta`). Le tre sopravvissute non cambiano un comportamento: la
  funzione di prova `ingestTranscriptLine`, «ogni riga data l'ordine», l'apertura nello store anche per le chat.
- **Due revisori indipendenti, quattro giri ciascuno**, con sonde che tengono l'orologio del tracker e ogni scenario
  col fix e senza. Chat: il primo giro confuta la corsa del commit scartato (`4d28618e0`), il secondo gli orologi
  mescolati (`0cad45b42`), sul terzo regge tutto (22 su 22 sonde, 301 su 301 sulle suite vicine). Stop in ritardo: il
  primo confuta il cron one-shot (`2cb00b95f`) e le righe di cron e messaggi tra sessioni (`3d2f88f11`), il secondo e
  il quarto confermano i casi chiave (84 su 84 sonde, identiche sulle due Bun).
- **Provate e tolte, perché i revisori le hanno smontate.** Ridatare la fase a uno Stop che la trova già a riposo
  (`efb202d9d`, per il turno breve fra due giri del tail): con un cron one-shot pendente il terminale restava
  `watching` per sempre, revert in `8118fbbec`. Tipizzare `meta` le righe della modalità bash (`58125323d`): le sole
  del corpus vengono da Claude Desktop e aprono davvero un turno, revert in `bad8c8446`. L'albero finale è identico a
  `3d2f88f11`.
- Lasciati aperti, tutti nel corpo della PR: la coda e l'ordine degli hook vivono in memoria (un riavvio li perde); un
  tail in ritardo di oltre 5 s mostra un riposo di un attimo; un hook timbrato più tardi della consegna riporta il
  difetto vecchio; un prompt in coda con lo Stop in ritardo annuncia una volta sola; un `SessionStart` vecchio salta la
  pulizia della mappa; il `PostToolUse` tardo di un `CronCreate`; **il turno breve fra due giri del tail torna
  `running` fino al reaper, già su main** (la correzione giusta deve far vedere allo store il turno non visto,
  distinguendolo da una seconda copia dello stesso Stop); il `!` della CLI interattiva; il senso di `turnOrigin` è
  misurato, non documentato; le CLI senza `turnOrigin` restano come su main.
- Fusa in `930a72d1f`, CI della PR 20 su 20.

## T22 · Tre residui di cloud-quality-pass (#279), verificata sul Mac

- **Done che tornava a 25 card.** Cambiata vista (archivio e ritorno) la board rimonta le colonne, e Done ripartiva
  dalla prima pagina. Ora le pagine raggiunte si ricordano per vista e colonna (`columnPages.ts`), solo in memoria.
  COLVOL-08 in WebKit a 390x844: rosso sul codice di prima (25 invece di 50), verde dopo, 3 giri su 3; rosso anche con
  la memoria mutata.
- **#275 in WebKit.** Il test della conversazione del task che segue l'ultima risposta ora gira anche nel progetto
  `webkit`. Senza l'osservatore che ri-aggancia il fondo è rosso (280 px dal fondo, finestra accorciata). La
  mutazione sulla seconda rete (`onScroll`) non compila, quindi quel punto resta senza prova sul Mac; anche T22 lo
  dichiara non provato su WebKit Linux.
- **#272.** `useLoadOnReach.test.ts` copre i due punti in cui la riga riguarda il suo contenitore: ognuna delle due
  mutazioni fa cadere il suo caso.
- **`claude-code-live-mark` rosso solo nella corsa unica** (il «trovato e non fatto» di T21). La causa: cinque file
  rimettevano l'osservatore statico delle sveglie a un no-op, che vuol dire «adozione in arrivo», e il turno dopo
  restava trattenuto. Ora lo rimettono a `() => false`. Con i test di prima `abort-drain` o `boot-replay` seguiti da
  `live-mark` sono rossi 4 su 4, sulle due Bun; con il fix verdi 4 su 4.
- Unit della traccia 5 su 5 sulle due Bun; i due file e2e 9 su 9 in WebKit, 18 video.
- Fusa in `c4dd7eb9c`.

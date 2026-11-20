# VERIFICA, terzo giro (08/10 sera)

Il seguito di [VERIFICA.md](VERIFICA.md): T18, T19 e le PR fuse la sera dell'08/10, con la prod portata su main.

## T18 · Una chat in corso si riallinea da sola — accettata con un fix mio (fusa in `91ed43ff1`)

- Sul Mac i 4 file di test di T18 danno 57 pass e 0 fail su 1.3.8 e 1.4.2. Riallineamento dal taglio:

  | Caso | Tempo |
  |---|---|
  | Attacco perso | 6,8–7,4 s |
  | Socket del broker caduto | 3,5 s |
  | Turno «woken» | 8,0 s |
  | Controllo (socket caduto, riconnessione riuscita) | 0,56–0,71 s |

  Prima: mai entro 15 s.
- Mutazione su una worktree scratch, sonda spenta: rossi «attacco perso», «socket caduto e prima riconnessione
  fallita» (il debito di riaggancio si salda alla prossima richiesta, e senza sonda non ne parte nessuna) e
  «woken». Il controllo resta verde.
- **Trovato in verifica (verificatore indipendente, con un test che lo riproduce col demone vero).** Dopo un
  riavvio il server adotta il figlio ancora vivo nel demone (`resumed`), e fino all'arrivo di `attachLive` il
  suo `consumedOffset` vale 0. Se quell'aggancio tardava oltre un giro della sonda, cosa probabile sotto swap,
  la sonda leggeva un buco da 0 e riattaccava da lì. Ripiegata nello stesso blocco della risposta
  dell'aggancio, **la storia intera del figlio diventava la risposta del turno nuovo**. Sarebbe morso proprio
  al riavvio di un deploy.
- **Fix:** `attachPending` dallo spawn finché l'aggancio iniziale non atterra. `resyncStream` non parte da un
  offset che non sappiamo, e la sonda salta quei processi. In più il riattacco della sonda fa un tentativo
  solo: con un ack in stallo il buco aspetta 30 s invece di riciclare il socket di tutti i turni (il caveat
  del verificatore).
- Il test di regressione (l'ultimo `describe` di `claude-code-stream-lag.test.ts`, frame trattenuti come in un
  loop in stallo) è rosso sul codice di prima (resync da 0) e verde col fix su 1.3.8 e 1.4.2.
- Le altre tre affermazioni reggono:
  - la guardia di `onData` non perde byte (ogni riavvolgimento voluto passa con `replayMute`/`replaySilent`);
  - il routing con un solo proprietario dà lo stesso risultato;
  - nessun bisogno di un demone nuovo (`list` con `endOffset` c'è dal 17/07).
- Lasciato a T19: il figlio che esce mentre siamo staccati perde la coda del turno, e la fase 2 della
  riadozione può ripiegare frame (doppi, non persi).

## Fusione e prod, terzo giro (08/10 sera)

- Fuse su main: #258 (`6eaa7c3e5`, la passata integrata con T15-T18), #260 (cache dei .deb di Playwright), #261
  (CHAT-COMPOSER-02), #262, #263, #264 (T19) e #265.
- #254 chiusa: il suo unico file, `reports/T7.md`, era identico dentro #258.
- Prod portata su `e0e85b523` dopo la CI di main verde 15/15.
  - Backup del DB fatto prima del cambio, integrity ok, 309 MB.
  - Il server si è ricaricato dal watcher alle 18:25 e serve il bundle `index-axizUA79.js`.
  - Nel log dopo lo start non ci sono errori.
- 58 rami `cloud/*` e `claude/*` archiviati come tag `archive/<nome-piatto>` e cancellati, quelli di T19 dopo la
  fusione di #264.

## #261 · CHAT-COMPOSER-02, la bozza che cancellava il primo messaggio (di un'altra sessione, verificata qui)

- Diff letto: la bozza si legge solo nel render (`useState` e cambio di topic), mai in un effetto dopo il commit.
- I giri della sessione che l'ha scritta:
  - rossa su main 2/2 (`Received ""`);
  - rossa sulla mutazione che rimette `setMessage` nell'effetto 2/2;
  - verde col fix in WebKit, 3 giri, 6/6.
- CI 17/17.

## L'accordion di #257 sui cinque punti di Attilio

- Controllo fatto sulla build `e0e85b523`, quella andata in prod, in WebKit. È lo stesso motore dell'app, ma su un
  server isolato: automatizzare la finestra aperta di Attilio voleva dire usare il suo schermo e la sua sessione.
- `chat-strips-in-transcript` passa 2/2. Il secondo test misura i cinque punti:
  - il log si apre sotto la riga ed è rientrato;
  - torna indietro fino alla prima riga del comando;
  - la sveglia non ha il ruolo di un tasto, non prende il fuoco ed è dentro il tasto della riga;
  - alla chiusura la vista e la riga tornano dov'erano, entro 1 px.
- Un fotogramma del video conferma il punto visivo: il log è sullo stesso fondo chiaro della chat, senza cornice
  da terminale.

## #262 · Un motore Topics fermato apriva ancora un turno

- `subagent-native-review6` («removing the Topics engine is no shutdown») era rosso sul Mac.
  - 1.3.8: 5 volte su 5, su main e sul ramo integrato.
  - Verde in CI.
- Sembrava un difetto della Bun 1.3.8, ma è una gara nel server.
  - La route della chat apre lo stream, aspetta memrecall (circa 35 ms, c'è solo dove è installato) e poi chiama
    `sendChat`.
  - Uno `stop()` caduto in quella finestra non trovava niente da interrompere, e il turno girava su un motore già
    tolto.
  - Sul Mac cade anche con la 1.4.2.
- Fix: `sendChat` su un motore fermato chiude subito il turno, con `cancelled` / `server-shutdown` e `notSent`.
- `stopped-engine.test.ts` rende esatta la finestra:
  - senza la guardia è rosso su 1.3.8 e 1.4.2;
  - con la guardia, 14/14 su entrambe insieme a review6.
- CI 20/20. Un job macOS non aveva trovato una macchina da GitHub ed è stato rilanciato.

## #263 · La piega che scattava (il flaky di `chat-accordion-no-shift`)

- Trovato da un'altra sessione, verificato qui leggendo i due commit, poi spinto e fuso.
- Lo scatto era vero. `fill: 'none'` all'apertura, e Chromium che a volte avvia l'animazione dopo il tempo del
  fotogramma successivo, mostravano per un fotogramma il corpo tutto aperto.
- Due difetti dello stesso gesto:
  - la riapertura ripartiva da 0fr;
  - il `cancel` toglieva il ritaglio all'animazione nuova.
- Misure di quella sessione:
  - su main, 8 rossi nei primi 47 test;
  - col fix, 210/210 in 10 giri;
  - le mutazioni sono rosse.
- CI 17/17.

## T19 · La coda del turno — accettata con un fix mio (fusa con #264)

- Diff letto: `admitFrame`, `closeAfterTail`, `reattachLive`, `exitTail`. Ogni strada d'errore della riadozione
  passa da `finalizeFailedReattach`, che azzera `rewindFrom`.
- Sul Mac, con T19 unito a main attuale (`6343052b5`):
  - 57/57 su 1.3.8 e 1.4.2 nei 6 file di riadozione, stream-lag e coda;
  - abort-drain 8/8 su entrambe;
  - B1 chiuso «done» in 11-15 ms con `1,2,3,final,` e onDone 1 volta;
  - B4 600 numeri, 0 ripetuti;
  - B4b 0 turni svegliati, cursore 266/266.
- Mutazione M1 rifatta qui su una copia (l'`exit` chiude subito): B1 e B2 rossi.
- **Trovato in verifica (verificatore indipendente, col demone vero).** Una riadozione rifiutata col figlio vivo
  (il turno adottato respinto per un rate limit) lasciava acceso `reattachLive`, il segno che manda il resync
  dopo al fondo dello store.
  - Il primo turno che perdeva l'attacco saltava così la propria coda, `result` compreso: «a1,a2,» invece di
    «a1,a2,a3,», e la riga restava appesa fino al watchdog.
  - Con lo stesso segno acceso, `closeAfterTail` non andava a prendere la coda di un turno uscito da staccati.
- **Due fix miei smontati dallo stesso verificatore**, ciascuno con un caso nuovo riprodotto su 1.3.8 e 1.4.2:
  - spendere il segno all'inizio del turno dopo (`49f06a451`): il turno rifiutato va avanti dopo il 529 come
    turno svegliato, che non passa da `sendChat`, e perdeva la coda lo stesso;
  - spenderlo al primo frame piegato (`191c956fa`): se il turno rifiutato tace nel retry dell'API mentre si
    perde l'attacco, nessun frame lo spende. La risposta va persa tutta, il suo `result` non arriva, e l'invio
    dopo resta fermo per sempre in `waitOutCliTurn`.
- **La causa, trovata dal verificatore:** il segno confondeva due cursori. Uno scan interrotto lascia il cursore
  dentro la storia, e lì saltare al fondo è giusto (B4b). Una riadozione rifiutata dopo lo scan lo lascia esatto.
- **Fix (`8c2d205eb`):** il segno lo mette solo lo scan, quando il suo attach fallisce, e lo spende il primo
  frame piegato dopo.
- **Trovato dal verificatore sullo stesso confine, già nell'albero di T19 prima dei fix.** Mentre il
  riavvolgimento della riadozione aspetta, i frame dal vivo si scartano perché il suo replay li ripeterà. Se il
  suo attach scade per il tetto dei 90 s (il socket resta su), il frame dopo veniva piegato oltre il cursore e il
  replay in ritardo finiva sotto: 37 numeri su 380 mai arrivati alla riga. Su main gli stessi frame uscivano
  doppi; T19 li aveva tolti nel caso normale e li perdeva in questo.
- **Fix (`671848ade`):** un riavvolgimento abbandonato lascia un debito (`rewindLost`). Un frame oltre il
  cursore aspetta quello che parte dal cursore: il replay in ritardo, il resync della sonda o la coda presa
  all'uscita.
- `claude-code-live-mark.test.ts` ha i quattro scenari del verificatore: il turno dopo, il turno svegliato, il
  turno muto nel retry, il riavvolgimento scaduto.
  - Senza fix: 0/4 su 1.3.8 e 1.4.2.
  - Ogni fix intermedio è rosso sul caso che l'ha smontato: il primo sul turno svegliato, il secondo sul turno
    muto (perde tutto, `""`), il terzo sul riavvolgimento scaduto (36-37 numeri persi).
  - Col fix: 24/24 insieme ai file di riadozione, stream-lag e coda, B4b compreso, su entrambe.
- **Riverifica sul fix finale: non smontato.** Il verificatore ha attaccato `rewindLost` sui frame che nessuno
  riconsegna, su un frame sotto il cursore che azzera il debito lasciando un buco, e sul `finally` del ramo
  `completed` su un percorso riuscito: niente perso, nessuna sessione bloccata.
  - Il suo p2drop ora dà `missing 0`, 379 numeri su 379, su 1.3.8 e 1.4.2.
  - Il ramo `completed` scaduto dopo aver scartato frame non perde niente, né col replay in ritardo (280 su 280)
    né con la sola sonda.
  - Restano rossi solo due casi fuori dall'affermazione, qui sotto.
- Lasciati aperti, come casi noti:
  - uno scan il cui ack scade mentre il suo replay è in viaggio ripiega la storia senza silenziatore. In chat si
    apre una riga svegliata con le risposte vecchie, e quel primo frame di storia spende anche il segno dello
    scan. C'è uguale su main e T19 l'aveva già lasciato aperto, quindi B4b vale per il riattacco, non per un
    replay in ritardo;
  - uno scan interrotto e poi l'attacco perso prima di qualunque frame: il resync dopo va dal vivo e salta anche
    un invio fatto nel frattempo («a3,»). Il verificatore lo trova raggiungibile solo se fallisce la prima
    connessione in assoluto e un invio arriva nei 4-8 s della sonda;
  - dopo un fallimento nel ramo `completed`, finché i frame restano trattenuti, il processo non sa se la CLI è in
    un risveglio suo: un invio in quella finestra può finire dentro quel turno e mescolare le righe (letto nel
    codice, nessun test; non una perdita). Farlo aspettare il debito rischiava un invio fermo per sempre;
  - uno Stop che arriva mentre `exitTail` è in volo non trova il turno da fermare (visto solo leggendo il
    codice, la finestra dura un giro col demone).

## #265 · Il cancello che cancellava le modifiche

- `check:deadcode-blindspots` rimetteva il contenuto letto all'inizio sopra ogni file: una modifica fatta durante
  la run spariva. T19 ci ha perso un fix.
- Ora un file cambiato tiene la modifica e perde solo la sonda.
- Prove:
  - 12/12 verdi;
  - col ripristino di prima, i due casi concorrenti sono rossi;
  - il cancello vero esce 0 e lascia l'albero identico.

## #267 · Il server di prod gira sulla Bun di `.bun-version`

- Prod eseguiva la prima `bun` del PATH (1.3.8), CI e test la 1.4.2: due difetti del quality pass venivano da lì
  (`columnNames` rovesciato oltre 62 colonne, `require` che ignora `with { type: "text" }`).
- Ora il server usa `~/.topics/bun/<versione>/bun`, installata solo se lo SHA-256 combacia con `SHASUMS256.txt`. La
  `bun` globale resta agli altri progetti.
- Prove:
  - `scripts/pinned-bun.test.ts` 7/7 su 1.3.8 e su 1.4.2, con gli script veri da una copia e una HOME finta;
  - quattro mutazioni su copia, ognuna rossa (checksum non confrontato, binario fissato ignorato, nessuna
    richiesta nel loop, `start-prod` che non chiede a `pinned-bun.sh`).
- Fusa in `e7a5e6e80`. In prod il processo del server è `~/.topics/bun/1.4.2/bun run server.ts` (letto con `ps`).

## #272 · Liste che caricano da sole e barra delle schede del browser della topic (staccata da #269)

- Nasce da #269: la fusione in cima sotto chi legge saltava con lo scorrimento animato di tastiera e Home, e a
  scheda nascosta. Liste e barra non ne dipendono, quindi sono uscite in una PR loro. #269 resta sulla sola chat.
- Liste (LIST-PAGE-01): colonna della board, storico notifiche, cronologia commit, sessioni da riprendere. La riga
  «mostra altri» carica da sola con 240 px di anticipo dentro il contenitore che scorre, una pagina per volta.
- Barra delle schede (TOPIC-BROWSER-01), finestra minimizzata 420 px, WebKit: 15 pagine da 17 px (titolo 0 px) a
  88 px (57 px); il «+» da 13 a 24 px. «Attento anche ai link dei browser dentro una topic» l'ho letto così.
- Quattro giri di revisione, ciascuno con un rosso sul bundle di prima e verde sul nuovo (COLVOL-04…07):
  - Done caricava l'archivio a catena (300 su 300) passando da griglia a lista;
  - a finestra alta, una colonna fuori schermo caricava senza che nessuno ci arrivasse;
  - da griglia a lista restava guardato il contenitore sbagliato (50 invece di 25);
  - dopo lista→griglia, il revisore della PR: Done caricava solo con la riga già a schermo (25 invece di 50).
- Prove: e2e WebKit 61/61 su 9 file, `loadOnReach.test.ts` 6/6 (3 rossi col controllore di prima), 17 `check:*`,
  unitari client 6866/6866. Il secondo revisore: non confutato, 32/32 sulle sue gare ripetute.
- Fusa in `569988bbb`, CI 17/17.
- Lasciati aperti: il ricontrollo del contenitore a ogni risposta dell'osservatore non lo fa mordere nessun test
  (resta come rete); per storico, notifiche e sessioni la «pagina per raggiungimento» oltre la seconda l'ha
  misurata il revisore a mano. A 390×844 Done torna da 50 a 25 card: c'era già prima.

## #269 · La chat che carica la storia da sola (T20 nel cloud, verificata qui)

- A sei schermate dalla cima della finestra caricata il resto della storia si chiede e si tiene da parte; si fonde
  solo a lista ferma (150 ms senza scorrimento, nessun tasto tenuto, scheda a schermo). La riga letta resta al pixel:
  la presa corregge in un ResizeObserver e tiene il bordo inferiore della riga.
- Tre giri di revisione e la CI: Pagina su, Shift+Spazio e Home facevano saltare la riga di migliaia di px; a scheda
  nascosta la fusione arrivava senza ancora; il «↓ N» contava le righe aggiunte in cima. Li ha corretti T20,
  misurando fotogramma per fotogramma le quattro cause nell'anteposizione di Virtuoso (`reports/T20.md`).
- Sul Mac, WebKit macOS: 8 spec della chat 35 su 35 dopo la fusione di main; `chat-infinite-scroll` tre volte 30 su
  30; la bozza di prima rossa 5 su 10. Il revisore indipendente: righe lette ferme a 0 px con Pagina su ripetuto ogni
  170-300 ms, una richiesta per corsa.
- Fusa in `244f6dbc0`. Il deploy deve installare le dipendenze del client (react-virtuoso 4.18.16).
- Lasciati aperti:
  - tornando a una scheda fusa da nascosta, chi leggeva a metà storia può rientrare 4 messaggi più in basso, 1 volta
    su 4: `placeRowAt` rinuncia quando Virtuoso non disegna più la riga. C'è uguale su main; il rimedio è tenere la
    riga col `rowHolder` anche al ritorno;
  - senza l'attesa del riposo WebKit macOS resta verde (la fusione ferma la planata del tasto, che si accorcia di
    ~90 px): manca un test sulla corsa del tasto. Su Chromium il test è rosso.

## #274 · T21, i test instabili (secondo giro)

- Una scrittura trattenuta del corpo di un turno scattava sul database già chiuso: `closeDatabase` ora esegue prima le
  scritture dovute (`onBeforeDatabaseClose`). Era anche una perdita vera allo spegnimento di prod.
- ⌘N poi B perdeva la B sotto carico: il fuoco entra nella palette nello stesso commit (`useLayoutEffect`).
- Sul Mac: il test del database chiuso rosso su main sulle due Bun, verde qui, rosso con la mutazione; ADD-05 100 su
  100 in 10 giri, 8 rossi su 10 col fuoco in `useEffect`.
- Trovato qui e corretto (`9979ab2fb`): `turn-write-cost` misurava il WAL di un altro file dopo uno che lascia il
  database aperto (0 byte, rosso anche su main).
- Fusa in `c5e10421b`. Lasciato aperto: `claude-code-live-mark.test.ts` rosso nella corsa unica della VM e verde da
  solo, un file precedente lascia qualcosa nel processo.

## #275 · La conversazione del task segue l'ultima risposta anche dopo il resize (Muse, verificata qui)

- Trovata verificando la #274: il test «floating composer» di `board-conversation-details` cadeva 8 volte su 20 su
  WebKit macOS, sempre a `1280-resized`. Allargando la finestra il drawer si stringe, il thread si ri-impagina più
  alto e WebKit sposta da solo `scrollTop` prima di ogni ResizeObserver: il follow si spegneva a 1024 px dal fondo e
  nessuno ripinnava più.
- Fix di Muse: uno scroll con l'altezza cresciuta e `scrollTop` non sceso è il layout, non chi legge; un
  ResizeObserver su thread e scroller ripinna mentre il follow è acceso e tiene aggiornati i campioni della guardia.
- Verifica mia, WebKit macOS: su main 8 rossi su 8; col fix 40 su 40 e la spec intera 12 su 12 tre volte; con la
  guardia spenta di nuovo 8 su 8 rossi. Una sonda scratch (risalgo, il thread cresce, torno in fondo con un solo
  scroll): il follow riparte 5 su 5 col fix; senza il ResizeObserver 1 volta su 5 resta a 94 px.
- Fusa in `3da93776a`, CI 17 su 17.
- Lasciato aperto: la ripinna del ResizeObserver su una crescita del thread non la fa mordere nessun test.

## #268 · Lo scan della riadozione oltre il tetto non ripiega più la storia in chat

- Sotto il carico di avvio lo scan della riadozione (il replay muto dello store da 0) può superare il tetto di 90 s
  con i byte ancora in arrivo. Il tetto rinunciava, la riadozione falliva («Riadozione del turno non riuscita», 60
  volte nel log di prod) e il replay, non più muto, si piegava come un turno risvegliato: in chat ricomparivano le
  risposte vecchie. È la famiglia B4b di T19, presente anche su main.
- Ora la risposta oltre il tetto si tiene da parte e si abbina per rid (`BridgeAckStalled.late`); `attachWhole` la
  prende come l'attach. Lo usano lo scan, i riavvolgimenti della riadozione, la coda d'uscita di una CLI e la sonda di
  boot che parcheggia.
- Undici revisori indipendenti, ognuno con un caso riprodotto e corretto: il `list` muto che buttava il socket sotto lo
  scan, lo Stop perso durante la coda d'uscita, la pausa del daemon prima del tetto, l'output del turno vecchio nella
  riga nuova (LT-WAKE, presa dalla CI), la risposta vecchia a un daemon senza rid, l'attach abbandonato al suo ultimo
  tentativo, la sonda del lag che riciclava il socket, il replay tardivo della sonda consegnato al processo che aveva
  preso il posto del suo.
- Il decimo ha confutato la correzione di quest'ultimo: con un daemon di protocollo 3 il successore restava sordo, exit
  compresa, e un kill con spawn partiti prima della resa lasciavano passare il replay vecchio (anche su main). Ora,
  dopo un `kill`, ogni frame di quell'id si scarta fino all'ack dello spawn successivo: il daemon risponde in ordine,
  quindi è tutto della vecchia incarnazione, e non serve il rid.
- L'undicesimo ha trovato un buco più vecchio, anche su main: un `kill` mandato a socket giù si rimanda dopo il
  riaggancio, e il rimando cancellava gli handler del successore registrato nel frattempo, che restava muto fino al
  watchdog dei 30 minuti. Ora il rimando li cancella solo se sono ancora del figlio ucciso.
- Prove sull'ultimo giro (`83de50057`): `respawn-killfail` rosso su main e sul giro prima, verde ora, di nuovo rosso
  senza la guardia; le cinque varianti di `respawn` (dopo la resa, prima, in volo, senza rid, kill fallito) verdi
  sulle due Bun; le sonde dei revisori col daemon vero, in ogni ordine: 0 righe vecchie e 3 sue al successore, exit
  consegnata; 27 file 178 su 178 su Bun 1.3.8 e 1.4.2; cancelli della CI verdi. L'undicesimo revisore: non confutato.
- Fusa in `4a42c5b13`, CI della PR 20 su 20.
- Lasciati aperti: con un daemon senza rid una richiesta muta al suo ultimo tentativo può ancora prendersi una
  risposta vecchia (come su main); nella stessa pausa del daemon, se la coda d'uscita di un'altra sessione si arrende,
  il socket se ne va e lo scan oltre il tetto fallisce (su main muore già al tetto); il rilevatore di stallo dei
  riattacchi headless (5 minuti) potrebbe interrompere uno scan più lungo, non misurato; con un daemon senza rid lo
  `spawned` di uno spawn vecchio chiude in anticipo la finestra del kill (il daemon di prod ha il protocollo 4); quattro
  casi letti e non sondati, tutti già su main, elencati nella PR.

## #270 · Il terminale «in corso» che non lavorava più

- Il terminale del sito Armonia restava «in corso» da ore. Il suo compito in background era finito, ma l'avviso di
  fine arrivato a turno aperto la CLI lo assorbe e lo nomina solo nei record di coda (`enqueue`, poi `remove`), che il
  parser non leggeva: l'85% degli avvisi (3192 su 3748 in 62 transcript).
- Ora il parser legge anche i record di coda, il Monitor si chiude solo con le parole della CLI, e un terminale
  riattaccato rilegge dal transcript gli avvisi scritti mentre il server era giù: le righe già bloccate si sbloccano
  al primo riavvio, senza toccare il DB a mano.
- Undici revisori indipendenti. Dal terzo in poi il punto era l'annuncio: ciò che è finito prima del riavvio guarisce
  muto (nessuna epoca, push o riga), ciò che finisce dal vivo si annuncia una volta come senza riavvio, in qualunque
  ordine arrivino hook, coda viva, lettura tardiva e ricomposizione di avvio. Ogni caso trovato ha il suo test, rosso
  sul giro prima sulle due Bun. Gli ultimi giri hanno chiuso tre modi in cui il compito tornava in mappa per sempre:
  la ricomposizione di avvio che dimenticava gli id finiti (anche per un terminale senza riga), l'avviso di fine senza
  chiamata, e la lettura tardiva di una storia lunga che scacciava dalla memoria le fini lette dal vivo (EVICT). E due
  modi in cui una guarigione si annunciava: la stessa fine letta tardi e poi dal vivo, e la riga di consegna letta
  dalla coda prima che la lettura tardiva arrivasse all'avviso. Ora le fini lette dal vivo mentre il riattacco legge
  lo aspettano: la mappa le prende nell'ordine del file.
- E la fase. L'`enqueue` dice solo che l'avviso è in coda: il compito resta in volo fino alla sua sorte, cioè la riga
  che lo consegna (e sveglia il turno, come su main), il `remove` con cui la coda lo lascia andare (assorbito o
  scartato), o un minuto dopo lo Stop senza nessuna delle due, mai mentre il turno gira (lo ricontrolla il reaper). Un
  turno parcheggiato in `watching` il cui ultimo compito esce così torna `awaiting-user`, datato allo Stop: prima
  restava «in corso» per sempre, anche senza riavvio. L'hook in ritardo che alza o rimette a riposo tiene anche lui la
  data dello Stop. I giri 16 e 17 chiudevano il compito all'`enqueue`, e un avviso accodato a turno aperto e
  consegnato dopo lo Stop (27 su 464) faceva lampeggiare `awaiting-user` o si annunciava due volte (su main una). Le
  soglie vengono da 200 transcript (CLI 2.1.284–2.1.295, solo conteggi): ogni assorbito ha il suo `remove` (364); a
  sessione ferma 437 consegnati (p99 4,1 s, 3 oltre il minuto) e 766 lasciati andare; 16 su circa 1800 senza sorte.
- Prove sull'ultimo giro (`1a850e8cb`): i tre file dei compiti 92 su 92, tre giri per Bun; 30 file 438 su 438 su
  Bun 1.3.8 e 1.4.2; 23 cancelli della CI verdi, CI della PR 20 su 20; 13 test rossi sul giro 17 e 4 sul 18 senza la
  data dell'hook in ritardo; 15 mutazioni su 17 rosse (le due vive contano solo per un terminale ri-registrato nello
  stesso processo con un avviso in coda); le sonde del revisore con le righe vere: HC, HB, HD, HE, PC, PF, PG ed
  EVICT chiusi, RB `watching → running`.
- L'undicesimo revisore sul diciottesimo: nessuna regressione su main. Tengono la lettura tardiva muta, l'hook in
  ritardo e i casi chiusi nei giri prima, tutti con le righe vere; il minuto scatta al giro del reaper, fra 60 e 90 s
  dopo lo Stop. Ha trovato due casi identici su main, qui sotto fra gli aperti.
- Fusa in `22badde40`, CI della PR 20 su 20.
- Lasciati aperti: un turno aperto a cavallo del riavvio che lancia un compito dopo e si interrompe con Esc non
  annuncia la fine di quel compito (`turnOpen` non si salva, così già su main); un secondo riavvio dentro la lettura
  tardiva (~94 ms su 166 MB) perde l'annuncio di un compito uscito dal vivo (`lastTurnLive` vive solo in memoria);
  oltre il tetto di 64 id finiti, un compito sotto l'id della chiamata torna in mappa se il suo `PostToolUse`
  attraversa il riavvio dopo altre 29 fini lette (`post-hook.sh` ha `--max-time 2`, `--retry 0`);
  una chat che riparte entro il minuto dopo lo Stop con un avviso senza sorte resta `watching` (la coda è in memoria);
  105 compiti di sub-agenti senza avviso di fine e 44 Agent `async_launched` non tracciati, già su main.
- Aperti e identici su main, trovati sul diciottesimo: una chat collegata al provider resta `watching` a 0 compiti
  («in corso») fino al turno dopo quando il `wake` esce senza turno di risveglio (603 avvisi lasciati andare a riposo
  nei 200 transcript; il turno dopo arriva dopo 376 s in mediana, 55 minuti al p90); uno Stop che arriva dopo che la
  coda ha letto la consegna annuncia due volte.

## Fusione e prod (09/10)

- Fuse su main oggi: #272 (`569988bbb`), #269 (`244f6dbc0`), #274 (`c5e10421b`), #275 (`3da93776a`), #268
  (`4a42c5b13`) e #270 (`22badde40`).
- Prod portata su `0a6877631` (v2.2.468) dopo la CI di main verde su `22badde40`.
  - Backup del DB fatto prima del cambio, integrity ok, 308 MB.
  - Il server si è ricaricato dal watcher alle 11:41, sulla Bun 1.4.2, e serve il bundle `index-CkcR_l9Q.js`. Nel log
    dopo lo start non ci sono errori.
  - La riga del terminale di sito Armonia, «in corso» dall'8/10, al riavvio è guarita muta: da `working` a
    `finished`, epoca 109 invariata, nessun compito in volo, nessuna notifica nuova (102 prima e dopo).

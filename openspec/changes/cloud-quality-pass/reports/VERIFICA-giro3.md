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

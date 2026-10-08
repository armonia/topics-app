# Verifica delle consegne cloud (sessione madre, Mac)

Ogni consegna: diff letto per intero, CI di GitHub sullo sha consegnato, numeri rimisurati sul Mac
(macchina diversa da quella che li ha scritti), un revisore indipendente sul fix più rischioso.
Le consegne arrivano come bundle stampato a pezzi (`cloud-bundle`, sha256 controllato) e sono
rimesse sulla base locale con `cloud-ricuci`; la firma SSH della VM cade, autore e date restano.

## T2b · Età della card — accettata dopo D2 (ramo `cloud/t2b-eta-card`, fusa senza PR propria)

- D1 chiuso come dichiarato: orologio al minuto unico per documento, la card ferma avanza.
- **D2, trovato da me in WebKit con React vero** (pagina col componente vero di T2b, `page.clock`): `UpdatedAgo`
  saltava in `memo` un `iso` nuovo che dava lo stesso testo, ma React tiene le props vecchie sul figlio
  abbonato all'orologio. Card aggiornata alle 10:00:00 e alle 10:00:30: alle 10:01 «1m fa» (giusto «ora»),
  poi sempre un minuto avanti. La causa era anche mia: la barra chiedeva i render per frame fermi a 103,3,
  e il confronto sul testo era il modo di tenerli. Rimandata con la barra corretta, correttezza prima.
- Fix `18a700642`: `memo` semplice, salta solo a `iso` uguale; render per frame 103,3 → 104,3 (l'etichetta
  che cambia). Stessa pagina WebKit sul componente corretto: **5 età giuste su 5** (prima 3 sbagliate). La
  sessione ha aggiunto il caso a `board-card-updated-ago.spec.ts`, rosso 2/2 con il confronto sul testo rimesso.
- Punto di contatto con T8: `Card` e `CardBody` hanno il `memo` standard, un `task:updated` porta un oggetto
  nuovo fino a `UpdatedAgo`, quindi D2 non può rinascere dal guscio di T8. Fusione `eb021f23e` (conflitto solo
  in `_comuni.md`, tenuta l'integrazione che lo contiene): typecheck client exit 0, eslint exit 0, test board
  609/609, e2e di T2b/V2 in WebKit sul bundle fuso 9/9 in tre giri
  (carico 7-9). Video: `t2bv/out-video/…/video.webm` (9, fra cui «a card updated twice within the same «ora»…»).

## T5 · Server, percorso caldo — accettata dopo due giri di correzioni (PR #246)

- Scheletro del filo (`/api/topics/:id/messages`, `/api/history`): golden rigenerato dal codice di
  PRIMA identico byte per byte a quello consegnato; risposte complete vecchio/nuovo su 10 richieste
  (3000 messaggi, un ramo, buste di contesto, partial) identiche a meno dell'ordine delle chiavi JSON
  e dell'id di avvio del processo. Mutazione su una copia (busta di contesto ignorata): test rosso.
- Numeri sul Mac (banco in-process, due corse alternate, load ~15): messages `limit=200` p95
  21,6 / 18,7 → 4,5 / 3,6 ms; history `limit=40` p95 12,0 / 10,5 → 8,1 / 6,2 ms.
- `spawnBounded`: il revisore ha smontato la prima versione (SIGKILL secco lasciava `index.lock` e
  worktree bloccati; scadenza spenta all'uscita del figlio diretto; figli orfani all'arresto; `cp -r`
  e push a 120 s). Il secondo giro di revisione ha trovato il cancello 2 di `worktree-slim` che
  leggeva un git scaduto come «niente di tracciato» (perdita di dati) e un blob troncato con
  Content-Length fisso. Tutto corretto da T5 in due giri; sul Mac (Bun 1.3.8) le riproduzioni del
  revisore ora passano, l'arresto con `gracefulShutdown` chiude i gruppi (col codice vecchio il
  figlio resta: il controllo morde), 2.857 test di `server/` verdi.

## T1 · Topic — accettata (PR #247)

- Una topic già visitata si apre dalla copia locale: test chiave in WebKit sul Mac rosso prima
  (71 frame di scheletro, tetto 30) e verde dopo; 4 test su 5 della spec verdi in WebKit.
- La scena d'evidenza (scroll a rotella fino al primo messaggio) va in timeout in WebKit prima E
  dopo, anche a 120 s: limite della spec in WebKit, non del fix.
- Costo dichiarato e confermato dalla revisione: una risposta con immagine arrivata mentre si era
  via può spostare la vista dopo l'apertura (CLS 0,034 contro 0,01). Rimedio vero: salvare le
  dimensioni dell'immagine col messaggio.

## T3 · Avvio e bundle — accettata solo la parte server (PR #249; #248 chiusa)

- Server: web-push, @xterm/headless, SDK Anthropic e manifest delle migration fuori dal boot.
  Boot del server di test sul Mac, avvii alternati: mediana 898 → 752 ms (−16%). 30 test verdi.
- Client (split del corpo chat dall'entry, react-markdown fuori dal percorso critico): rifiutato.
  In WebKit, primo frame con una chat aperta, mediane di 11 su due corse: freddo 324/315 → 542/557 ms
  (+70%), seconda apertura pari, terza +2/+7%. Col precaricamento dei chunk sempre attivo: ancora
  +19% a freddo. Il guadagno (entry −30%) è per chi apre senza chat, il caso raro.

## T2 · Task — accettata dopo la verifica indipendente V2, D1 in T2b (PR #250)

- Diff letto per intero, nessun difetto: l'unico consumatore di `byStatus` (la riga riassuntiva della
  sidebar) legge solo progetto e conteggi per stato, cioè la forma che il nuovo `useGlobalBoard`
  confronta; il resolver di `useTaskTopicIndex` non lo legge nessuno a render. Fusione e «archivia» sui
  sottotask ora chiudono le tab come la DELETE.
- CI 17/17 sullo sha consegnato. In WebKit sul Mac «la scheda mostra il titolo mentre il task si carica»
  è rosso sul bundle di prima e verde su quello di T2; il flusso Task completo passa in entrambi
  (video in `t2v/before` e `t2v/after`).
- Numeri dichiarati: click card → titolo 59,4 → 25,7 ms; render per `task:updated` 666 → 103.
  La rimisura su un'altra VM e la caccia ai campi che non si aggiornano le fa V2 (cloud, secondo account).

## T6 · Cancelli — accettata, con il prezzo in memoria scritto (PR #252)

- Mac, a freddo, due giri alternati: typecheck 43,7 / 44,3 → 17,6 / 16,0 s (−62%); lint 53,9 / 52,3 →
  31,1 / 30,1 s (−42%). Picco di RSS dell'albero di processi: typecheck 1,46 / 1,40 → 3,18 / 4,18 GB,
  lint 1,07 / 1,14 → 1,97 / 2,14 GB; insieme nella barra ~6 GB per ~30 s contro ~1,5. Gli slot di
  `slot.ts` tengono un solo typecheck e un solo lint per volta sulla macchina. Il Mac in quel momento:
  swap 11,5 / 12 GB, `memory_pressure` 48% libero.
- Il parallelo morde: un pezzo rosso fa uscire `parallel.ts` col suo codice e lo nomina; 36/36 test
  di T6 verdi sul Mac (Bun 1.3.8). Diff di `qa-gate.sh` letto: corsie su file propri, il cancello che
  scrive nei sorgenti gira da solo a corsie finite, una corsia interrotta è un rosso.

### T2, verifica indipendente V2 (cloud, secondo account, ramo `cloud/v2-verifica-t2`)

- 18 affermazioni: 14 confermate con misure e test propri su un'altra VM (card 60,3 / 59,4 → 24,6 /
  26,3 ms; render per frame 666,3 → 103,3 identici), 1 confermata con un difetto, 1 smentita nella
  forma (hash del REPORT di T2 inesistenti sul ramo), 2 non rimisurate (`check:growth`, ×40 del chip).
- Mutazioni sui test di T2: ognuno va rosso senza il suo fix (13→12, 1→0, 20→18, 10→9, 6→4, 6→5).
- **D1**: l'età «Nm fa» di una card ferma non avanza più (prima avanzava per caso, coi frame delle
  altre card). Test rosso sul dopo, verde sul prima. Fix in T2b: orologio condiviso letto dalla sola
  etichetta, test riscritto con i timer che scattano.

## T7 · Immagini in chat — accettata (PR #254)

- Diff letto intero (server `media-size.ts`, aggancio in history e `broadcastToAll`; client `mediaBox.ts`,
  `MediaImage`, pin a riposo in `MessageList`). Le dimensioni si leggono solo per file che `/uploads`
  (contenuto con `relative`) o l'allowlist di `/api/media` servirebbero; la validazione dei frame WS è
  `looseObject`, quindi nessun avviso. Il test di T1 è toccato solo nei commenti; il caso immagine ha un
  test suo con contratto ≤ 0,01.
- Bun 1.3.8 sul Mac: `media-size`, `mediaBox`, `media.test`, `tests/integration/history-*` 85/85;
  `no-type-mirrors` 4/4.
- WebKit sul Mac, immagine 900×500 coi byte trattenuti 2,5 s (misura nel DOM: WebKit non ha layout-shift):
  base **0×0 prima del load**, 576×320 dopo, vista lasciata **320 px sopra il fondo**; T7 **576×320 prima
  e dopo**, distanza dal fondo 0. Video: `t7v/wk-t7base/…/video.webm`, `t7v/wk-t7wt/…/video.webm`.
- CLS in Chromium (il config del repo lo vieta sul Mac, `playwright.config.ts:182`): CI dell'integrazione
  `5d4e4631e`, 17/17, le tre scene a **0,0000** (`chat-image-box:new`, `:media`, `topic-first-frame:away-image`).
- Limiti dichiarati da T7 e veri: immagine scritta a metà streaming, bolla ottimistica di chi allega,
  `/api/topics/:id/messages` senza `mediaSizes`; tocca file di rami aperti (`MessageContent`, `useChat`,
  `MessageList`).

## T9 · Loop del server — accettata (PR #255)

- Diff letto intero: vivezza dei pid senza `ps` sincrono (`/proc` su Linux; sul Mac un solo `ps` asincrono
  per giro e gli zombie ricordati per la domanda sincrona), un timer per tutte le righe riadottate,
  ahead/behind da `%(upstream:track)` invece di un `git rev-list` per ramo, `getconf` letto una volta.
  Restano sincroni solo i rami di Stop: uno zombie non ancora visto da un giro riceve un kill innocuo.
- Il test con `ps` reale del ramo gira solo su Linux. Sul Mac (Bun 1.3.8) l'ho provato a mano su uno
  zombie vero: un giro asincrono in 24 ms, poi `isPidAlive` lo dà morto. Test toccati 98/98; sulla
  fusione con T5 120/120.
- Misure sul Mac: un `ps` sincrono costa 1,5 ms (p50), quindi con 20 righe riadottate base ferma il loop
  ~31 ms ogni 3 s in 20 stalli, T9 0,5 ms una volta. Banco del loop di T9 adattato a macOS, carico 7-12
  (un'altra sessione faceva e2e): p99 0,82/0,82 → 0,73/0,58 ms. Il guadagno grosso qui è
  `GET /api/git/branches` (40 rami): **p50 644 → 21 ms**, JSON identico al byte in due giri; sul Mac
  ogni processo costa più che sulla VM, quindi il guadagno è più grande di quello dichiarato (−95%).
- CI di #255: rosso solo `git-env-nei-test` della base, come T7.

## T10 · Feed della board — respinta così com'è, fix in T10b (PR #253)

- **Sul Bun di produzione (1.3.8, il Mac) il feed è spazzatura.** `allWideRows` dà a `.values()` i nomi di
  `statement.columnNames`, che sulla 1.3.8 oltre 62 colonne esce al contrario (`c74…c0`); il feed ne ha 75.
  Nel feed vero `id` contiene la descrizione, `descriptionPreview` l'uuid, `status` è null.
- Prova: `server/services/tasks.test.ts` sulla 1.3.8, base 17a60e4c5 **185/185**, T10 **164/185**;
  `wide-rows.test.ts` rosso sulla 1.3.8. Il test di T10 morde: nessuno l'aveva girato sulla 1.3.8 (VM 1.4.2,
  CI `bun-version: latest`).
- Banco di T10 rigirato sul Mac: byte del feed **+25%** (259.143 → 325.101) invece di −10%, p50 −19% invece
  di −51%. Il +25% è la descrizione intera finita in `id`.
- Due runtime in produzione: server sul Mac 1.3.8, installer desktop compilati con la latest. T10b
  (`cloud/t10b-base`) corregge senza dipendere dall'ordine di `columnNames` e misura su entrambe.
- `sliceCodePoints` e `toFeedTask` verificati giusti sulla 1.3.8 (ascii 280, emoji 10).

## T8 · Drag della board — accettata (PR #256)

- Card divisa in guscio e `CardBody` memoizzato, misure di riposo (`settledRects`) tenute in copia e
  invalidate a ogni `scroll` (ascolto in cattura su `window`); una rimisura di dnd-kit è un oggetto
  nuovo, quindi la copia non può restituire una misura vecchia.
- Misure sul Mac, WebKit, banco `board-drag-renders` (seme, rotta e 3 passate di T8), base e T8
  alternati: render per mossa **59,4 / 58,7 → 26 / 26**, all'attivazione 986 → 292.
- Unit 32/32. Drag in WebKit 18/19: il rosso è `board-motion-contract.spec.ts:249` (il repo lo gira solo in
  Chromium) in timeout sotto carico 12-14, verde rilanciato da solo.
- Il contratto di movimento riscritto morde: col bundle di base va rosso su una transizione di reflow da
  236,8 ms, fuori dai token `[90, 150, 240, 400]`.
- Fusa nell'integrazione senza conflitti (`35ff514c5`), test client della board 600/600.

## T10b · Feed della board giusto sulla 1.3.8 — accettata, fusa con T10 (`7a27c7112`)

- Fix: i nomi delle colonne li dà chi scrive la SELECT (`listColumns` → `{ sql, names }`), `columnNames`
  serve solo come insieme (stesse colonne, qualsiasi ordine); nomi ignoti (`*`) o insieme diverso → `.all()`.
  Il secondo commit (`747c6a6`) riformatta per `check:bloat`, stesso codice (letto riga per riga).
- Sul Mac, Bun 1.3.8: `list` identico alla base **150/150** (lo stesso controllo dava T10 diverso);
  `tasks.test.ts` + `wide-rows` + `code-points` 193/193; sulla fusione 190/190, typecheck server 0.
- Banco di T10, base e T10b alternati, carico 5,5-6: p50 della rotta **4,53/4,63 → 2,14/2,17 ms (−53%)**,
  p95 6,35 → 2,6; byte **259.143 → 232.143 (−10,4%)**, 69 → 60 chiavi; `list` in-process 3,2 → 1,19 ms.
  Sulla VM la sessione: −52% sulla 1.3.8, −50% sulla 1.4.2, stessi byte.
- La mutazione (nomi da `columnNames`) è rossa anche sulla latest grazie al test che simula la 1.3.8.
- Trovato dalla sessione: sulla 1.3.8 l'import testuale delle migration incorporate dà il percorso (7
  rossi già sulla base); in produzione non scatta (server dai sorgenti, installer con la latest).

## T7b · Sipario e bolla di chi allega — accettata e fusa (`51fac9f57`, senza PR propria)

- Diff letto intero (codice `b4b0c4ed5`, `45cfed32c`). Il sipario salta solo le immagini marcate
  `data-media-box` (nel riquadro, senza byte); quelle senza riquadro restano aspettate. La bolla di chi
  allega prende le dimensioni dal file nel composer (`<img>` su object URL, revocato; tetto 500 ms, la
  lettura parte insieme all'upload). Controllati i tre punti a rischio: `sameOptions` confronta solo
  fastMode/provider/model, quindi le dimensioni non spezzano i batch della coda; la richiesta al server
  prende solo quei tre campi, le dimensioni restano nel client; server (`jpegOrientation`, 5-8 scambia
  i lati) e browser ruotano entrambi per EXIF, quindi il riquadro e la foto coincidono.
- WebKit sul Mac, stesse spec del ramo, bundle base (`82467072d`) e T7b (`44b640533`) via
  `TOPICS_E2E_BUNDLE_DIR`, 4 giri alternati, carico 6-8:
  B1 sipario alzato dopo **1251-1277 ms (72-76 frame, il tetto) → 253-275 ms (15 frame)**, prima del
  rilascio dei byte 380 → 1380 ms; B2 immagine della bolla prima dei byte **0 → 320 px**. La base va
  rossa ogni volta sulle due asserzioni giuste («the curtain waited for its hard cap», «the picture held
  its box»), T7b verde 4/4. CLS in WebKit non si legge (niente layout-shift): conta l'altezza.
- Video: `t7bv/out-{base,t7b}-video/…/video.webm` (le due scene per lato).
- Barra della sessione su `b257c68`: qa-gate exit 0, shard exit 0 (0 rossi), bundle +520 B gz nel budget,
  e2e d'area Chromium 270 verdi, 0 rossi, 1 flaky uguale alla base. `b257c68` cambia solo la forma di due
  tipi (un falso positivo di `check:ui-language`, che legge `Array<…>` in un .tsx come JSX).
- Limite 2 del REPORT (densità dell'immagine diversa dai pixel): misurato in WebKit e in Chromium headless,
  PNG `pHYs` 144 dpi, JPEG JFIF 144 dpi e uno screenshot Retina vero danno dimensione naturale = pixel
  (400×200). Resta solo il JPEG con densità EXIF esplicita, raro.
- Fusione senza conflitti: typecheck client exit 0, eslint exit 0, `check:ui-language` exit 0, test di
  `Chat/` e `state/` 2164/2164.

## T11 · Test instabili ricorrenti — accettata e fusa (`fa68e2df2`)

- Sei test rossi «sotto carico» in almeno due REPORT. Carico scritto e uguale prima e dopo (4 `yes`), N ≥ 30
  unit e ≥ 20 e2e, `--retries=0`. Riprodotti due: `board-card-choices` **1/20 → 0/20** (il reconcile del
  dispatcher, ogni 10 s, ri-accodava la card finta fra l'apertura del menu e il click: ora è tenuto fermo per
  la scena, con lo stesso helper di `board-card-stop`); `chat-streaming-indicator` **2/20 → 0/20** (i frame di
  stato partivano senza attendersi e un `false` vecchio arrivava dopo il `true`: ora escono in fila).
  Gli altri quattro 0/30 e 0/60 anche con il contesto dello shard e con gli shard come carico: non toccati.
- Diff letto: solo due spec, nessun `retries`, `skip`, `sleep` o timeout alzato. Barra comune: stessi rossi
  della base (RECAPTURE-01, d'ambiente della VM), nessun rosso nuovo.

## V3 · Verifica indipendente dell'integrazione — consegnata (`f035809c3`), D1 e D2 in T12

- B2, un numero per traccia rimisurato su base `main` e testa alternate: **tutti confermati** (T3 solo in
  piccolo, avvio −4% invece di −14%).
- **D1 (media)**: sulla Bun 1.3.8 il `require` pigro del manifest delle migration (T3, `server/db.ts:248`) dà i
  percorsi invece della SQL; in produzione non scatta (server dai sorgenti, sidecar compilato giusto anche con
  la 1.3.8: provato), ma la suite unit sulla 1.3.8 diventa rossa secondo l'ordine dei file (13 rossi, 0 su main).
- **D2 (bassa)**: un ospite riceve in `message:new` le dimensioni di file che non può scaricare (T7,
  `withFrameMediaSizes` prima del filtro per socket).
- Sospetto non dimostrato: `chat-accordion-no-shift` «tool-result-clamp» 2/27 sulla testa, 0/27 su main.
- B3 (chat, processi, board, avvio, ospiti): nessun altro difetto. Correzioni lanciate in T12.
- Testa nuova `7a27c71` (con T8, T2b, T7b, T10 + T10b): qa-gate exit 0, shard e e2e d'area senza rossi nuovi
  (gli unici sono anche sulla base). Numeri: T8 render per mossa 61,4 → 28,8 (attivazione 986 → 292), T7b CLS
  della bolla 0,0488 → 0, T2b rosso → verde: confermati. Sulla 1.3.8 D1 rompe 15 test del server; i 21 rossi di
  T10 non ci sono più (T10b regge). I 19 campi tolti dal feed: nessun lettore nel client.

## T12 — accettata (D1 e D2 di V3)

- Diff letto per intero. D1: il manifest porta l'SQL come stringhe base64 (una riga per migration, `merge=union`
  regge), il `require` pigro di T3 resta. D2: `broadcastToAll` manda all'ospite il frame senza `mediaSizes`,
  payload costruito una volta per fan-out e solo se un ospite c'è. Le altre vie verso un ospite non portano
  dimensioni: `withMediaSizes` sta solo in `/api/history` (fuori da `isGuestAllowedPath`) e nel fan-out.
- Mac, Bun 1.3.8 di produzione, prima `d47732eb9` / dopo `cf28ad254`, stesso ordine:
  test D1 0/1 → 1/1 (`applied 184, notSql 0`); test D2 0/1 → 1/1 (ospite `undefined`, proprietario
  `{"/uploads/owner-private.png":[1234,567]}`); i sette file elencati da V3 in un solo processo 36 pass /
  18 fail → 58/58. Le 184 voci decodificate sono identiche ai `.sql`; il generatore rilanciato non cambia niente.
- Smoke del sidecar compilato su macOS arm64 con la 1.3.8: exit 0, «using 184 embedded migration(s)».
- `task-automerge` rigenera il manifest dopo un merge che tocca le migration (`server/services/task-automerge.ts:562`):
  un ramo aperto col vecchio formato si ripara da sé.
- S (`chat-accordion-no-shift`): 0/40 testa, 0/40 main sotto carico, non dimostrato. Lasciati aperti da T12:
  `live-phase-gate.test.ts:283` rosso solo sulla 1.3.8 dentro gli shard (anche prima di T12), uno shard appeso
  sulla 1.3.8 senza causa.

## T14 — accettata (l'unico rilievo della review indipendente)

- Diff letto per intero: sette file passano a `runBounded`, un commit per file; stdio invariati (i default di
  `spawnBounded` sono stdout `pipe` e stderr `ignore`, come le opzioni tolte), argv, env, scadenze e sentinelle
  identici. `runBounded` ora rende il valore di `exited` (137 per un segnale da fuori, che i runner già davano)
  e `spawnError`. Il deploy confermato dà lo stesso testo al mancato avvio.
- Trovato da T14 e non nel brief: con `proc.exitCode` un segnale esterno diventava null, quindi 124 o 1; in
  `branch-status` 1 è un verdetto («non antenato»). Fissato nella tabella dei contratti.
- Mac, Bun 1.3.8: test dei contratti sul codice di prima (`53f53e1`) 77/77, sulla testa 78/78; test dei moduli
  toccati 165/165. Mutazioni di T14: 4, tutte rosse.

## Integrazione (`cloud/quality-pass-integrata`, PR #251)

- T1 + T5 (con il fix `gitEnv` del suo test) + T3 server + T2 fuse senza conflitti, CI 17/17.
- T6 fusa dopo: un conflitto in `processes.shell-sweep.test.ts`, dove T5 e T6 avevano corretto lo stesso
  `isAlive` contro gli zombie. Tenuta la versione di T5 (`ps -o stat=`, vale anche su macOS; quella di
  T6 legge `/proc`, che sul Mac non c'è), tolto l'import rimasto senza uso. Test 5/5, eslint exit 0.
- CI di `e9da968`: 15/17, rosso `bounded-spawn.test.ts:218` (figlio di `spawnBounded` sopravvissuto
  all'arresto). Era una corsa della fixture di T5, non del codice: stampava il pid e solo dopo
  installava l'handler di SIGTERM, e il test manda SIGTERM appena legge il pid. Provato sul Mac
  (Bun 1.3.8): 300 ms tra stampa e handler → rosso come in CI; handler prima, stessa finestra → verde.
  Fix `f61198099`, 19/19 tre volte. In produzione l'handler è installato all'avvio del server.
- T7 (`e3f423c48`) e T9 (`5d4e4631e`) fuse, CI 17/17. T8 fusa in `35ff514c5`.
- T2b fusa in `eb021f23e`: CI 17/17. T7b fusa in `51fac9f57`.
- T10 + T10b fuse in `7a27c7112`. T11 (test instabili) lanciata su main, base `9f86fa60a`.
- T11 fusa in `fa68e2df2`. T12 (D1, D2 e il sospetto di V3) lanciata sul secondo account, base `d47732eb9`.
- T12 fusa in `f679feb7f`.
- Unit del server sul Mac, Bun 1.3.8, testa `f679feb7f` (`test:unit:shards`): exit 1 in 503 s, nessuno shard
  appeso, `live-phase-gate` verde (i due residui di T12 sono della 1.3.8 su Linux). 13 rossi: 11 del ponte PTY
  per i `node_modules` di scarto senza bit +x su `spawn-helper` (rimesso con `scripts/fix-node-pty-exec-bit.ts`),
  1 vero e 1 sua conseguenza: il nome utente del Mac in un commento di `server/lib/claude-session-tracker.test.ts`
  (repo pubblico; su main dal `652ec68d1` del 04/10, la CI non lo vede). Corretto in `7a10aad77`; i 5 file
  rilanciati sulla 1.3.8: 50/50.
- Main con #244 fusa in `448e4ea9d`: un conflitto di import in `ChatPane.tsx`, tenuti tutti e due; typecheck
  client, server ed e2e exit 0.
- S non è dell'integrazione: nei log CI `chat-accordion-no-shift.spec.ts:479` cade al primo tentativo in 8 corse
  su 13 basate su main (anche su main stesso) e in 3 su 7 dell'integrazione, sempre alla riga 507 (la chat in
  fondo non sta ferma 15 frame entro 30 s), verde al retry. In CI ogni shard e2e ha un worker e un DB: il
  contesto che T12 non aveva rifatto. T13 lanciata sul secondo account, base `cloud/t13-base` (`6c6cb5b46`).
- Review indipendente (`claude ultrareview`, terza e ultima corsa gratis) sul solo codice di produzione di
  #251 (94 file, 3.147 righe; la PR intera, 215 file e 14.732 righe, è oltre il limite): 6 rilievi trovati,
  4 smentiti dai suoi verificatori, 1 confermato di grado «nit»: `runBounded` (`server/lib/bounded-spawn.ts:283`)
  non lo usa nessuno in produzione e sette wrapper di git rifanno la sequenza a mano. Nessun chiamante
  confonde le sentinelle (124/128/1, scelte apposta e commentate): duplicazione, non un bug. T14 lanciata
  sull'account principale per adottarlo a contratto identico, base `cloud/t14-base` (`d99bc037f`).
- CI di `7a10aad77` (con main): 15/17, rosse due guardie di T5 per codice arrivato con main, che la CI di main
  non vede perché lì le guardie non ci sono: `server/lib/native-parity.ts:156` (`Bun.spawn` di `memrecall` con un
  timer a mano) e due chiamate sincrone fuori elenco (`native-parity.ts:114` `git rev-parse`, una volta per turno
  nativo; `server/pty-bridge-platform.mjs:27` `launchctl managername`, nei processi dei ponti). Fix `035c07fdc`:
  `runBounded` per `memrecall` (stessi 3 s, gruppo intero, grazia 500 ms), le altre due nell'elenco col motivo
  (la prima come debito noto, accanto a quello di `auth.ts`). Sul Mac con la 1.3.8: 59/59, typecheck del server 0
  errori, `lint:server` exit 0. Avvisate T13 e T14 di contarle come rosse della base.
- CI di `035c07fdc`: 17/17. T14 fusa in `35462d916`.

## Una Bun sola e il sidecar avviato in CI (sessione madre)

- `.bun-version` 1.4.2 per tutti i workflow (`bun-version-file`), per le release (il sidecar si compila con
  quella) e per il Mac di produzione (`093068f60`); `CONTRIBUTING.md` dice come cambiarla. Il motivo: il feed
  di T10 e D1 di V3 erano difetti della sola 1.3.8, che la CI con `latest` non poteva vedere.
- Prima nessuno avviava il server compilato prima della release: la CI fa solo stub dei binari per `cargo
  check`. Nuovo `sidecar-smoke.yml` (`a61404317`): a ogni modifica del server compila e avvia il sidecar su
  macOS, Windows e Linux. Lo smoke ora è un cancello (200 su `/api/topics`, 503 sulle sessioni terminale, riga
  delle migrazioni, nessun bridge PTY toccato); copia mutata (503 atteso → 418): exit 1.
- Primo giro: Windows rosso con exit 143 DOPO «[smoke] OK». Su Windows `kill` è TerminateProcess, `wait` dà 143
  e sotto `set -e` diventava l'uscita dello smoke; riprodotto sul Mac con `sleep`. Fix `0475d442d`: 3/3 verdi.

## T16 · Turno nativo senza spawn sincroni — accettata, con un fix mio (fusa in `f58733660`)

- Diff letto per intero. Portachiavi: `currentCredentials` asincrona con `runBounded` (stesso comando, 5 s),
  candidati e ordine invariati, nessuna cache nuova; la corsa nuova (un rinnovo arrivato mentre un turno
  aspetta `security`) chiusa e provata. `hasCredentials` chiede prima i file: stessa risposta, perché
  `pickCredentials` dà `null` solo senza candidati.
- **Portachiavi vero sul Mac** (solo booleani e tempi, token fresco quindi nessun rinnovo), base `7bf28d9cb` e
  T16 alternate, 12 letture per giro: loop fermo per `getAccessToken` **23 / 27,7 → 1,2 / 1,1 ms** (mediane),
  token letto ogni volta; `hasCredentials` **24,6 / 27,8 → 0,02 ms** (qui il file di jcode basta). Il dubbio del
  REPORT (`security` da un gruppo di processi suo) è smentito: legge uguale.
- Test di T16 sulla 1.3.8: 498/498. Restano sincroni, detti e motivati: `hasCredentials` su un Mac col solo
  Portachiavi (1 `security` per chiamata, almeno 2 per turno), il piano nello snapshot, la scrittura di un rinnovo.
- **Trovato in verifica**: il giro in background di `claudeMemoryDir` leggeva una scadenza di git come «non è un
  repo» e per 10 s dava la memoria della sottocartella, contro il suo stesso commento. Fix: senza risposta resta
  l'ultima. Test con `HEAD` sostituito da una FIFO (git si blocca mentre cerca il repo): rosso senza il fix su
  1.4.2 e 1.3.8 (cartella `-sub`), verde con. `server/lib` + `providers/native` sul Mac: 3.316 pass, 0 fail.
- Visto per caso: su Bun 1.3.8 **e 1.4.2** `Bun.spawn` senza `env` dà al figlio l'ambiente di avvio, non un
  `process.env` cambiato dopo (con `env: process.env` lo vede). Il REPORT lo dava come difetto della sola 1.3.8.

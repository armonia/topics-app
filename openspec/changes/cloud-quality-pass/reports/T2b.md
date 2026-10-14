# REPORT T2b · L'età di una card avanza da sola

Ramo: `cloud/t2b-eta-card`, partito da `origin/cloud/t2b-base` (`c457936`). VM cloud: Ubuntu, 4 vCPU,
16 GB. «Prima» = il bundle di `cloud/t2b-base`, «dopo» = quello di questo ramo; per le misure lo
stesso checkout di test, cambia solo il bundle (`TOPICS_E2E_BUNDLE_DIR`).

**In sintesi.** Il difetto D1 di V2 è chiuso: l'etichetta d'età della card legge un orologio
condiviso, un solo timer per documento al cambio di minuto, e avanza da sola su una board quieta
come su una board che riceve frame. Il test di V2 è riscritto per il comportamento giusto (tre
minuti CON i timer): rosso 2/2 prima, verde 2/2 dopo, rosso 2/2 con l'abbonamento tolto. Gli hash
del REPORT di T2 ora esistono sul ramo.

**Difetto D2, trovato dal coordinatore dopo la prima consegna e corretto.** Il primo fix teneva i
render per frame a 103,3 con un confronto sul TESTO in `memo`; quel confronto lasciava sul
componente l'`iso` vecchio quando un aggiornamento nuovo dava lo stesso testo («ora» → «ora»), e
allo scatto dopo l'età contava dal vecchio aggiornamento, un minuto avanti per sempre. Ora `memo`
semplice. Un terzo caso nella spec lo riproduce con l'app vera: rosso sul primo fix, verde dopo,
rosso col confronto rimesso. Prezzo: un render in più per frame `task:updated`, 103,3 → 104,3.
Il 103,3 «invariato» del brief era un vincolo sbagliato (lo dice il coordinatore): correttezza prima
dei render.

## Numeri della traccia

| Numero | Comando | Prima (`cloud/t2b-base`) | Dopo | Target |
|---|---|---|---|---|
| età della card ferma | `board-card-updated-ago.spec.ts` (riscritta) | exit 1, 2/2 rossi, riceve «ora» | exit 0, 2/2 verdi; mutazione (abbonamento tolto) exit 1, 2/2 rossi | **raggiunto** |
| età dopo due aggiornamenti nello stesso «ora» (D2) | stessa spec, terzo caso | sul primo fix (`55b7deb`): exit 1, riceve «1m fa», atteso «0m fa» | exit 0; ripetuto ×4 verde 4/4; mutazione (confronto sul testo rimesso) ×2 rosso 2/2 | **raggiunto** |
| render per frame `task:updated` | `board-update-renders.spec.ts` | 103,3 / 103,3 (layout 9,3, pane 94, commit 2,2) | 104,3 / 104,3 (layout 9,3, pane 95, commit 2,2) | +1 per frame, accettato (vedi sotto); il target «invariato (103,3)» era sbagliato |
| crescita in sessione lunga | `bun run check:growth` | exit 0 / 0: heap ×1,356 / ×1,367, DOM ×1,14 / ×1,14, listener ×1,059 / ×1,067 | exit 0 / 0: heap ×1,367 / ×1,364, DOM ×1,14 / ×1,14, listener ×1,059 / ×1,067 | **nessun peggioramento** (vedi nota) |
| area | `E2E_TIER=pr npx playwright test --project=chromium tests/e2e/board-*.spec.ts` | exit 1: 194 passati, 2 rossi (D1, RECAPTURE-01), 2 saltati, 0 flaky | exit 1: 196 passati, 1 rosso (RECAPTURE-01, preesistente), 2 saltati, 0 flaky | verde salvo RECAPTURE-01, rosso già prima, in T2 e in V2 |

Corse alternate prima/dopo/prima/dopo, stesso checkout, cambia solo il bundle. Prima tornata, col
primo fix (confronto sul testo, quello di D2):

| Corsa | Bundle | load 1 min | render per frame | | Corsa | Bundle | load 1 min | `check:growth` |
|---|---|---|---|---|---|---|---|---|
| 1 | prima | 0,86 | 103,3 | | 1 | prima | 0,93 | exit 0, 141 s |
| 2 | dopo | 0,73 | 103,3 | | 2 | dopo | 2,19 | exit 0, 143 s |
| 3 | prima | 1,17 | 103,3 | | 3 | prima | 4,01 | exit 0, 142 s |
| 4 | dopo | 1,13 | 103,3 | | 4 | dopo | 2,62 | exit 0, 134 s |

Seconda tornata, col fix di D2 (`memo` semplice), stessa VM, bundle di partenza alternato:

| Corsa | Bundle | load 1/5/15 min | render per frame | layout | pane | commit per frame |
|---|---|---|---|---|---|---|
| 1 | prima | 1,03 0,77 0,73 | 103,3 | 9,3 | 94 | 2,2 |
| 2 | dopo (D2) | 0,94 0,77 0,73 | 104,3 | 9,3 | 95 | 2,2 |
| 3 | prima | 0,80 0,74 0,72 | 103,3 | 9,3 | 94 | 2,2 |
| 4 | dopo (D2) | 0,76 0,74 0,72 | 104,3 | 9,3 | 95 | 2,2 |

Il render in più è l'etichetta della card che cambia: il frame le porta un `updatedAt` nuovo e lei
deve ridisegnarsi, anche se il testo resta «ora», perché è il componente che lo scatto dopo rileggerà.
Il primo fix lo saltava confrontando il testo, ed era D2. Una misura intermedia del primo giro,
`memo` con un confronto scritto a mano solo su `prev.iso === next.iso`, dava 105,3: un `memo` con
funzione di confronto crea un fiber guscio in più che il banco conta; `memo` semplice no (104,3).

Nota su `check:growth`: il suo banco (`long-session-growth.spec.ts`) gira su chat, tab e messaggi e
non apre la board, quindi l'orologio lì non si arma mai: il numero dice «nessun peggioramento», non
«il timer si spegne». Che il timer si spenga con l'ultima etichetta lo prova
`minuteClock.test.ts` («one timer for any number of listeners, gone with the last one»), che morde.
Non rimisurato dopo D2: il fix cambia solo il `memo` dell'etichetta, che quel banco non monta.

Le misure col worktree sono girate con `E2E_PORT=13344` (le corse 1-4 dei render su 13334, mentre
la barra era negli shard): il worktree prendeva anch'esso la 13334 e la barra ne aveva bisogno.
Stesso `global-setup`, server di test isolato, porta diversa; niente punta a :3333. I numeri dei
render sono conteggi, non tempi: il carico non li sposta.

## Barra

| Pezzo | Prima (`cloud/t2b-base`) | Primo fix (`7679bcc`) | Finale, dopo D2 (`18a7006`) |
|---|---|---|---|
| `./scripts/qa-gate.sh --veloce` | exit 1 · unico rosso `check:security` (home `/root`, d'ambiente) · 269 s | exit 1 · stesso unico rosso · 62 s | exit 1 · stesso unico rosso · 49 s |
| `bun run test:unit:shards` | exit 1 · 14 rossi: i 13 di T2/V2 più `subagent-native-engine.test.ts` (unnamed) · 1.831 file · 704 s | exit 1 · 13 rossi, gli stessi 13 di T2/V2 · 1.832 file (+`minuteClock.test.ts`, verde) · 690 s | exit 1 · 14 rossi: i 13 più `terminal-revive-race.test.ts` · 1.832 file · 688 s |
| `bun run build:client && bun run check:bundle` | exit 0 / exit 0 · eager gz 532.586 B | exit 0 / exit 0 · eager gz 532.578 B (raw identico: il codice nuovo sta nel chunk della board) | exit 0 / exit 0 · eager gz 532.584 B |
| `E2E_TIER=pr npx playwright test --project=chromium tests/e2e/board-*.spec.ts` | exit 1 · 194 passati, 2 rossi, 2 saltati, 0 flaky · 882 s | exit 1 · 196 passati, 1 rosso, 2 saltati, 0 flaky · 814 s | exit 1 · 196 passati, 1 rosso, 1 flaky, 2 saltati · 894 s |

I 13 rossi comuni degli shard sono d'ambiente e preesistenti (`reload-gate-migration` A e F,
`worktree-manager`, `loopback-probe`, `file-tree`, `installed-app-home-isolation` ×2,
`leak-ws-registries`, `topic-read-seen-propagation`, `system-notices`, `processes.shell-sweep`,
`check-security`, `no-home-paths-tracked`). `subagent-native-engine` è rosso nella barra di
partenza e verde in quella finale, senza codice server toccato: intermittente, non mio. Nell'area
e2e il rosso che resta è RECAPTURE-01 (`board-recapture-preview.spec.ts`: l'anteprima non compare
in 90 s), lo stesso di T2 e V2; i passati salgono di 2 perché la spec dell'età ora ha due casi ed
è verde (tre nella barra finale, tutti verdi).

Barra finale, i due intermittenti nuovi, entrambi provati da soli: `terminal-revive-race.test.ts`
(rosso negli shard) da solo 3/3 verde (`bun test`, exit 0 tre volte), e il ramo non tocca file
server né di integrazione dalla base (`git diff --name-only c457936 HEAD -- server
tests/integration` vuoto). `board-card-choices.spec.ts` «quattro stati, quattro decisioni» (flaky:
rosso al primo tentativo per «element is not stable / detached from the DOM» sul menu delle
scelte, verde al secondo): da solo ×5 verde 5/5 col bundle finale e 5/5 col bundle di partenza
(load 1,18 e 1,23). Sono rossi da carico della corsa intera, non del fix. Typecheck e lint verdi dentro `qa-gate` e dopo il fix (`bun run typecheck` exit 0,
`bun run lint` exit 0, 3 avvisi preesistenti in file non toccati); `check:comment-language`,
`check:identifier-language`, `check:emdash`, `check:deadcode` verdi.

## Fatto

1. **`test(board)`: l'età della card ferma deve avanzare col tempo, con e senza frame** (`e3f8ab0`).
   `tests/e2e/board-card-updated-ago.spec.ts` riscritta: `page.clock.install` prima del
   caricamento, poi tre minuti con `fastForward` (i timer della pagina scattano). Due casi: board
   senza alcun frame; board dove l'altra card riceve un frame dopo ogni minuto. In entrambi la card
   ferma deve dire «3m fa». Prova: col bundle di partenza exit 1, 2/2 rossi, riceve «ora».
   (La spec di V2 spostava l'ora con `setSystemTime`, senza timer, e contava sul frame dell'altra
   card: descriveva il rinfresco casuale di prima di T2, non il comportamento giusto.)

2. **`fix(board)`: l'età della card avanza da sola, con un orologio al minuto per documento**
   (`55b7deb`).
   - `client/src/lib/minuteClock.ts`: un timer per documento, armato al prossimo minuto di
     orologio; parte col primo ascoltatore, si ferma con l'ultimo (e toglie il suo
     `visibilitychange`); a finestra nascosta non ha timer, al ritorno visibile batte subito e
     si riallinea al minuto. Lo snapshot è il numero di tick, non l'ora: iscriversi non lo cambia,
     così una board che monta sessanta etichette non le disegna due volte (con `Date.now()` come
     snapshot ogni etichetta vedrebbe un valore nuovo dopo l'iscrizione).
   - `client/src/components/Board/UpdatedAgo.tsx`: l'etichetta è un componente piccolo con
     `useSyncExternalStore`; un tick ridisegna solo il testo, non la card. Il testo si calcola
     dall'ora vera come prima (`fmtUpdatedAt`, formato invariato). È `memo` con un confronto sul
     testo: un frame che cambia `updatedAt` ma lascia l'età uguale («ora» → «ora») non la
     ridisegna. Era sbagliato: vedi D2 e il punto 5.
   - `Card.tsx`: una riga, `fmtUpdatedAt(task.updatedAt)` → `<UpdatedAgo iso={task.updatedAt} />`
     dentro lo stesso `<span>` col suo `title`.
   - **Sostituito al punto 5**: il confronto sul testo in `memo` è il difetto D2.
   - Prova: spec del punto 1 exit 0, 2/2 verdi. Mutazione (abbonamento sostituito da una
     sottoscrizione vuota, bundle ricostruito, poi `git checkout --`): exit 1, 2/2 rossi, «ora».
     `client/src/lib/minuteClock.test.ts` 5/5 (primo ascoltatore arma al minuto, un timer per
     N ascoltatori e via con l'ultimo, l'iscrizione non cambia lo snapshot, dorme nascosto e batte
     al ritorno, un ascoltatore che esce dentro il tick non tiene acceso il timer). Morde: senza il
     `disarm()` dell'ultimo ascoltatore 4/5 (rosso «gone with the last one»); col ritorno visibile
     che riarma senza battere 4/5 (rosso «hidden it sleeps»).

3. **`docs(cloud-quality-pass)`: gli hash del REPORT di T2 puntano ai commit del ramo**
   (`11e7aef`). I 17 hash sostituiti con la mappa del «Trovato e non fatto» 1 di V2, ricontrollata
   (soggetto del commit uguale, `git cat-file -t` → `commit` per tutti). La ricetta dei video ora
   parte da `866fa37`, con una riga che dice che `93f01a9` era lo snapshot della VM di T2.

### Dopo la prima consegna: difetto D2

**D2 · L'età conta dal penultimo aggiornamento.** Trovato dal coordinatore e confermato in WebKit
con React vero (pagina con `createRoot`, `<UpdatedAgo iso={iso}/>` in un componente con `useState`,
`page.clock`): card aggiornata alle 10:00:00 e di nuovo alle 10:00:30, alle 10:01 dice «1m fa»
(giusto «ora»), alle 10:02 «2m fa» (giusto «1m fa»), e resta avanti di un minuto finché il testo
non cambia per altro. Perché: quando il confronto di `memo` dice «uguale», React non rende il
componente e gli lascia le props VECCHIE; l'abbonamento all'orologio vive proprio lì, quindi lo
scatto rende con l'`iso` vecchio. Un confronto in `memo` che guarda l'OUTPUT invece delle props è
corretto solo se nessun altro fa rendere il componente; qui lo fa l'orologio. Errore mio nel primo
fix: l'ho scelto per tenere il 103,3 della barra e non ho provato il caso «due aggiornamenti nello
stesso ora».

4. **`test(board)`: due aggiornamenti nello stesso «ora», poi lo scatto: l'età conta dal secondo**
   (`7278414`). Terzo caso di `board-card-updated-ago.spec.ts`, con l'app vera. I due
   aggiornamenti devono stare a cavallo di un istante del server in cui l'età cambia a uno scatto:
   gli scatti cadono sui minuti interi, e l'età cambia 45 s (ora → 0m fa) e 60 s (0m → 1m) dopo
   l'aggiornamento, quindi gli istanti sono i :00 e i :15 di ogni minuto. Il test aspetta (tempo
   vero, `expect.poll`, nessun sonno fisso) che uno sia a 1,5-2,5 s, crea la card, aspetta 3 s
   oltre l'istante, la aggiorna (frame, testo sempre «ora»), poi fa correre l'orologio della pagina
   (`runFor`) fino al primo scatto in cui le due età differiscono e pretende quella del secondo
   aggiornamento. Prova: sul primo fix (`55b7deb`, bundle `TOPICS_E2E_BUNDLE_DIR`) exit 1, riceve
   «1m fa», atteso «0m fa». Dura 13-45 s secondo l'attesa dell'istante.

5. **`fix(board)`: l'età della card segue l'ultimo `updatedAt` anche quando il testo non cambia**
   (`18a7006`). `UpdatedAgo` = `memo(UpdatedAgoText)`, che salta solo a `iso` uguale (una card che
   si ridisegna per altri campi non tocca l'etichetta). Prova: spec 3/3 verdi; il caso D2 ripetuto
   ×4 verde 4/4, due volte su ogni tipo d'istante (durate 12 s / 44 s); mutazione (confronto sul
   testo rimesso, bundle a parte, poi file ripristinato e `git diff` pulito) ×2 rosso 2/2: «1m fa»
   invece di «0m fa» e «0m fa» invece di «ora», cioè entrambi gli istanti. `qa-gate --veloce`: unico
   rosso `check:security` d'ambiente; typecheck, lint, `check:sleeps`, lingua dei commenti verdi.
   `minuteClock.test.ts` 5/5 (l'orologio non cambia). Render per frame 103,3 → 104,3 (sopra).

## Trovato e non fatto

1. **La scheda aperta ha la stessa età ferma.** `TaskDetail.tsx` ~2224 scrive
   `fmtUpdatedAt(task.updatedAt)` nel render: avanza solo quando la scheda si ridisegna (con i
   render della pane), quindi su una board quieta con la scheda aperta resta ferma. Il fix è una
   riga (`<UpdatedAgo iso={task.updatedAt} />`, il file non è nei rami aperti); non fatto perché il
   GOAL di T2b è l'etichetta della card.
2. **Il chip «aspetta da…» delle card in review ha lo stesso difetto di D1.** `fmtAttesa(task.reviewAt)`
   in `Card.tsx` ~845 è calcolato nel render con `Date.now()`: dopo T2 su una card ferma non
   avanza più (precisione all'ora, quindi resta indietro di ore). È un altro campo della card,
   FUORI per il brief. Servirebbe lo stesso orologio in un componente piccolo come `UpdatedAgo`.
3. **Le etichette ascoltano anche a board nascosta dietro un'altra pane.** Le pane restano montate
   (`display:none`): finché la board è montata, un tick al minuto ridisegna ogni etichetta (testo
   e basta, nessuna card). A finestra nascosta invece il timer dorme. Il costo è di N render
   minuscoli al minuto; per evitarlo servirebbe un segnale «pane visibile» da `PaneStage`, che
   oggi l'etichetta non ha. Non misurato oltre il ragionamento.
4. **«0m fa» fra 45 e 59 secondi.** `fmtUpdatedAt` dice «ora» sotto i 45 s, poi
   `Math.floor(ms / 60_000)` = 0 → «0m fa» fino al minuto (provato con `bun -e`: 44 s «ora»,
   45 s e 59 s «0m fa», 60 s «1m fa»). È il formato, scelta di prodotto, FUORI.
5. **Il rimando interno sbagliato nel REPORT di T2** («Trovato» 5 dice «punto 9», il revert è il
   punto 5 di «Fatto»), segnalato da V2 al suo «Trovato» 2: non corretto, il brief chiede solo gli
   hash.
6. **RECAPTURE-01** rosso nell'area e2e, prima e dopo, come in T2 e V2: non è di questa traccia.

## Rifiutato

- ~~«Un orologio condiviso aggiunge render ai frame»: rifiutato nella prima consegna grazie al
  confronto sul testo.~~ **Ritirato**: quel confronto era D2. L'etichetta aggiunge un render per
  frame (104,3) ed è il prezzo giusto.
- **«Un tick nella finestra del banco dei render lo gonfia.»** Può succedere (un tick ridisegna
  tutte le etichette insieme), ma le finestre del banco durano frazioni di secondo: nelle 6 corse
  con l'orologio (2 col primo fix, 2 senza confronto, 2 col fix di D2) il numero è identico fra
  le corse dello stesso bundle, quindi nessun tick è caduto dentro. Il banco stesso lo dice nel suo commento
  («the app's own timers... can still land in a window»).
- **«Lo snapshot dovrebbe essere l'ora.»** Con l'ora come snapshot ogni etichetta che si iscrive
  vedrebbe un valore diverso da quello letto nel render e si ridisegnerebbe subito: sessanta
  render inutili al montaggio della board. Il numero di tick non cambia all'iscrizione
  (`minuteClock.test.ts`, «subscribing does not change the snapshot»).
- **«Un `setInterval` per card, come i chip live di `CardLive.tsx`.»** Quelli contano i secondi
  di una card al lavoro; l'età cambia al minuto e sta su tutte le card: un timer per card su una
  board di centinaia è ciò che il brief chiede di evitare.
- **«La spec con l'orologio della pagina avanti di tre minuti rompe le altre card.»** L'orologio
  della pagina corre avanti rispetto al server: una card toccata ora dal server sembra vecchia di
  qualche minuto. Per questo la spec verifica solo la card ferma, creata prima che l'orologio
  partisse.

## Tocca rami aperti

`client/src/components/Board/Card.tsx` (nell'elenco dei file dei rami aperti di
`tracks/T4-dead-code.md`): una riga d'import e una riga nel JSX. Inevitabile: è lì che l'etichetta
si disegna. Tutto il resto del fix sta in due file nuovi, per non allargare il conflitto.

## Setup, sottoagenti, consegna

- Setup: Bun 1.4.2 già presente, Node 20 da `/opt/node20`. Dipendenze come in CI 14 s; Chromium
  `npx playwright install` non usato (la VM ha `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers` con la
  rev 1194): Chrome for Testing 147.0.7727.15 (rev 1217) da `storage.googleapis.com` in
  `/root/.cache/ms-playwright`, `ffmpeg-1011` collegato da `/opt/pw-browsers`, `install-deps`:
  18 s. Setup intero circa 35 s. `SERVER_HOST=127.0.0.1` come T2 e V2.
- Il lavoro è stato fatto in un worktree a parte mentre la barra di partenza girava sull'albero
  pulito; i commit sono poi passati in avanti veloce su `cloud/t2b-eta-card`, dove ha girato la
  barra finale. Unica sbavatura: per circa un minuto, all'inizio degli shard di partenza, la prima
  bozza del fix stava nell'albero principale (poi spostata nel worktree e albero riportato pulito).
  La sola differenza fra i rossi di partenza e quelli finali è `subagent-native-engine`, codice
  server che il fix non tocca.
- Sottoagenti: un Haiku ha lanciato lo script delle misure alternate (render e crescita):
  65 mila token, 7 chiamate in tutto (46 mila per il lancio). Ho fermato io lo script a metà per il
  conflitto di porta con la barra (sopra) e ho rilanciato la crescita da me, con lo stesso script e
  `E2E_PORT=13344`; i numeri vengono dai log e dai JSON che lo script scrive, letti da me. Haiku, a
  fine corsa, ha ricopiato gli stessi log e JSON: i suoi numeri coincidono con i miei, render e
  crescita (i log di crescita che ha letto sono quelli del mio rilancio, stessi nomi di file). Il
  costo di Haiku qui è quasi tutto
  contesto di partenza, lo stesso che pagherebbe un Sonnet `low`: per un lavoro così corto non
  conveniva nessuno dei due, e non ho delegato altro. Studio del codice, progetto, fix, test,
  mutazioni e REPORT li ho fatti io.
- Video e trace: ramo `cloud/t2b-eta-card-evidenza`, cartella
  `openspec/changes/cloud-quality-pass/evidence/T2b/{prima,dopo}/{senza-frame,frame-altra-card}/`,
  ~1 MB. La spec dell'età con `E2E_EVIDENCE=1 E2E_VIDEO=1` sui due bundle: prima la card ferma
  resta «ora» dopo tre minuti (rosso), dopo dice «3m fa» (verde). Per D2 (`3d76d22`):
  `{prima,dopo}/due-aggiornamenti-d2/`, prima = primo fix (allo scatto l'età conta dal primo
  aggiornamento, rosso), dopo = fix di D2 (verde).
- Consegna: `git push origin HEAD:refs/heads/cloud/t2b-eta-card`. L'ambiente assegna anche il
  ramo `claude/task-vnsie5`: stessi commit pushati anche lì.

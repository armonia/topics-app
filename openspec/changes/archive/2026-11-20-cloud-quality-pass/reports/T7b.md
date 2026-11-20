# REPORT T7b · Topic: il sipario non aspetta più un'immagine che ha già il suo riquadro

Ramo di consegna: `cloud/t7b-topic-sipario`, partito da `cloud/t7b-base` a `8246707` (VM cloud,
Ubuntu 24.04, 4 vCPU, 16 GB). La base è misurata da me, stessa VM, in una worktree pulita della
partenza (`/home/user/t7b-base`, `node_modules` in link) con le stesse spec del ramo copiate dentro
(stesso script per i due lati), prima di ogni modifica al client.

## In testa

### Barra

| Pezzo | Prima (`8246707`) | Dopo |
|---|---|---|
| `./scripts/qa-gate.sh --veloce` | exit 0 · 153 s | **exit 0** · 38 s · «BARRA VERDE» su `b257c68`. Sulla prima barra finale (`44b6405`) era **rosso `check:ui-language`** (exit 1): corretto in `b257c68`, vedi Fatto 4 |
| `bun run test:unit:shards` | exit 1 · 10.607 passati nello shard 0 + shard 1 verde, 46 saltati, **1 rosso**: `tests/integration/terminal-revive-race.test.ts` («due revive concorrenti»), con la VM a load 6 (girava insieme alla mia prima e2e: 2 shard invece di 4); rilanciato da solo sulla base: 2/2 verdi, exit 0. Non è mio e non è un difetto: è il carico · 803 s | **exit 0** · PASS 1843 file (i 1842 della base + `attachmentSizes.test.ts`) in 4 shard, 0 rossi · 473 s (load 1,0-2,0) |
| `bun run build:client && bun run check:bundle` | exit 0 / 0 · eager raw 1.670.772 B, gz 533.003 B | **exit 0 / 0** · eager raw 1.671.931 B (+1.159), gz 533.523 B (+520), dentro il budget |
| `SERVER_HOST=127.0.0.1 E2E_TIER=pr npx playwright test --project=chromium tests/e2e/topic-*.spec.ts tests/e2e/chat-*.spec.ts tests/e2e/*cls*.spec.ts` (B4; comprende `refresh-cls` e `pane-return-cls`) | exit 1 · 267 passati, **2 rossi = le due scene nuove** (attese: sono B1 e B2 sul codice di prima), 2 flaky (`chat-streaming-indicator` «at the bottom the line comes and goes…», `chat-transcript-motion` F02) · 1339 s | **exit 0** · 270 passati (i 267 + le 2 scene nuove + `chat-transcript-motion` F02, flaky sulla base e verde qui), 0 rossi, 1 flaky (`chat-streaming-indicator`, lo stesso della base) · 1282 s. Girata su `44b6405`: `b257c68` cambia solo la forma di due tipi in `ChatPane.tsx`, nessun cambio di comportamento |

`SERVER_HOST=127.0.0.1` solo sull'e2e: la VM non ha IPv6 (lo stesso di T0/T1/T7). Il bundle dell'e2e
è costruito a parte per lato (`TOPICS_E2E_BUNDLE_DIR`, `vite build --outDir` della worktree), così
i due lati girano dalla stessa cartella di spec senza toccare `public/`.

### Numeri della traccia

Stessa VM, prima = worktree della partenza con le spec nuove copiate, dopo = questo ramo; due
serie da 5 corse per lato, alternate (prima, dopo, prima, dopo), `--retries=0 --repeat-each=5`.
Log e `uptime` di ogni serie in `scratchpad/mis/*.log` (load 0,85-3,75 sulle due parti).

| Numero | Scena | Prima (10 corse) | Dopo (10 corse) | Target | Esito |
|---|---|---|---|---|---|
| **B1** frame dal clic sul tab al sipario alzato | `topic-visited-first-frame` «una topic visitata con un'immagine in vista…» (byte trattenuti 1,5 s) | mediana **75**, p95 76 (72-76): il tetto duro del sipario | mediana **15,5**, p95 16 (14-16) | ≤ 30 frame (il tetto è 72 a 60 Hz) | **ok** |
| B1 ms dal clic al sipario alzato | idem | mediana 1273, p95 1308 | mediana **279,5**, p95 301 | prima che i byte arrivino | **ok** |
| B1 sipario alzato prima del rilascio dei byte | idem | sì ma solo per il tetto: 386-472 ms prima del rilascio | **1380-1432 ms** prima del rilascio | prima del rilascio | **ok** |
| B1 CLS | idem | 0,0000 ×10 | 0,0000 ×10 | ≤ 0,01 | **ok** |
| **B2** CLS della bolla di chi allega | `chat-image-box` «la bolla di chi allega…» (PNG 900×500, byte trattenuti 1,2 s, turno trattenuto) | **0,0488** ×8, 0,0485 ×2; immagine alta **0 px** prima dei byte | **0,0000** ×10; riquadro alto **320 px** prima dei byte | ≤ 0,01 | **ok** |
| **B3** mutazione: sipario senza il salto (`img:not([data-media-box])` → `img`) | B1 su copia scratch `/home/user/t7b-mut` | | rosso 2/2: 75 frame, «the curtain waited for its hard cap» | rosso | **ok** |
| **B3** mutazione: bolla senza dimensioni (`mediaSizes` tolto dall'invio in `ChatPane`) | B2 su copia scratch | | rosso 2/2: CLS 0,0488, immagine 0 px | rosso | **ok** |

Le mutazioni sono state fatte nella worktree scratch, mai nei file veri: `git checkout --` dopo
ogni bundle, `git status` pulito (resta solo la spec scratch delle foto, mai committata).

Sul lato «prima» B1 è già a CLS 0: il riquadro c'era (T7), il sipario lo aspettava lo stesso fino al
tetto. Il guadagno di B1 è tutto nel tempo: ~1 s di scheletro in meno su ogni topic con un'immagine
in fondo.

## Fatto

### 1. `b4b0c4e` fix(chat): il sipario non aspetta un'immagine che ha già il suo riquadro

`listPaintedAndWhole` aspettava ogni `<img>` in vista non ancora caricata. `MediaImage` ora marca
l'immagine che è nel suo riquadro e non ha ancora i byte con `data-media-box`, e il sipario salta
solo quelle (`img:not([data-media-box])`). Le immagini senza riquadro (remote, SVG, server vecchio,
file illeggibile) restano aspettate come prima. Ho scelto un attributo e non la lettura dello stile
(`aspect-ratio`) perché è la dichiarazione esplicita di chi disegna il riquadro: un altro stile non
può imitarla per caso.

Il riquadro in attesa: tinta neutra del tema, `bg-app-hover` in chiaro e `dark:bg-elevated` in
scuro, le stesse del riquadro d'errore dell'immagine poche righe sopra. Niente animazioni (un
`animate-pulse` non sposta niente, ma non serve e lampeggerebbe in ogni topic con un'immagine
remota lenta). Dopo il `load` la tinta va via insieme allo stile, quindi un PNG trasparente resta
com'era. Misurato con una spec scratch (non committata) a byte trattenuti 8 s, 900×500 in una
colonna da 1280: chiaro `rgb(245,245,246)` su pagina `rgb(236,237,238)`, scuro `rgb(34,35,37)` su
`rgb(8,10,14)`, 576×320 in tutti e due; le foto sono sul ramo delle evidenze.

Prove: B1 e B3 sopra; unit `client/src/components/Chat/mediaBox.test.tsx` 9/9 (due nuovi: con il
riquadro c'è il segno e la tinta, senza riquadro né l'uno né l'altra).

### 2. `45cfed3` fix(chat): la bolla di chi allega un'immagine ha il riquadro prima dei byte

La bolla ottimistica si disegna prima che il server abbia la riga, quindi senza `mediaSizes`.
`Chat/attachmentSizes.ts` (nuovo) legge la dimensione naturale del file nel composer con un
`<img>` su un object URL: è lo stesso elemento che la disegnerà (orientamento EXIF compreso), e il
`load` di un file locale arriva in millisecondi senza aspettare la decodifica, che invece
`createImageBitmap` fa per intero (una foto da 12 MP la decodificherebbe solo per sapere quanto è
grande). La lettura parte insieme al caricamento del file e l'invio non la aspetta mai più di 500 ms:
oltre, la bolla esce senza dimensioni, cioè come prima. Le dimensioni vanno sulla bolla sotto il
percorso scritto in `[Attached file: …]`, lo stesso con cui `MediaImage` le cerca.

Dove passano (il minimo):
- `ChatPane.tsx` (rami aperti): `uploadFiles` restituisce file e percorso insieme. Prima restituiva
  solo i percorsi, e con un caricamento fallito non si sarebbe più saputo quale file fosse quale
  percorso. La lettura parte per i file scelti e per le immagini incollate (`readPictureSize` sul
  `dataUrl` già ridimensionato, cioè sull'immagine che si carica davvero). Le dimensioni viaggiano
  in `SendMessageOptions.mediaSizes`.
- `useChat.ts` (rami aperti): `performSend` le mette sulla bolla, una riga.
- `state/firstSend.ts` + `usePanelLifecycle.ts`: la bolla del primo messaggio di una bozza, che si
  disegna prima che la topic esista.
- `state/chatQueue.ts` `mergeBatch`: più messaggi in coda escono come una bolla sola, che prende le
  dimensioni di tutti. `sameOptions` confronta solo fast/provider/model, quindi le dimensioni non
  spezzano il batch (test nuovo in `chatQueue.test.ts`).
- Il server non le riceve: `chatRequest` si costruisce campo per campo.

Prove: B2 e B3 sopra; unit `attachmentSizes.test.ts` (3), `chatQueue.test.ts` (+1), 56/56 sui file
toccati.

### 3. `b3ee810` docs(openspec): CHAT-MEDIA-BOX-01

Due scenari nel delta `specs/chat/spec.md` (la topic visitata che si scopre senza aspettare i byte,
la bolla di chi allega) e la regola del riquadro in attesa.

### 4. `b257c68` fix(chat): niente generici nelle righe del composer

La prima barra finale era rossa su `check:ui-language` (exit 1, 7 colpi in `ChatPane.tsx`): lo
scanner del cancello legge un `Array<…>` in un `.tsx` come un tag JSX, e da lì prendeva per testo
dell'interfaccia stringhe che c'erano già («Upload failed», «[Attached file:», «New Chat»). Nuova
era solo la forma dei due tipi del commit 2. Ora `{ file: File; path: string }[]` e l'alias
`PendingSize` in `attachmentSizes.ts`. Prova: `check:ui-language` exit 1 → 0, barra intera verde.
Non ho toccato il cancello (fuori recinto), ma è un falso positivo da sapere: «Trovato e non fatto» 6.

### Evidenze

Ramo `cloud/t7b-topic-sipario-evidenza` (`5d6104c`, 3,7 MB): `evidenze/T7b/prima` e `dopo`, un video e un trace
per scena (`sipario`, `bolla`), le foto del riquadro in chiaro e scuro (`riquadro/`) e
`LEGGIMI.md`. Prima: sipario a 75 frame / 1260 ms, bolla a CLS 0,0488; dopo: 16 frame / 283 ms,
CLS 0. Letti sui fotogrammi estratti con ffmpeg: prima ~1,5 s di scheletro e la bolla che entra
senza immagine e poi si allunga; dopo un fotogramma di scheletro, poi la topic con il riquadro
grigio che si riempie, e la bolla che entra già alta. Le stesse cartelle restano nella VM in
`/home/user/t7b-base/test-results/artifacts-13401` e `/home/user/topics-app/test-results/artifacts-13402`.

## Trovato e non fatto

1. **L'immagine scritta a metà streaming** (`MEDIA:` in un chunk): fuori traccia, serve un campo nel
   protocollo. Finché il turno scrive, quell'immagine non ha riquadro e il sipario non c'entra (è
   una chat già aperta).
2. **Il riquadro di un JPEG con densità corretta** (EXIF/pHYs che cambia la dimensione di layout):
   il riquadro prima del `load` può differire dalla misura dopo, e ora il sipario non aspetta più
   quell'immagine. Il caso esisteva già con T7 (lo spostamento al `load`); qui al più si vede sotto
   il sipario alzato invece che dietro. Non misurato: servirebbe un JPEG con densità diversa da
   72 dpi nella fixture e una scena come B1.
3. **Un'immagine in errore** passa dal riquadro di 320 px al riquadro d'errore (una riga): uno
   spostamento, ma solo su un'immagine rotta. Com'era con T7.
4. **La bolla di chi allega in un'altra finestra** (stesso account, seconda finestra aperta sulla
   chat): lì la bolla arriva come `message:new` dal server, che porta già `mediaSizes` (T7). Niente
   da fare.
5. **Il commento del campo `mediaSizes` in `client/src/types/index.ts`** dice «sent by the server»;
   ora sulla bolla di chi invia lo scrive anche il composer. Lasciato: il file è nell'elenco dei rami
   aperti e il campo non cambia forma.

6. **`check:ui-language` scambia un generico TypeScript per JSX** (`scripts/check-ui-language.ts`,
   la regola `jsx-expr`): un `Array<{…}>` in un `.tsx` fa leggere come testo d'interfaccia le
   stringhe delle righe dopo. L'ho aggirato nel codice (Fatto 4); correggere lo scanner è di T6
   (elenco dei cancelli).
7. **B4: `chat-streaming-indicator` «at the bottom the line comes and goes…» è flaky** sulla base e
   sul ramo, `chat-transcript-motion` F02 solo sulla base: non toccati da questa traccia, non
   indagati.

## Rifiutato

- «Il sipario prima del fix si alza comunque prima dei byte, quindi B1 non distingue»: vero per i
  soli millisecondi (il tetto duro, 1200 ms, finisce prima dei 1,5 s trattenuti). Per questo B1
  conta i frame contro un tetto di 30, come il resto della spec: prima 72-76, dopo 14-16.
- «Basta non aspettare nessuna immagine»: no, quelle senza riquadro (remote, SVG) crescono ancora al
  `load` e il sipario esiste proprio per nasconderle (640 px misurati il 03/09).
- «Mettere le dimensioni in un registro globale per percorso, letto da `useMediaBox`»: avrebbe
  evitato `useChat` e la coda, ma le dimensioni non sarebbero state sulla bolla come chiede la
  traccia, e un registro di processo cresce e va potato. Scelte le opzioni d'invio.
- «`createImageBitmap`»: decodifica l'immagine intera per darne la misura; un `<img>` dà la stessa
  misura (quella che il browser userà per disegnarla) al `load`.

## Tocca rami aperti

- `client/src/components/MessageContent.tsx`: in `MediaImage` 1 costante con il commento, e sull'`<img>`
  la classe della tinta, lo `style` e `data-media-box`.
- `client/src/components/Chat/ChatPane.tsx`: 1 import, `uploadFiles` (restituisce `{file, path}`),
  4 righe nell'invio con allegati (lettura per file e per immagini incollate) e 3 righe al
  `sendMessage`.
- `client/src/hooks/useChat.ts`: 1 import di tipo, il campo `mediaSizes` in `SendMessageOptions`,
  1 riga sulla bolla in `performSend`.

## Setup, modelli, consegna

- Setup: Node 20 da `/opt/node20`, Bun 1.4.2 già presente (≥ 1.4.0, nessun aggiornamento); dipendenze
  come in CI 21 s; Chromium con `npx playwright install --with-deps chromium` 37 s (dal CDN, nessun
  ripiego). WebKit non provato (la barra è `chromium`). Bun 1.3.8 non serve: nessun codice server
  toccato.
- Modelli: lo studio del sipario e del percorso d'invio, il disegno delle due scene, il codice dei
  fix, la scelta delle mutazioni e la revisione del diff li ho fatti io (Opus). A un sottoagente
  Haiku 5.5 ho delegato la campagna di misure (lo script `campagna.sh`, scritto da me: B1/B2 prima e
  dopo ×5 in due serie, più B3) con il solo compito di lanciarlo e riportare le righe grezze, mediana
  e p95: ~64 mila token in 2 chiamate, quasi tutti di contesto, nessun ragionamento lungo; un Sonnet a
  effort `low` avrebbe caricato lo stesso contesto, quindi sono rimasto su Haiku. Ho riestratto io
  tutte le righe dai log: i numeri coincidono.
- Consegna: `git push origin HEAD:refs/heads/cloud/t7b-topic-sipario` (exit 0), anche sul ramo
  `claude/task-xmt7av` che l'ambiente assegna alla sessione. Evidenze su
  `cloud/t7b-topic-sipario-evidenza`.

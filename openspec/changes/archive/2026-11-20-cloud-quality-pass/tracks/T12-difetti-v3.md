# T12 — i due difetti trovati da V3, e il sospetto della chat

**GOAL.** D1 e D2 della verifica indipendente V3 corretti con prova; il sospetto su
`chat-accordion-no-shift` dimostrato (e corretto) oppure smentito con i numeri.

- **Base:** `cloud/quality-pass-integrata` @ `fa68e2df2` più i due test rossi di V3 (`466e3c5`, scelti
  apposta: sono la prova del prima). Base «main» per i confronti: `main` @ `396451881`.
- Il REPORT di V3 sta su `cloud/v3-verifica-integrata`, file `openspec/changes/cloud-quality-pass/reports/V3.md`
  (sezioni «Difetti», «Il flaky della testa», B3.4, B3.5). Gli script e la sonda stanno su
  `cloud/v3-verifica-integrata-evidenza`, `openspec/changes/cloud-quality-pass/evidence/V3/`.

## D1 · media: le migration incorporate sulla Bun 1.3.8

Sulla 1.3.8, la Bun del server di produzione, `require("./db/migrations-embedded")` (`server/db.ts:248`, il
caricamento pigro di T3) dà per ognuna delle 184 migration il **percorso del file** al posto del testo SQL,
perché su 1.3.8 `require` ignora `with { type: "text" }`. In produzione oggi il ramo non si raggiunge: il server
da sorgente legge la cartella, e il sidecar compilato incorpora il testo giusto anche con la 1.3.8. Ma la suite
unit del server sulla 1.3.8 diventa rossa a seconda dell'ordine dei file: 13 rossi sulla testa, 0 su main.

Vincoli: il guadagno di T3 resta (il manifest fuori dal grafo dell'avvio quando la cartella c'è), oppure misuri
quanto costa rinunciarci; il sidecar compilato funziona su tutte e due le Bun (`scripts/build-server-sidecar.sh
smoke`). La 1.3.8 accanto alla tua: `_comuni.md`, Setup 2.

## D2 · bassa: le dimensioni delle immagini arrivano a un ospite

Un socket ospite riceve in `message:new` i `mediaSizes` di file che non può scaricare (`/uploads/…` e `/api/media`
non sono in `isGuestAllowedPath`): esistenza e misure di un file sul disco del proprietario.
`withFrameMediaSizes` gira prima del filtro per socket (`server/utils.ts:1038-1044`). Rimedio: l'ospite riceve le
dimensioni solo dei percorsi che può scaricare, o nessuna (decidi e scrivi perché); il proprietario come oggi;
nessun lavoro in più per un broadcast senza ospiti collegati.

## S · il sospetto: `chat-accordion-no-shift` «tool-result-clamp»

`tests/e2e/chat-accordion-no-shift.spec.ts:479` è rosso 2 volte su 27 sulla testa e 0 su 27 su main: la chat in
fondo non sta ferma 15 frame al fondo vero entro 30 s (riga 507). È nella zona del pin a riposo di T7. Protocollo
di T11: un carico scritto e uguale per i due lati, N ≥ 40 per lato (main con le spec della testa contro la testa),
`--retries=0`, con la sonda di V3 (`accordion-debug.patch`) per catturare la sequenza dei frame quando è rosso.
Testa ≥ 3/40 e main 0/40 → difetto: causa, fix, test deterministico. Altrimenti «non dimostrato» con i numeri, e
non tocchi niente.

## Barra (si esegue uguale all'inizio e alla fine)

- **B1 D1:** `server/db/v3-embedded-fallback-fresh-process.test.ts` rosso sulla 1.3.8 prima, verde dopo sulla 1.3.8
  e sulla latest. La suite unit del server sulla 1.3.8 (`PATH=/tmp/bun138/node_modules/.bin:$PATH bun run
  test:unit:shards`): nessun rosso che non sia rosso anche su main nella stessa corsa (`comm` delle liste).
  Avvio del server di test (`evidence/V3/boot-time.sh warm`, 3 coppie alternate) non peggiore della testa.
  Smoke del sidecar sulla 1.3.8 e sulla latest.
- **B2 D2:** `server/v3-guest-media-sizes.test.ts` rosso prima, verde dopo; il proprietario riceve ancora le
  dimensioni (un'asserzione lo dice).
- **B3 mutazioni** (copia scratch, mai il file vero): senza il fix di D1 la B1 torna rossa sulla 1.3.8; senza il
  filtro di D2 il test dell'ospite torna rosso.
- **B4 verde resta verde:** la barra comune di `_comuni.md`.
- I due test di V3 restano, con il nome di ciò che proteggono (senza il prefisso `v3-`).

## Consegna

Ramo `cloud/t12-difetti-v3`, REPORT in `openspec/changes/cloud-quality-pass/reports/T12.md`: in testa D1, D2 e S
con prima/dopo e comando, poi B3 e B4.

**FUORI.** Migrazioni (file `.sql` nuovi), workflow CI, `.bun-version`, aggiornare Bun, altre rotte, il client
(salvo S dimostrato).

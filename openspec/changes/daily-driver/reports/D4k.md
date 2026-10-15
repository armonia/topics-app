# D4k · B10, prima metà

**Barra prima:** primo `./scripts/qa-gate.sh --veloce`, exit 1, 21/24 verdi e 3 rossi: `check:bloat` (DomCoBrowse oltre 800 righe), `check:typography` (`text-micro` fuori scala), `check:untraced-tests` (unit senza `@covers`). Unit DOM esistente: 1 pass, 0 fail.

**Barra dopo:** `./scripts/qa-gate.sh --veloce`, exit 0, 24/24 verdi. `bun test client/src/lib/crossOriginFrame.test.ts`: 3 pass, 0 fail. Mutazione in copia che ignorava l'origine: exit 1, 1 pass e 2 fail. `bun run check:spec-coverage`: exit 0, 0 scoperti, 0 ambigui, 0 penzolanti. `bun run typecheck:e2e`: exit 0.

## Fatto

- Funzione pura `crossOriginFrameHost`: stessa origine, URL assente o non valido, `about:blank` e `data:` non producono host; origine diversa restituisce solo host. Unit verde e mutazione rossa come sopra.
- Overlay nel viewer sul frame cross-origin, segue scroll e resize; mostra «Contenuto di {host}» e «Si usa sul Mac». Il tocco mostra un avviso breve senza relay; il resto dell'overlay continua a inviare input. E2E scritto con `hostNativePage`, annotato `NATIVE-HOST-09` e typecheck verde.
- Requisito `NATIVE-HOST-09` in `openspec/specs/remote-browser/spec.md`; copertura spec verde, 0 debiti.
- Cataloghi italiano e inglese aggiornati. I cancelli `check:*` della barra veloce vedono i file nuovi via intent-to-add.

## In revisione

- Gli iframe nascosti o da un pixel (analisi, captcha invisibili) ricevevano un segnaposto con
  dimensione minima 84×52 sopra la pagina: sui siti veri ne capitano diversi. Ora un frame sotto i
  16 px per lato non ha segnaposto, e la e2e ne mette uno nascosto e uno da 1 px accanto a quello
  vero, aspettandosi ancora un solo segnaposto.

## Trovato e non fatto

- Esecuzione della nuova E2E e video: la policy locale vieta le E2E sul Mac; resta al job CI «Clip di consegna». 

## Rifiutato

- Registrare il contenuto dei frame cross-origin con `recordCrossOriginIframes`: esporrebbe i campi di pagamento nel mirror. Il segnaposto evita anche di mostrare query e token degli URL.

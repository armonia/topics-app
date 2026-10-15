# D4b, B2: eco scroll ordinate per sequenza

**Barra prima:** `bun test client/src/lib/mirrorScroll.test.ts` exit 0, 10 pass, 0 fail. La regressione già documentata: Chromium 3/3 rossi (run 38680990091), WebKit instabile (run 38682958298). Gli altri cancelli non misurati prima della modifica.

**Barra dopo:** test mirati 12/12; typecheck 0; typecheck:e2e 0; lint 0; `./scripts/qa-gate.sh --veloce` 0, 25/25 cancelli verdi. `git diff --check` 0.

## Fatto

- `shared/browser-ws-messages.ts`, `DomCoBrowse.tsx`, `nativeDomHost.ts`: ogni relay porta `scrollSeq`; il recorder nativo la restituisce con l'eco. `createEchoHold` scarta le sequenze vecchie senza guardare il tempo e lascia passare subito la sequenza corrente, anche se posizione e relay differiscono. Gli host senza sequenza mantengono il percorso temporizzato legacy.
- `bun test client/src/lib/mirrorScroll.test.ts client/src/lib/nativeDomHost.page.test.ts client/src/lib/nativeDomHost.test.ts`: exit 0, 54 pass, 0 fail, 153 asserzioni.
- Mutazione in copia nello scratchpad: rimosso di fatto il confronto che scarta le sequenze vecchie; il test nuovo è rosso, 11 pass e 1 fail, exit 1. Copia rimossa.
- `bun run typecheck`: exit 0. `bun run typecheck:e2e`: exit 0.
- `bun run lint`: exit 0, 4 warning preesistenti in file non toccati.
- `./scripts/qa-gate.sh --veloce`: exit 0, barra verde; tutti i 25 cancelli elencati verdi.

## Trovato e non fatto

- Clip e2e `repeat=30`, `load=true`, Chromium e WebKit su `browser-mirror-scroll-lands.spec.ts`: non eseguita sul Mac come richiesto. Va lanciata in CI dopo il push; il brief vieta push e commit in questa worktree.
- Revisione indipendente, merge e porto in produzione restano successivi alla consegna locale.

## Rifiutato

- I 4 warning ESLint provengono da `App.tsx`, `useProjectBrowserPanes.ts`, `useRemoteBrowser.ts` e `useSpeech.ts`; lint esce 0 e nessuno dei file è stato toccato.

## Correzioni dopo la consegna

- **L'eco della sequenza corrente aspettava zero.** Il giro di Codex la applicava subito, anche a
  gesto in corso. Gli inoltri partono a lotti ogni 60 ms e il mirror è sempre avanti dell'ultimo: su
  una connessione veloce (la risposta torna prima del lotto dopo) lo tirava indietro a ogni lotto. La
  CI non lo vede perché il suo Mac risponde dopo 150 ms, quando quell'eco è già superata. Ora aspetta
  la fine del gesto, come ogni eco; dopo il gesto passa subito, senza la finestra di conferma.
- **Un'eco trattenuta e poi superata arrivava lo stesso.** Al rilascio si ricontrolla: se nel
  frattempo è partito un inoltro più nuovo, si scarta.
- **Due dispositivi sulla stessa pagina.** Il Mac ricorda l'ultimo inoltro di chiunque: le eco degli
  scroll di B portavano i numeri di B, A le confrontava coi propri, le scartava e smetteva di seguire
  la pagina. Ogni inoltro porta anche chi lo manda (`scrollFrom`), e si ordinano solo le eco dei
  propri.
- Il test «la risposta all'ultimo inoltro passa anche se diversa» di Codex passava anche sul codice
  di prima (aspettava 2.500 ms, oltre ogni finestra): ora la prova a 700 ms, dove il codice di prima
  la tratteneva fino a 2.000.
- **Mutazioni, copia scratch, ognuna rossa sul suo test e solo su quello (14 pass, 1 fail):** attesa
  del gesto saltata per le eco numerate; mittente ignorato; eco superate tenute al rilascio; eco
  superate tenute all'arrivo.
- **Barra:** `bun test client/src/lib/mirrorScroll.test.ts client/src/lib/nativeDomHost.page.test.ts client/src/lib/nativeDomHost.test.ts`
  exit 0, 57 pass.

## Dopo il primo push

- **`build:client` rosso**, in CI e in locale: `scrollFrom: z.string().max(64)` è la sintassi della
  zod classica, in `zod/mini` il limite si scrive `.check(z.maxLength(64))`. Era entrato con la mia
  correzione del mittente, dopo la quale avevo girato i test e non i cancelli completi.
- **`check:bloat` rosso**: `DomCoBrowse.tsx` a 802 righe (tetto 800). Sequenza e mittente
  dell'inoltro ora li tiene `createEchoHold` (`stamp()`), il componente torna a 794 righe e a una
  riga sola per l'inoltro. Test nuovo su `stamp`; mutante in una worktree usa e getta (`stamp` che
  numera senza registrare) rosso solo su quel test, gli altri 15 verdi.
- Cancelli completi dopo il commit: typecheck (client compreso), lint, 0 file non aggiunti, 0
  cancelli statici rossi.

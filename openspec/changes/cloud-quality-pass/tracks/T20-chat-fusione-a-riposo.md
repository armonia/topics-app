# T20 · Chat: il resto della storia si fonde a lista ferma

Ramo: `cloud/t20-chat-fusione-a-riposo`, da `cloud/t20-base`. Regole comuni: `_comuni.md`.
REPORT: `openspec/changes/cloud-quality-pass/reports/T20.md`.

## Perché

PR #269 (bozza), scroll infinito della chat (CHAT-HIST-01): risalendo, il resto della storia
arriva da solo e viene anteposto sotto chi legge (`firstItemIndex` di Virtuoso 4.18.16). Il terzo
verificatore ha trovato quattro difetti, con sonde su WebKit (macOS):

1. Pagina su, Shift+Spazio e Home scorrono animati per una dozzina di fotogrammi. La fusione che
   cade a metà dell'animazione fa saltare le righe lette di migliaia di px (1709 px fuori al
   fotogramma dopo la fusione, poi Virtuoso compensa a stima, 104 px a riga).
2. Home dal fondo, con la risposta del resto ritardata di 0 e di 1500 ms: in cima, a lista ferma,
   la fusione sposta le righe lette. Due cause probabili: il divisore «Carica i messaggi
   precedenti» che sparisce in vista, e le righe anteposte nell'overscan misurate quando Virtuoso
   non compensa più (lo fa solo se l'ultimo scroll andava in su, entro 50 ms).
3. Si sale, la richiesta è in volo, si passa a un'altra scheda prima che arrivi: la fusione arriva
   a scheda nascosta senza ancora, e al ritorno la riga letta non è dov'era.
4. Dopo una fusione il «↓ N» (pulsante per tornare in fondo) conta come nuove le righe vecchie
   aggiunte in cima, e compare il banner dei messaggi nuovi.

## Già fatto, da provare (commit 56540812c, bozza)

- `client/src/components/Chat/mergeAtRest.ts`: chi sale nella fascia di fusione la VUOLE soltanto;
  si fonde quando nessuno scroll da 150 ms, nessuna pressione tenuta, righe arrivate (`staged`) e
  scheda a schermo. Unitari in `mergeAtRest.test.ts`, verdi.
- `MessageList.tsx`: `headingUp` chiede solo `stage`; la fusione è `flushSync` di `apply`, poi
  `placeRowAt` (estratto in `placeRowAt.ts`) rimette la riga letta al pixel. Il «↓» conta solo
  ciò che è cresciuto in fondo (`countItemsAddedAbove`).
- Mai provata in e2e: può darsi che non basti, o che sbagli qualcosa (per esempio `placeRowAt`
  dopo `flushSync` legge il DOM prima che Virtuoso abbia disegnato le righe nuove). Lo dicono i
  test, non questa nota.

## Il compito

1. Tre gruppi di test in `tests/e2e/chat-infinite-scroll.spec.ts`, nello stile del file (sonda
   per fotogramma, `stillView`, `afterFrames`; niente `waitForTimeout`, lo vieta `check:sleeps`):
   - **a.** Pagina su, Shift+Spazio e Home (Home anche con la risposta ritardata di 1500 ms via
     `page.route`): dal fotogramma prima della fusione ai 20 dopo, le righe lette prima non si
     spostano più di 1 px; nessun fotogramma vuoto; una richiesta sola. Campiona anche dopo il
     layout e i ResizeObserver dell'app, prima del paint (il modo «ro» della sonda): è quello che
     ha preso Shift+Spazio.
   - **b.** Due chat nella stessa finestra. Si sale nella fascia di fusione con la risposta
     trattenuta, si passa all'altra scheda, la risposta arriva, si torna: la prima riga in vista è
     la stessa, con l'offset entro 2 px.
   - **c.** Dopo una fusione con la rotella, il «↓» non mostra un numero e il banner dei messaggi
     nuovi non c'è.
   Le sonde del verificatore sono in `tracks/T20-sonde/` (`.txt`, non girano): sono il punto di
   partenza, non da copiare così.
2. Ogni test nuovo è rosso sul bundle di `3bad7e0e8` (prima della bozza) e verde su quello nuovo,
   su Chromium e su WebKit (Linux). Se è rosso sulla bozza, il difetto è nella bozza: correggilo
   (`MessageList.tsx`, `mergeAtRest.ts`, `placeRowAt.ts`), con la diagnosi nel commit.
3. Mutazioni su copie, ognuna rossa: senza l'attesa del riposo; senza `placeRowAt` dopo la
   fusione; il contatore di prima.
4. Ciò che è verde resta verde, su Chromium e WebKit: `chat-infinite-scroll`, `chat-tail-first`,
   `chat-history-window`, `history-page-budget`, `tab-switch-instant`, `chat-compact-drain`,
   `chat-scroll-*`; gli unitari del client; `check:bloat` (`MessageList.tsx` ha tetto 2497 righe:
   ciò che cresce va in un modulo suo, come `mergeAtRest.ts`).
5. Aggiorna `openspec/specs/chat/spec.md` (CHAT-HIST-01: la fusione a lista ferma, il «↓» che
   conta solo il fondo) e `openspec/changes/infinite-scroll/` (`specs/acceptance.md`: i tre test
   da aggiungere ora ci sono; `tasks.md`: T4).

## Recinto

Solo la chat: `client/src/components/Chat/*`, `client/src/state/historyCompleteness.ts`,
`tests/e2e/chat-*.spec.ts`, `openspec/specs/chat/spec.md`, `openspec/changes/infinite-scroll/`.
Nessuna rotta nuova, nessuna dipendenza nuova, Virtuoso resta 4.18.16.

## Consegna

Fix e test su `cloud/t20-chat-fusione-a-riposo`, push a ogni passo verde. Nell'ultimo commit togli
`tracks/T20-sonde/`. REPORT con, per ogni test nuovo, rosso prima e verde dopo su entrambi i
motori, e le mutazioni.

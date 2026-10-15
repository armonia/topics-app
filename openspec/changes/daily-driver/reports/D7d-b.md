# D7d-b · Test instabili, secondo giro

Sette spec dal censimento del 15/10. Un giro di Codex ha proposto sei correzioni; la revisione ne tiene
una. Le altre cinque avevano una causa che la verifica smentisce, e una correzione di test su una causa
sbagliata nasconde il rosso invece di spiegarlo.

## Barra

- `bun run typecheck:e2e` exit 0.
- La barra vera è la clip in CI, `repeat=20` e `load=true`, verde 20 su 20.

## Tenuto

**AC-26, `model-panels-providers.spec.ts:377`.** Il primo Escape riporta dal dettaglio alla lista; il
test premeva il secondo senza aspettare che la lista ci fosse, e il log del rosso finisce sul fuoco non
restituito al chip. Ora il secondo Escape parte quando la lista è visibile: si aspetta la condizione,
non un tempo.

`gh workflow run clip-consegna.yml --repo armonia/topics-app --ref daily/d7d-flaky-b -f spec=tests/e2e/model-panels-providers.spec.ts -f grep="the palette and the plan-limit doors open this chip" -f repeat=20 -f load=true -f slowmo=false`

## Rifiutato, con la prova

**`browser-own-layout.spec.ts:226/255` e `browser-mirror-scroll-lands.spec.ts:151`.** La proposta
aspettava `scrollend` su `doc.scrollingElement`. Due ragioni per cui non regge:

- per lo scroll della radice l'evento arriva al Document, non a `<html>`. Misurato con Playwright
  headless: WebKit 26.4 e Chromium 153 danno `html: 0, document: 1, window: 1`. L'attesa non
  finirebbe mai;
- il fling del mirror è JavaScript, un passo per frame (`startFling` in `DomCoBrowse.tsx`, ogni passo
  uno scroll programmatico). Anche ascoltato sul Document, `scrollend` arriverebbe dopo il primo
  passo, non alla fine del fling.

La fine del fling si legge solo dal prodotto (`localScrollRef.current.fling === null`), e oggi non è
esposta. Resta aperto: o un segnale del prodotto, o la prova che il movimento dopo la fine
(`after=[1423]` nel log) è un'eco tardiva della sorgente, cioè il difetto che il test esiste per
prendere.

**ADD-09, `add-menu.spec.ts:256`.** Il rosso è l'Escape dopo ⌘N: la palette resta aperta 10 s
(`toHaveCount(0)`, «14 × locator resolved to 1 element»). La proposta la chiudeva cliccando il velo, cioè
aggirava proprio il passo che fallisce. Ipotesi non provata: `useDismissable` arma il `keydown` di
Escape in un `useEffect` passivo, e un Escape che arriva prima dell'effetto si perde. Da provare prima
di toccare il hook, che è di tutti i menu.

**AskUserQuestion, `ask-user-question.spec.ts:285`.** La proposta rendeva unico il `toolCallId` per
non riaprire una bozza vecchia. La bozza vive in `localStorage` (`askDraft.ts`) e ogni test ha un
contesto nuovo, anche nel retry: una bozza di un altro tentativo non può esserci. Causa non trovata.

**Rinomina del terminale, `terminal-tab-reload.spec.ts:178`.** La proposta spiegava i 5 s senza PATCH
con `fetchWhileRosterWarms` che la rimanda. Non la rimanda: la prima richiesta parte subito
(`let res = await apiFetch(input, init)`), solo un 503 «roster warming» la ripete. Se in 5 s non è
partita nessuna PATCH, l'Enter non ha salvato, o `apiFetch` ha aspettato altro. Causa non trovata.

## Aperto

- **Board motion, `board-motion-contract.spec.ts:433`.** Dopo Escape resta un `[data-drag-preview]`.
  `onDragCancel` azzera già `activeId`: serve il trace per sapere se Escape arriva al callback.
- **`browser-own-layout.spec.ts:289` [webkit].** «WebKit encountered an internal error» su
  `page.reload()`, senza asserzione dell'app: è il motore.

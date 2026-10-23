# D2 · Webview leggera: a riposo non consuma, col tempo non cresce

Regole comuni: `tracks/_comuni.md`. Dipende da D0, che porta la misura della webview.

**GOAL.**
- Con l'app in background la CPU media sta sotto il 2%.
- La memoria della webview resta sotto 600 MB dopo 30 minuti d'uso.
- Niente cresce col tempo.

## Da dove si parte

- **Webview del desktop, 14/10:**
  - da 0,6 a 1,7 GB in 7,5 minuti;
  - CPU media al 28% con l'app in background (15 campioni).
- **Bundle iniziale:**
  - 1,7 MB di JavaScript, 544 KB compressi;
  - 152 file JS nella build, 8,0 MB.
- **I cancelli ci sono ma non hanno visto la crescita.** `check:growth` e
  `tests/e2e/idle-frame-budget.spec.ts` girano su uno scenario che non ha quello che ha la
  produzione: pane browser, 22 sessioni esterne, board in streaming.

## Cosa si fa

1. **Trovare cosa cresce.**
   - Due heap snapshot dell'app vera, presi con il Web Inspector di Safari sulla WKWebView, a 1 e a
     10 minuti, poi il confronto per costruttore.
   - Il colpevole diventa uno scenario di `check:growth`, così non torna.
2. **In background si dorme.**
   - Con `document.hidden` si fermano polling, timer e animazioni che non servono.
   - L'elenco dei timer attivi si misura, non si indovina.
3. **Liste virtualizzate dove non lo sono:** transcript, board ed elenco delle sessioni.
   - Il riferimento è il budget che Maestro dichiara: meno di 5.000 nodi DOM a riposo
     (`docs/competitors/maestro.md`).
4. **Streaming a frame.** Un solo render per frame per chat, non uno per chunk.
5. **Bundle.** Il chunk eager scende; il ratchet è `check:bundle`.

## Barra

```bash
bun run check:growth            # con lo scenario nuovo: rosso prima del fix, verde dopo
bun run build:client && bun run check:bundle   # entry_eager compresso ≤ 400 KB (oggi 544 KB)
scripts/measure-webview.sh      # sul Mac: CPU media ≤ 2% in background; memoria ≤ 600 MB a 30 minuti
```

- **e2e nodi DOM.** Con 2.000 messaggi in un transcript, i nodi DOM a riposo sono ≤ 5.000.
- **Mutazione.** In una copia si toglie la virtualizzazione del transcript: l'e2e dei nodi deve
  fallire.
- **Prova.** Il video dell'e2e con 2.000 messaggi: scorrimento fluido, `check:scroll-fluidity`
  invariato o migliore.

## Fuori

- Riscrivere la UI o cambiare framework: il costo è cosa si rende e cosa arriva dal socket, non
  React.
- Le pane browser: il loro costo è in D4.

# Tasks — tab-is-the-chrome

## Tornata 1 — lo stato di focus esiste, accanto a quello che c'e'
- [ ] `BrowserTabChrome`: stato `focused` sulla tab attiva, con input indirizzo
      modificabile (submit = naviga, Escape = torna ad attiva senza navigare).
- [ ] Prova E2E: focus sulla tab → input presente e a fuoco; Escape → torna al
      titolo. Falsificala togliendo lo stato: deve diventare rossa.
- [ ] La barra dei suggerimenti dentro l'input (storico della pane + storico
      globale dei siti, gli stessi due elenchi che oggi alimentano la toolbar).

## Tornata 2 — i comandi migrano dal popover alla tab
- [ ] Modifica indirizzo, torna allo spawner, console, download, devtools,
      zoom, device/UA: dallo stato di focus, non da `browser-tab-menu`.
- [ ] `DownloadsMenu` ancorato alla tab invece che alla riga: oggi un download
      che parte RIVELA la riga, e quella e' una delle vie per cui resta accesa.
- [ ] Prove: ogni comando raggiungibile dalla tab, con i testid esistenti dove
      possibile (il perimetro dei testid si ENUMERA, non si sceglie a memoria).

## Tornata 3 — la riga si cancella
- [ ] Rimuovere `<BrowserToolbar>` dai tre rami di `RemoteBrowserPanel`
      (nativo `:527`, iframe `:1031`, streaming `:1134`).
- [ ] Rimuovere `BrowserToolbar.tsx`.
- [ ] Ridurre `useBrowserChromeBridge` a cio' che resta (console/download) e
      togliere `showChrome`/`revealed`/`hideChrome`/`revealAddress`.
- [ ] Rimuovere `browser-tab-menu` da `BrowserTabChrome`.
- [ ] `check:deadcode` verde senza eccezioni nuove.

## Tornata 4 — le prove cambiano bersaglio
- [ ] `tests/e2e/browser-tab-chrome.spec.ts`: le asserzioni sulla riga nascosta
      diventano asserzioni sui tre stati della tab.
- [ ] Coprire il ramo `browser:force-open`, oggi scoperto: una pane aperta da
      un agente deve arrivare con il titolo sulla tab e nessuna riga.
- [ ] Misurare i 40px restituiti alla pagina su tutti e tre i rami.

## Cancelli
- [ ] `bun run typecheck` · `bun run lint` · cancelli statici · `test:unit`
- [ ] E2E del perimetro enumerato dai testid toccati, non a memoria

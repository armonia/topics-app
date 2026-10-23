# D4d · host nativo al riavvio, liveness e navigazione

## Barra

**Prima:** `git status --short --branch` pulito su `daily/d4d-host-lifecycle`; `bun --version` 1.4.2. I test B4-B6 non esistevano. Baseline completa `qa-gate --veloce` non rilevata prima delle modifiche.

**Dopo:** `bun test` sui 10 file server/client toccati: 89 pass, 0 fail (exit 0). `bun run typecheck`: exit 0, inclusi `typecheck:e2e`; `./scripts/qa-gate.sh --veloce`: exit 0, `BARRA VERDE`.

## Fatto

- B4: il viewer manda `host=native` dopo un `render_mode` nativo; il server attende 10 s, tiene l'ultimo render/resize/nav, scarta input e focus, e non avvia screencast mentre aspetta. Test a orologio finto copre host al secondo 3, timeout, hint assente e host già visto. `server/browser-host-boot-race.test.ts`: incluso nei 89 verdi.
- B5: ping applicativo ogni 5 s; dopo un pong il timeout è 15 s esatti. Il test integrato avanza l'orologio finto e verifica entro 16 s `host_away`, ritiro dell'host e close 1001; il reaper a 90 s ritira il mirror. `server/browser-native-host-liveness.test.ts`, `server/browser-socket-reaper.test.ts` e `client/src/hooks/nativeExecutorSocket.test.ts`: verdi.
- B6: al ritorno dopo il fallback, l'URL Chromium HTTP(S) diverso diventa `host_nav` e nav viewer prima della distruzione. Caso aggiunto a `server/browser-host-mirror.test.ts`: verde.
- Contratto condiviso e requisiti `NATIVE-HOST-06..08` con `@covers`. `check:spec-coverage`: 0 scoperti, 0 ambigui, 0 penzolanti.
- Mutazioni in copie temporanee: attesa B4 disabilitata → test rosso (exit 1); timeout B5 portato a 90 s → test rosso (exit 1); inoltro B6 rimosso → test rosso (exit 1).
- Review indipendente: gap B5 iniziale chiuso dal test integrato; nessun difetto sostanziale rilevato.

## Trovato e non fatto

- Nessun video E2E della traccia: le e2e non girano sul Mac secondo il brief; `typecheck:e2e` è verde. Per il video serve il workflow CI «Clip di consegna» dopo il push, che resta al proprietario.

## Rifiutato

- Nessun falso allarme trovato. Il ping WebSocket di protocollo non prova che il JavaScript della pane risponda: il caso W7 era reale.

## Revisione (chi non ha scritto il codice)

- **Rigirato tutto da capo.** 90 test della traccia verdi; 6 mutanti in una copia usa e getta, 6 rossi, ognuno sul suo test: attesa di B4 tolta (2 rossi in `browser-host-boot-race.test.ts`), soglia di B5 a 90 s, inoltro di B6 tolto, `host_away` tolto, `onClose` tolto dal mietitore, `host_pong` tolto dalla pane.
- **Corretto.**
  - La `nav` tenuta durante l'attesa partiva con un `void` senza `catch`: un Chromium che non parte era un rifiuto non gestito, e la pane non sentiva né la risposta né l'errore. Ora la navigazione del viewer è una funzione sola (`server/browser-viewer-actions.ts`), usata dal percorso normale e dalla fine dell'attesa; lì sta anche il ritorno al video, che era copiato due volte.
  - Il timer di 250 ms poteva avviare lo screencast una seconda volta dopo un `set_stream: true` arrivato nella finestra: due sessioni CDP sulla stessa pagina. Ora salta se è già partito.
  - Un host perso (ping o mietitore) passava due volte da `hostMirror.onClose`: la seconda, dall'evento `close`, lo trattava da viewer e toglieva il dispositivo del Mac dal viewport. Ora `onClose` vale una volta per socket.
  - `host_away` partiva anche a condivisione spenta, dove il ripiego non c'è e la riga «la pagina continua sul server» non era vera: ora solo a condivisione accesa.
  - `server.ts` passava il tetto di `check:bloat` (7.010 righe contro 7.007): le due azioni del viewer sono uscite in un modulo, ora 6.989. Il resize del viewer ha una porta sola (`resizeFromViewer`), come chiede `browser-viewport-one-door`.
  - I tre messaggi nuovi entrano nei test che congelano il protocollo (`tests/unit/ws-contract.test.ts`, `tests/unit/browser-ws-messages.test.ts`: 29 varianti).
- **Prova del comportamento:** e2e nuova `tests/e2e/browser-host-away.spec.ts`. Il finto Mac di `native-host-page.ts` ora risponde ai `host_ping` come la pane vera e si può congelare con la socket aperta: il viewer deve mostrare «Il Mac non risponde» entro 17 s dal congelamento. La gira la CI con la clip.
- **Barra dopo la revisione:** `bun test server/browser*` e i test client del browser, 482 test, 0 rossi; typecheck, lint e 20 `check:*` verdi; `bun test ./tests/unit` senza rossi oltre i due d'ambiente noti.

### Trovato e non fatto (revisione)

- Durante gli 8 s di grazia dopo che l'host se ne va, una `nav` del viewer accende Chromium e naviga; se l'host torna prima del ripiego, quella navigazione si perde (B6 copre solo il ripiego scattato). Raro: serve un tocco proprio in quegli 8 s.
- B4 non ha una e2e: chiederebbe un riavvio del server di prova con un host e un viewer collegati. È coperto dai test a orologio finto sul modulo; il cablaggio in `server.ts` è letto, non eseguito.

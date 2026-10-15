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

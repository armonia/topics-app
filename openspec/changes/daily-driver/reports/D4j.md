# D4j — B12: potatura WebRTC e pipeline rrweb

## Barra prima

- `bun run check:spec-coverage`: exit 0; 1277/1277 requisiti dichiarati coperti, 0 scoperti, 0 penzolanti.
- Working tree pulito su `daily/d4j-browser-prune`, base coincidente con `origin/main` (`0ba4ada`). Gli altri cancelli non erano stati eseguiti prima della prima modifica.

## Barra dopo

- `bun test server/lib/rrweb-recorder.test.ts client/src/lib/browserWebrtcLog.test.ts`: exit 0; 3 pass, 0 fail.
- `bun run check:spec-coverage`: exit 0; 1279/1279 coperti, 0 scoperti, 0 ambigui, 0 penzolanti.
- `bun run check:identifier-language`: exit 0; 5382 nomi, 0 nuovi fuori baseline.
- `bun run check:untraced-tests`: exit 0; 0 file senza dichiarazione.
- `bun run typecheck` e `bun run typecheck:e2e`: exit 0.
- `./scripts/qa-gate.sh --veloce`: exit 0; 22 check statici, `check:deadcode-blindspots`, typecheck e lint verdi.
- `cargo check` in `desktop-tauri/src-tauri`: exit 0, 60 s; i tre stub che il workflow CI crea per i sidecar sono stati tolti a fine prova.
- `git diff --check`: exit 0.

## Fatto

- **WebRTC conservato.** Il percorso è vivo: `client/src/components/Shared/tabSheetControls.tsx:239` espone il cambio DOM/video; `client/src/components/Browser/RemoteBrowserPanel.tsx:915` lo offre solo per pagina reale condivisa non nativa; `client/src/hooks/useRemoteBrowser.ts:1175` invia l'offerta video e `:919-929` gestisce answer/ICE. La pane nativa è esclusa a `RemoteBrowserPanel.tsx:957`; il mirror DOM non negozia WebRTC (`useRemoteBrowser.ts:1335-1339`).
- Il server tratta l'offerta sul target CDP in `server.ts:4677-4710`; Tauri imposta `TOPICS_WEBRTC_BRIDGE_BIN` quando avvia il proprio server bundled (`desktop-tauri/src-tauri/src/lib.rs:1944`). Lì il bridge c'è, e il modo video funziona.
- Aggiunti log client a offerta, connessione ICE e ripiego dopo i tentativi esauriti, con test delle tre righe e dei rispettivi punti di chiamata.
- Le due letture del recorder ora usano `server/lib/rrweb-recorder.ts`, con cache unica. Il test confronta il file servito con la build rrweb installata e verifica manifest contro lockfile; il caso di versione discordante è coperto.
- Aggiunti `WEBRTC-02` e `BROWSER-DOM-RECORDER-01` in `openspec/specs/remote-browser/spec.md`, coperti dai test.
- Righe tolte/spostate: `server/routes/` 12 righe di cache duplicate rimosse; `openspec/changes/` 327 righe della change superata spostate in `openspec/changes/archive/2026-10-15-browser-native-host-cobrowse/`. Nessun ramo WebRTC rimosso.
- Baseline prima delle modifiche: `check:spec-coverage` exit 0, 1277/1277.

## In revisione

- Le tre righe del client finiscono nella console del viewer, che nessuno legge: il dato «0 righe
  webrtc nel log del server in 6,5 giorni» contava solo i fallimenti, perché un'offerta riuscita o
  ignorata (bridge assente) non scriveva niente. Ora il server scrive una riga per ogni offerta, con
  lo stato del bridge.
- Tolto il test che cambiava la versione dentro sé stesso: la prova è una mutazione vera. Con
  `rrweb` a `2.0.0-alpha.5` in una copia di `client/package.json` il test resta rosso
  (`rrweb version mismatch`).
- I requisiti nuovi sono scritti in inglese, come il resto di `remote-browser/spec.md`.

## Trovato e non fatto

- La change `browser-native-host-cobrowse` lascia aperti: wiring MVP `takeSnapshot`→JPEG; bridge producer device-side e harness; routing offerta al producer device; cattura ScreenCaptureKit e permessi; input back-channel; election host/promote-demote e relativi test. Tutta la Fase 2 (trasporto/input follower), Fase 3 (portabilità/sync) e Fase 4 (superficie browser) sono backlog aperto. Restano anche rebuild/relaunch Tauri gated quando si cambia `lib.rs` e la rivalutazione del seam BiDi.
- Nessun taglio dei requisiti WebRTC in `openspec/specs/remote-browser/spec.md`: il trasporto resta accessibile nel modo video delle pane condivise.
- E2E browser/co-browse: non eseguite; il Mac le vieta e il brief vieta commit/push, quindi manca una CI sul diff corrente.

## Rifiutato

- WebRTC non è codice irraggiungibile: il selettore DOM/video lo attiva sulle pane condivise con URL reale. Il dato «0 righe webrtc nei log produzione per 6,5 giorni» misura il mancato uso recente, non l'assenza del percorso. Togliere il bridge romperebbe il modo video esplicito.
- La pane nativa e il mirror DOM non usano WebRTC; questo non esclude la pane condivisa in modalità video.

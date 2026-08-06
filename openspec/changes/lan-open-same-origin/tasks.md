# Tasks: lan-open-same-origin

Ogni task porta la sua verifica. La change è completa solo quando ogni casella è
spuntata **e** la prova di consegna (§6) esiste come evidenza durevole. Lavorare su
un branch da `main`. Ordine dei commit: 1 → 3 → 2 → 4 → 5 (vedi `design.md §5`).

## 1. Server — un solo asse (LAN-OPEN-01, LAN-OPEN-02)

- [ ] 1.1 `server/lib/auth-gate.ts`: `AuthInput` perde `ip`, `token`, `expectedToken`
  e guadagna `host: string | null`. Cancellare il ramo trasporto (`:155-162`) e
  `tokenMatches` (`:131-137`) con l'import `timingSafeEqual` — che si **sposta** su
  `server.ts` per il task 1.5, non sparisce. **Verifica:** `bun test` — nessun caso
  residuo cita un token.
- [ ] 1.2 Sostituire `isLocalOrigin` con `canonHost` + `isSameSite(origin, host)`
  secondo `design.md §2`. L'export vecchio sparisce (nessun consumatore fuori dal
  test). **Verifica:** unit — le sei righe della matrice `design.md §7` che riguardano
  hostname diversi con porte diverse.
- [ ] 1.3 `evaluateAuth` implementa l'ordine di `design.md §1`: le richieste non
  mutanti e non-WS escono ad `allow` prima del check d'origine; `Origin` assente →
  allow; `Origin: null` → 403. **Verifica:** unit — tutte e nove le righe di
  `design.md §7`.
- [ ] 1.4 `resolveAllowedOrigins` (`:120-129`): togliere `allowedOriginsCache`. Una
  cache al primo uso è una trappola — cambiare la env a caldo non ha effetto — e ora
  quella variabile diventa la manopola vera per un hostname di tunnel. **Verifica:**
  unit — due letture con env diverse danno risultati diversi.
- [ ] 1.5 `server.ts:1451-1458` (`/__daemon/*`): aggiungere
  `isLoopbackAddress(server.requestIP(req)?.address)` — il commento a `:1448` lo
  promette già e il codice non lo fa — e sostituire `token !== fresh.token` con un
  confronto timing-safe. **Verifica:** `curl` da `127.0.0.1` con token valido → 200;
  la stessa richiesta dall'IP LAN → 401 **prima** di guardare il token.
- [ ] 1.6 `server.ts:1514-1540` (call site): via `server.requestIP`, via le tre
  letture del token, via `readState()`. Passare `host: req.headers.get("host")`.
  A `:1535` il body diventa `code: "forbidden"` (oggi è `"unauthorized"` fisso anche
  sul 403, e il client lo lega al cartello «non appaiato»). **Verifica:** integrazione
  — POST cross-origin → 403 con `code: "forbidden"`.
- [ ] 1.7 Rinominare `isAuthGatedPath` → `isOriginGatedPath` (dopo la modifica il
  nome «auth» mente); elenco dei prefissi invariato. Riscrivere per intero il blocco
  di commento `auth-gate.ts:1-24` e `server.ts:1502-1513`, che descrivono un modello
  che non esiste più. Correggere nello stesso passaggio la bugia `~/.topics/media`
  (l'handler a `server.ts:1679` legge `~/.openclaw/media`), ripetuta in
  `auth-gate.ts:65-66`. **Verifica:** `bun run typecheck` + rilettura.
- [ ] 1.8 `corsAllowOrigin` (`server.ts:1379-1385`): **non toccare il codice**,
  aggiungere il commento che dichiara perché quell'assenza è ciò che protegge le GET.
  **Verifica:** il test 5.4 lo pinna.

## 2. Client — il pairing sparisce (LAN-OPEN-01)

- [ ] 2.1 Cancellare `client/src/lib/shell/pairing.ts` (138 righe) e
  `client/src/lib/shell/pairing.test.ts` (17 casi). **Verifica:** `bun run check:deadcode`
  non segnala orfani; `grep -r pairing client/src` → zero.
- [ ] 2.2 `client/src/main.tsx`: via l'import `:12` e la chiamata `:18`.
  `client/src/lib/api.ts`: via l'import `:25`, `withTokenHeader({...})` a `:45` →
  oggetto headers nudo, via `markPairingRequired`/`clearPairingRequired` (`:58-59`) e
  il commento `:54-57`. **Verifica:** unit — una fetch non porta più header di token.
- [ ] 2.3 `client/src/hooks/useWebSocket.ts`: via l'import `:8`; `:106` →
  `` new WebSocket(`${serverWsBase()}/ws`) ``. **Verifica:** unit — l'URL del WS non
  ha più `?token=`.
- [ ] 2.4 `client/src/lib/shell/net.ts`: il gate `:79` torna `if (!isTauri) return;`;
  via `withTokenHeader` da `:89`/`:95` e `withTokenQuery` da `:111`; riscrivere il
  blocco di commento `:40-73`, oggi tutto sul token. **`installNetShim` NON si
  rimuove**: senza, le 86 fetch relative del guscio Tauri risolvono contro
  `tauri://localhost` e l'app smette di parlare col server. Scrivere nel commento che
  è il punto d'innesto dell'header di sessione futuro. **Verifica:** smoke desktop
  (task 6.2).
- [ ] 2.5 `client/src/components/Sidebar/SidebarStatusBar.tsx`: via l'import `:4`, lo
  stato `:133`, il ramo `:497-499` e il commento `:494-496`. Restano
  `Connecting…` / `Reconnecting…` / `Offline`. **Verifica:** rilettura + build.
- [ ] 2.6 **Verificare, non modificare**, che si siano sanati da soli: i due WS nudi
  (`SingleTerminalPane.tsx:476`, `useRemoteBrowser.ts:447-450`); i `sendBeacon`
  (`syncServer.ts:274-275`, `projectLayoutSync.ts:288-290`); le `<img>`/`<video>` da
  `getMediaUrl` (`api.ts:358-366`) in `TaskDetail.tsx:1629,1818`,
  `PreviewMedia.tsx:93`, `MessageContent.tsx:238,257,378,391` e
  `ProjectFavicon.tsx:174`. **Verifica:** dal telefono, terminale che risponde +
  favicon di progetto visibili — è metà del valore di questa fase.

## 3. Superficie online — il tailnet, non Internet (LAN-OPEN-03)

- [ ] 3.1 `server/routes/remote.ts:66`: rimuovere `tailscale funnel --bg 443`,
  tenere `serve` (tailnet-only: identità per-nodo, ACL, revoca). **Verifica:**
  `grep funnel server/routes/remote.ts` → zero.
- [ ] 3.2 `:65`: target `http://localhost:3333` → `https+insecure://localhost:3333`.
  Oggi parla HTTP in chiaro contro un listener TLS, **quindi il tunnel non è mai
  salito**. **Verifica:** `tailscale serve status` mostra la mappatura attiva.
- [ ] 3.3 `:34`: `isActive` legge `TCP["3333"]` e `Web["https://"]`, due chiavi che
  `tailscale serve status --json` non emette mai. Riscrivere su `Web[<host>:443]`.
  **Verifica:** il pannello passa a «attivo» con `serve` su, a «inattivo» con `serve` giù.
- [ ] 3.4 `:44`: `url: 'Check cloudflared logs'` finisce in un `href`
  (`RemoteAccessPanel.tsx:116`): rimuovere il ramo o restituire `url: null`.
  **Verifica:** nessun `href` con testo in prosa.
- [ ] 3.5 `RemoteAccessPanel.tsx`: togliere `'funnel'` dal linguaggio e il tipo morto
  `'localtunnel'` dall'union `:7`; l'etichetta diventa «Esponi sul tailnet».
  **Verifica:** screenshot del pannello nei due stati.

## 4. Test

- [ ] 4.1 `server/lib/auth-gate.test.ts` — **cancellare 6**: `:141`, `:154`, `:159`,
  `:163`, `:186`, `:191` (tutti asseriscono un 401 che non esisterà).
- [ ] 4.2 **Invertire di segno 4** — i più importanti: `:171`, `:176`, `:181`
  (remote + token valido + origine forestiera ⇒ oggi `allow`) → **403**; `:150`
  (`remote with the valid token → allow`) → `remote GET senza Origin → allow`.
- [ ] 4.3 **Mantenere invariati** i 4 casi CSRF + il kill-switch: `:101`, `:115`,
  `:124`, `:136`, `:201`. **Verifica:** restano verdi senza modifiche — è la prova che
  la fiducia loopback non è cambiata.
- [ ] 4.4 Rinominare il describe `auth-gate · isLocalOrigin` (`:80`) →
  `auth-gate · isSameSite`, riscrivendo i suoi 2 casi su coppie `(origin, host)`.
- [ ] 4.5 **Aggiungere gli 8 casi** della matrice `design.md §7` non ancora coperti,
  più `resolveAllowedOrigins` senza cache. **Verifica:** ogni riga della tabella ha un
  test che la nomina.
- [ ] 4.6 `client/src/lib/shell/net.test.ts` — 3 casi: `:83` («con un token
  memorizzato si installa anche fuori da Tauri») → **«sotto Tauri riscrive l'URL su
  `serverHttpBase` e preserva `X-Client-Id` e `Content-Type` del callsite»** (nota:
  sotto `bun test` `isTauri` è falso e va simulato — oggi il ramo Tauri non è coperto
  da nessuno dei tre); `:106` → «fuori da Tauri non si installa»; `:118` invariato.
- [ ] 4.7 Nuovo `tests/e2e/lan-same-origin.spec.ts` — l'unico presidio automatico che
  nasce da questo lavoro: (1) POST `/api/topics` con `Origin: https://evil.example`
  → 403; (2) upgrade `/ws` con origine forestiera → 403; (3) gli stessi due con
  `Origin` = `Host` → 200 / 101; (4) GET `/api/topics` senza token e senza Origin
  → 200, cioè nessun 401 sopravvive; (5) **il pin del CORS**: GET con origine
  forestiera → risposta **senza** `Access-Control-Allow-Origin`.
- [ ] 4.8 `tests/e2e/cloud-session-server.spec.ts:29-40`: l'helper `captureFrames`
  esiste per aggirare il 403 su `Origin: null` da `about:blank`. Con la regola nuova
  quel 403 **resta corretto**: non cambia il codice, cambia **solo il commento**, che
  oggi parla del gate CSRF loopback.
- [ ] 4.9 Prendere atto per iscritto che **il resto della suite E2E non produrrà
  rossi**: gira su `http://localhost:13334` con Origin coerente col Host, nessuna spec
  asserisce un 401/403 del gate, nessuna manda `x-topics-token`. La suite non ti
  fermerà e non ti confermerà nulla. **Verifica:** letta dagli artifacts, non
  dall'exit code.

## 5. Documentazione e ritiro della change vecchia

- [ ] 5.1 `SECURITY.md:19` — dichiara IN SCOPE «anything that lets a local-network
  attacker read/modify your data or execute code», cioè si impegna a trattare come
  vulnerabilità il comportamento che stiamo rendendo il default. Riscrivere **nello
  stesso commit del codice**. **Verifica:** il testo nuovo descrive il modello reale.
- [ ] 5.2 `SECURITY.md:14`, `README.md:108,110`, `PRIVACY.md:26`: la clausola «no
  built-in authentication» torna vera. La gemella «bound to localhost» resta
  **falsa** (`server.ts:1423` bind `"::"`, e il commento a `:1420` promette un
  `SERVER_HOST=0.0.0.0` che nessun launcher imposta): correggerla qui.
- [ ] 5.3 `docs/ENV.md:52`: `TOPICS_AUTH_OFF` cambia semantica (ora spegne il solo
  CSRF); documentare `TOPICS_ALLOWED_ORIGINS`, che da variabile irraggiungibile
  diventa una manopola vera.
- [ ] 5.4 **Ritirare `openspec/changes/lan-pwa-pairing-token/`** esplicitamente:
  descrive un meccanismo che non esisterà, e lasciarla aperta significa che il
  prossimo agente lo reimplementa. Le sue caselle 5.1/5.2 sono già scritte giuste e
  diventano i task 6.1/6.2 qui sotto.

## 6. Prova di consegna

Nessuno di questi punti è dimostrabile da un test automatico esistente. L'evidenza
richiesta è un **video**, non uno screenshot: qui quasi tutto è comportamento.

- [ ] 6.1 Telefono su `https://<host>:3333` **senza `?token=`**: chat che streamma dal
  vivo, terminale che risponde a un comando, drag di una card sulla board, anteprima
  di un task che si vede. → `.webm` sotto `~/.topics/media/`
- [ ] 6.2 Desktop Tauri: relaunch, l'app parla col server, il sync del layout
  persiste. → `.webm`
- [ ] 6.3 Il 403 dimostrato: da una console su un'altra origine,
  `fetch('https://<host>:3333/api/topics', {method:'POST'})` → 403
  `cross-site origin blocked`; e la GET cross-origin **senza**
  `Access-Control-Allow-Origin`. → screenshot della console
- [ ] 6.4 `bun test server/lib/auth-gate.test.ts client/src/lib/shell/net.test.ts`
  verde, col conteggio prima/dopo.
- [ ] 6.5 Suite E2E verde **letta dagli artifacts**.

## 7. Fuori da questa change → backlog (task top-level, non subtask)

Reperti misurati durante l'audit del 2026-08-06 che non appartengono a questo lavoro
ma non vanno persi:

1. **`/preview/` è un file-server su path assoluti** (`server.ts:1712-1724`): unico
   controllo, «il path è canonico». Verificato: `GET /preview/etc/hosts` → 200 col
   contenuto. Sulla LAN aperta significa `~/.ssh/id_rsa`, `data/topics.db` e
   `~/.topics/daemon-state.json`. Fix strutturale: adottare `resolveSafePath`
   (`server/utils.ts:1312`, **0 chiamanti oggi**) con basi consentite.
2. **`resolveProjectPath` non è una sandbox** (`server/utils.ts:1332-1341`: espande
   `~`, `resolve()`, ritorna) ed è l'unico filtro su **43 call site** in
   `server/routes/files.ts`, inclusi `writeFileSync` (`:263`) e `rm -rf` (`:796`).
   Numero identico all'audit del 19 giugno: fermo da sette settimane.
3. **Certificato via `tailscale cert`** + `scripts/refresh-tailscale-cert.sh` +
   launchd settimanale (`design.md §6`). Sblocca la PWA installabile.
4. **PWA**: `boot.js:67-69` registra il service worker solo su `localhost` o
   `*.trycloudflare.com`, e il ramo else **de-registra e svuota le cache**.
   Allargarlo ha senso solo insieme a (3).
5. **La diagnosi vive in un cassetto chiuso**: sul telefono la sidebar parte
   collassata (`useSidebarAndLayout.ts:167-170`) e ogni messaggio di stato è fuori
   schermo; l'empty state visibile (`PanelGrid.tsx:2532-2535`) invita a un gesto che
   non risolve. Serve un banner fuori dalla sidebar per `wsStatus !== 'connected'`
   prolungato.
6. **Griglia top-level su <768px** (`PanelGrid.tsx:2629-2671`): N pannelli = N fasce
   a `flex: 1 1 0%`, divisori nascosti, nessun cap. Con 3 chat aperte sono strisce da
   ~200px. Il progetto invece si appiattisce correttamente
   (`GroupLayout.tsx:1036`).
7. **Playwright non emula mai un telefono** (`playwright.config.ts:117-122`, viewport
   1280×800, zero `hasTouch`): barra tasti del terminale, long-press delle tab,
   `TouchSensor` del board, touch di DomCoBrowse, `touchScroll` — codice mai eseguito
   in CI. E nessun test fa boot a viewport telefono (`helpers.ts:43` aspetta la
   sidebar visibile).
8. **Sei definizioni concorrenti di `isMobile`** + tre di `isTouchDevice` (una su
   user-agent, `SingleTerminalPane.tsx:34`).
9. **Modali senza ramo mobile**: `GlobalSettings.tsx:67` + rail `w-[180px]` a `:83` →
   178px di contenuto su 390px di schermo. Zero breakpoint in tutto il file.
10. **Detection TLS duplicata**: `server.ts:1358` e `claude-code.ts:266-270`
    ricalcolano lo stesso fatto da path diversi; un disallineamento uccide ogni tool
    MCP di ogni sessione (lo dice il commento a `:259-262`).
11. **`client/certs/`**: secondo albero di certificati per il dev server Vite, SAN di
    marzo, scadenza 2036, zero automazione.
12. **DNS rebinding** — mitigazione da valutare: accettare come `Host` solo
    IP-literal, `*.local`, `*.ts.net`, `localhost`. Vite lo fa già
    (`client/vite.config.ts:144`).
13. **Nessuna revoca per dispositivo.** Prima si poteva ruotare il token; dopo,
    l'unica leva è la rete. È la prima cosa che l'auth centralizzata deve restituire.

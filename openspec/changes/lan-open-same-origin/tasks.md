# Tasks: lan-open-same-origin

Ogni task porta la sua verifica. La change è completa solo quando ogni casella è
spuntata **e** la prova di consegna (§6) esiste come evidenza durevole. Lavorare su
un branch da `main`. Ordine dei commit: 1 → 3 → 2 → 4 → 5 (vedi `design.md §5`).

## 1. Server — un solo asse (LAN-OPEN-01, LAN-OPEN-02)

- [x] 1.1 `server/lib/auth-gate.ts`: `AuthInput` perde `ip`, `token`, `expectedToken`
  e guadagna `host: string | null`. Cancellare il ramo trasporto (`:155-162`) e
  `tokenMatches` (`:131-137`) con l'import `timingSafeEqual` — che si **sposta** su
  `server.ts` per il task 1.5, non sparisce. **Verifica:** `bun test` — nessun caso
  residuo cita un token.
- [x] 1.2 Sostituire `isLocalOrigin` con `canonHost` + `isSameSite(origin, host)`
  secondo `design.md §2`. L'export vecchio sparisce (nessun consumatore fuori dal
  test). **Verifica:** unit — le sei righe della matrice `design.md §7` che riguardano
  hostname diversi con porte diverse.
- [x] 1.3 `evaluateAuth` implementa l'ordine di `design.md §1`: le richieste non
  mutanti e non-WS escono ad `allow` prima del check d'origine; `Origin` assente →
  allow; `Origin: null` → 403. **Verifica:** unit — tutte e nove le righe di
  `design.md §7`.
- [x] 1.4 `resolveAllowedOrigins` (`:120-129`): togliere `allowedOriginsCache`. Una
  cache al primo uso è una trappola — cambiare la env a caldo non ha effetto — e ora
  quella variabile diventa la manopola vera per un hostname di tunnel. **Verifica:**
  unit — due letture con env diverse danno risultati diversi.
- [x] 1.5 `server.ts:1451-1458` (`/__daemon/*`): aggiungere
  `isLoopbackAddress(server.requestIP(req)?.address)` — il commento a `:1448` lo
  promette già e il codice non lo fa — e sostituire `token !== fresh.token` con un
  confronto timing-safe. **Verifica:** `curl` da `127.0.0.1` con token valido → 200;
  la stessa richiesta dall'IP LAN → 401 **prima** di guardare il token.
- [x] 1.6 `server.ts:1514-1540` (call site): via `server.requestIP`, via le tre
  letture del token, via `readState()`. Passare `host: req.headers.get("host")`.
  A `:1535` il body diventa `code: "forbidden"` (oggi è `"unauthorized"` fisso anche
  sul 403, e il client lo lega al cartello «non appaiato»). **Verifica:** integrazione
  — POST cross-origin → 403 con `code: "forbidden"`.
- [x] 1.7 Rinominare `isAuthGatedPath` → `isOriginGatedPath` (dopo la modifica il
  nome «auth» mente); elenco dei prefissi invariato. Riscrivere per intero il blocco
  di commento `auth-gate.ts:1-24` e `server.ts:1502-1513`, che descrivono un modello
  che non esiste più. Correggere nello stesso passaggio la bugia `~/.topics/media`
  (l'handler a `server.ts:1679` legge `~/.openclaw/media`), ripetuta in
  `auth-gate.ts:65-66`. **Verifica:** `bun run typecheck` + rilettura.
- [x] 1.8 `corsAllowOrigin` (`server.ts:1379-1385`): **non toccare il codice**,
  aggiungere il commento che dichiara perché quell'assenza è ciò che protegge le GET.
  **Verifica:** il test 5.4 lo pinna.

## 2. Client — il pairing sparisce (LAN-OPEN-01)

- [x] 2.1 Cancellare `client/src/lib/shell/pairing.ts` (138 righe) e
  `client/src/lib/shell/pairing.test.ts` (17 casi). **Verifica:** `bun run check:deadcode`
  non segnala orfani; `grep -r pairing client/src` → zero.
- [x] 2.2 `client/src/main.tsx`: via l'import `:12` e la chiamata `:18`.
  `client/src/lib/api.ts`: via l'import `:25`, `withTokenHeader({...})` a `:45` →
  oggetto headers nudo, via `markPairingRequired`/`clearPairingRequired` (`:58-59`) e
  il commento `:54-57`. **Verifica:** unit — una fetch non porta più header di token.
- [x] 2.3 `client/src/hooks/useWebSocket.ts`: via l'import `:8`; `:106` →
  `` new WebSocket(`${serverWsBase()}/ws`) ``. **Verifica:** unit — l'URL del WS non
  ha più `?token=`.
- [x] 2.4 `client/src/lib/shell/net.ts`: il gate `:79` torna `if (!isTauri) return;`;
  via `withTokenHeader` da `:89`/`:95` e `withTokenQuery` da `:111`; riscrivere il
  blocco di commento `:40-73`, oggi tutto sul token. **`installNetShim` NON si
  rimuove**: senza, le 86 fetch relative del guscio Tauri risolvono contro
  `tauri://localhost` e l'app smette di parlare col server. Scrivere nel commento che
  è il punto d'innesto dell'header di sessione futuro. **Verifica:** smoke desktop
  (task 6.2).
- [x] 2.5 `client/src/components/Sidebar/SidebarStatusBar.tsx`: via l'import `:4`, lo
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

- [x] 3.1 `server/routes/remote.ts:66`: rimuovere `tailscale funnel --bg 443`,
  tenere `serve` (tailnet-only: identità per-nodo, ACL, revoca). **Verifica:**
  `grep funnel server/routes/remote.ts` → zero.
- [x] 3.2 `:65`: target `http://localhost:3333` → `https+insecure://localhost:3333`.
  Oggi parla HTTP in chiaro contro un listener TLS, **quindi il tunnel non è mai
  salito**. **Verifica:** `tailscale serve status` mostra la mappatura attiva.
- [x] 3.3 `:34`: `isActive` legge `TCP["3333"]` e `Web["https://"]`, due chiavi che
  `tailscale serve status --json` non emette mai. Riscrivere su `Web[<host>:443]`.
  **Verifica:** il pannello passa a «attivo» con `serve` su, a «inattivo» con `serve` giù.
- [x] 3.4 `:44`: `url: 'Check cloudflared logs'` finisce in un `href`
  (`RemoteAccessPanel.tsx:116`): rimuovere il ramo o restituire `url: null`.
  **Verifica:** nessun `href` con testo in prosa.
- [ ] 3.5 `RemoteAccessPanel.tsx`: togliere `'funnel'` dal linguaggio e il tipo morto
  `'localtunnel'` dall'union `:7`; l'etichetta diventa «Esponi sul tailnet».
  **Verifica:** screenshot del pannello nei due stati.

## 4. Test

- [x] 4.1 `server/lib/auth-gate.test.ts` — **cancellare 6**: `:141`, `:154`, `:159`,
  `:163`, `:186`, `:191` (tutti asseriscono un 401 che non esisterà).
- [x] 4.2 **Invertire di segno 4** — i più importanti: `:171`, `:176`, `:181`
  (remote + token valido + origine forestiera ⇒ oggi `allow`) → **403**; `:150`
  (`remote with the valid token → allow`) → `remote GET senza Origin → allow`.
- [x] 4.3 **Mantenere invariati** i 4 casi CSRF + il kill-switch: `:101`, `:115`,
  `:124`, `:136`, `:201`. **Verifica:** restano verdi senza modifiche — è la prova che
  la fiducia loopback non è cambiata.
- [x] 4.4 Rinominare il describe `auth-gate · isLocalOrigin` (`:80`) →
  `auth-gate · isSameSite`, riscrivendo i suoi 2 casi su coppie `(origin, host)`.
- [x] 4.5 **Aggiungere gli 8 casi** della matrice `design.md §7` non ancora coperti,
  più `resolveAllowedOrigins` senza cache. **Verifica:** ogni riga della tabella ha un
  test che la nomina.
- [x] 4.6 `client/src/lib/shell/net.test.ts` — 3 casi: `:83` («con un token
  memorizzato si installa anche fuori da Tauri») → **«sotto Tauri riscrive l'URL su
  `serverHttpBase` e preserva `X-Client-Id` e `Content-Type` del callsite»** (nota:
  sotto `bun test` `isTauri` è falso e va simulato — oggi il ramo Tauri non è coperto
  da nessuno dei tre); `:106` → «fuori da Tauri non si installa»; `:118` invariato.
- [x] 4.7 Nuovo `tests/e2e/lan-same-origin.spec.ts` — l'unico presidio automatico che
  nasce da questo lavoro: (1) POST `/api/topics` con `Origin: https://evil.example`
  → 403; (2) upgrade `/ws` con origine forestiera → 403; (3) gli stessi due con
  `Origin` = `Host` → 200 / 101; (4) GET `/api/topics` senza token e senza Origin
  → 200, cioè nessun 401 sopravvive; (5) **il pin del CORS**: GET con origine
  forestiera → risposta **senza** `Access-Control-Allow-Origin`.
- [x] 4.8 `tests/e2e/cloud-session-server.spec.ts:29-40`: l'helper `captureFrames`
  esiste per aggirare il 403 su `Origin: null` da `about:blank`. Con la regola nuova
  quel 403 **resta corretto**: non cambia il codice, cambia **solo il commento**, che
  oggi parla del gate CSRF loopback.
- [x] 4.9 Prendere atto per iscritto che **il resto della suite E2E non produrrà
  rossi**: gira su `http://localhost:13334` con Origin coerente col Host, nessuna spec
  asserisce un 401/403 del gate, nessuna manda `x-topics-token`. La suite non ti
  fermerà e non ti confermerà nulla. **Verifica:** letta dagli artifacts, non
  dall'exit code.

## 5. Documentazione e ritiro della change vecchia

- [x] 5.1 `SECURITY.md:19` — dichiara IN SCOPE «anything that lets a local-network
  attacker read/modify your data or execute code», cioè si impegna a trattare come
  vulnerabilità il comportamento che stiamo rendendo il default. Riscrivere **nello
  stesso commit del codice**. **Verifica:** il testo nuovo descrive il modello reale.
- [x] 5.2 `SECURITY.md:14`, `README.md:108,110`, `PRIVACY.md:26`: la clausola «no
  built-in authentication» torna vera. La gemella «bound to localhost» resta
  **falsa** (`server.ts:1423` bind `"::"`, e il commento a `:1420` promette un
  `SERVER_HOST=0.0.0.0` che nessun launcher imposta): correggerla qui.
- [x] 5.3 `docs/ENV.md:52`: `TOPICS_AUTH_OFF` cambia semantica (ora spegne il solo
  CSRF); documentare `TOPICS_ALLOWED_ORIGINS`, che da variabile irraggiungibile
  diventa una manopola vera.
- [x] 5.4 **Ritirare `openspec/changes/lan-pwa-pairing-token/`** esplicitamente:
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
- [x] 6.4 `bun test server/lib/auth-gate.test.ts client/src/lib/shell/net.test.ts`
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
3. **Certificato**: indirizzare al nome mDNS (`macbook-pro-di-attilio.local`, già
   nella SAN e immune al DHCP) invece che all'IP; installare `certs/ca-cert.pem` sul
   telefono quando servirà la PWA installabile (`design.md §6`). Debito separato:
   **non esiste nel working tree alcuno script che generi `certs/`** — è morto con
   l'archiviazione di Electron e va riscritto.
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

## 8. Stato al 2026-08-06

**Fatto e verificato**: fasi 1-5 complete. Il gate è sostituito, il pairing
rimosso, il funnel tolto, la documentazione riallineata, la change vecchia
ritirata in `archive/2026-08-06-lan-pwa-pairing-token/`.

Evidenza raccolta finora:
- `bun test server/lib/auth-gate.test.ts` → **38 pass** (erano 31).
- `bun test client/src/` → **1799 pass, 0 fail**.
- `bunx playwright test tests/e2e/lan-same-origin.spec.ts` → **6 pass**, col log
  del server che mostra `POST /api/topics — origin 403: cross-site origin blocked`.
- `scripts/typecheck-server.ts` → 0 errori (baseline 0). Client: 0 errori sui file
  toccati (i rossi in `Menu.tsx`/`addMenuItems.tsx` sono lavoro in volo di
  un'altra sessione, non di questa change).
- `bun test server/` → **2370 pass, 9 skip, 0 fail**.
- Dal vivo, dalla LAN a `192.168.1.12:3333` **senza alcun token**:
  `GET /api/topics` → 200 (ieri 401); `POST` con Origin forestiera → 403;
  `/__daemon/healthz` da loopback col token → 200, dalla LAN collo stesso token
  → 401.
- **L'app di produzione aperta dall'indirizzo LAN con viewport iPhone 14 Pro,
  senza token**: la SPA parte, la board si dipinge coi dati veri, il socket
  primario si apre su `wss://192.168.1.12:3333/ws`, e in tutto il boot i rifiuti
  401/403 osservati sono **zero**. Evidenza in
  `~/.topics/media/lan-open-same-origin/telefono-lan-senza-token.{webm,png}`.
  Copre il guasto originale — «Reconnecting…» eterno — ma **non** sostituisce un
  telefono vero: manca Safari/iOS, il click-through sull'interstiziale del
  certificato, e l'input touch.

**Restano aperte, e non vanno spuntate a fiducia** — chiedono un DISPOSITIVO:
- 2.6 — la verifica dal telefono che terminale, favicon, `sendBeacon` e media si
  siano sanati da soli.
- 3.5 — screenshot del pannello remoto nei due stati.
- 6.1 / 6.2 — il video dal telefono e lo smoke del guscio Tauri.
- 6.5 — la suite E2E completa, letta dagli artifacts. Non è stata lanciata perché
  il bundle in `public/` è fermo alle 2:54 e il client è in corso di modifica da
  un'altra sessione: ricostruirlo deploierebbe lavoro a metà sull'app viva. La
  spec nuova è girata con `TOPICS_E2E_BUNDLE_DIR` su un bundle isolato.

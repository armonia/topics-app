# Change: lan-open-same-origin

## Why

**Il telefono non entra.** Misurato il 2026-08-06 da `192.168.1.12` verso il server di
produzione:

```
GET https://192.168.1.12:3333/api/topics
→ {"error":"pairing token required for remote access","code":"unauthorized"}
```

La change `lan-pwa-pairing-token` aveva costruito la via d'uscita — un link di
lancio con `?token=`, catturato in `localStorage` e riattaccato su ogni chiamata —
e il meccanismo **funziona**: la stessa richiesta con l'header `x-topics-token`
torna `200`, e una POST con l'`Origin` del telefono passa il gate. Ma quella change
si è chiusa con due caselle mai spuntate, 5.1 e 5.2, che sono precisamente le
verifiche su dispositivo; e il suo «Out of scope» diceva *«QR-code pairing UX, or a
settings panel to display the pairing link — the token is captured from whatever
link the user already opens»*. Non esiste nessun link che l'utente «già apre»: non
c'è una UI che generi il link di pairing, e il token vive in
`~/.topics/daemon-state.json`, che dal telefono non si legge. La barriera non è
tecnica, è una porta senza maniglia dal lato di fuori.

La direzione presa: **rimuovere del tutto l'asse del token**, perché sarà sostituito
da un sistema di autenticazione centralizzato che autentica la connessione (in
particolare sulla stessa LAN). Questa change prepara il terreno per quello, non lo
anticipa.

**Ma il gate fa due lavori, non uno**, e oggi sono fusi in `evaluateAuth`
(`server/lib/auth-gate.ts:152-176`):

| Asse | Domanda | Chi attacca | Difesa corretta |
|---|---|---|---|
| **Trasporto** | chi può raggiungere la porta | un dispositivo sulla rete | la rete stessa. Nessun codice. |
| **Origine (CSRF)** | quale pagina sta guidando il browser | un sito che l'utente visita e che fa `fetch('https://127.0.0.1:3333/api/…')` | **same-origin**, calcolato per richiesta |

Il secondo non viene sostituito da un'auth di rete: un sito ostile aperto in una
scheda qualunque raggiunge il server loopback *dalla macchina dell'utente*, e con
quello guida i terminali (`server/routes/terminal.ts:2588`), scrive file
(`files.ts:263`), lancia `npm run` (`processes.ts:1177`), esegue JS nel browser
loggato (`browser.ts:421`).

**Conseguenza operativa che decide l'intera change:** cancellare il solo ramo del
token (`auth-gate.ts:155-162`) **non apre il telefono, lo sposta da 401 a 403**. Il
controllo d'origine vive *dentro* il ramo loopback, quindi oggi per un peer remoto è
irraggiungibile; tolto il token, diventa raggiungibile — e l'`Origin`
`https://192.168.1.12:3333` del telefono non passa `isLocalOrigin` (`:105-111`), che
riconosce solo `localhost`/`127.0.0.1`/`::1`/`*.localhost`/`tauri.localhost`. Va
sostituita la regola, non rimossa una riga.

## What changes

**Server — un solo asse, quello dell'origine.**

- `evaluateAuth` perde `ip`, `token`, `expectedToken` e acquisisce `host`. Il ramo
  trasporto sparisce: nessun peer deve più presentare un token.
- `isLocalOrigin` è sostituita da `isSameSite(origin, host)`, che confronta
  l'**hostname canonicalizzato** — non l'autorità — con `localhost`/`127.*`/`::1`/
  `*.localhost` collassati in una classe unica `#local`. Così il telefono passa su
  qualunque indirizzo, senza allowlist di IP che marcisce (e la SAN del certificato
  ha già dimostrato come marcisce: `192.168.1.2/.5/.8`, macchina oggi `.12`).
- Le richieste non mutanti restano fuori dal check: una `fetch` cross-origin non può
  **leggere** la risposta perché `corsAllowOrigin` (`server.ts:1379-1385`) non emette
  mai `Access-Control-Allow-Origin` per un'origine forestiera. Quell'assenza diventa
  load-bearing e va **pinnata da un test**, o il giorno che qualcuno allarga il CORS
  «per far funzionare la PWA» apre in lettura tutto `/api`.
- `TOPICS_ALLOWED_ORIGINS` perde la cache al primo uso (oggi cambiare la env a caldo
  non ha effetto) e diventa la manopola vera per un hostname di tunnel.
- **`/__daemon/*` diventa davvero loopback-only.** Il commento a `server.ts:1448`
  promette «token-authed **loopback** control endpoints»; il codice
  (`:1451-1458`) non guarda l'IP, solo il token. Verificato: zero occorrenze di
  `requestIP`/`isLoopback` nel blocco. Con la LAN aperta quel divario smette di
  essere teorico, quindi il controllo va aggiunto **in questa change**, insieme a un
  confronto timing-safe del token. Costo zero: `cli/topics.ts`, la sonda Tauri
  (`desktop-tauri/src-tauri/src/lib.rs:860`) e la procedura di reload di CLAUDE.md
  chiamano tutte da `127.0.0.1`.

**Client — il pairing sparisce.**

`client/src/lib/shell/pairing.ts` (138 righe) e il suo test si cancellano; con loro
gli attacchi del token in `api.ts`, `net.ts`, `useWebSocket.ts`, la cattura in
`main.tsx` e il cartello «dispositivo non appaiato» in `SidebarStatusBar.tsx`.
`installNetShim` **resta**: senza, le fetch relative del guscio Tauri risolvono
contro `tauri://localhost` e l'app smette di parlare col server — ed è anche il
punto d'innesto unico per l'header di sessione della futura auth centralizzata.

Si sanano da soli, e vanno verificati non modificati: i due WS nudi
(`SingleTerminalPane.tsx:476`, `useRemoteBrowser.ts:447`) che oggi prendono 401 anche
su un telefono appaiato; i `sendBeacon` di teardown che non possono portare header
(`syncServer.ts:274`, `projectLayoutSync.ts:288`); e tutte le `<img>`/`<video>` da
`getMediaUrl`, incluse le favicon di progetto (`ProjectFavicon.tsx:174`), dove oggi
la probe `fetch` passa col token e l'`<img>` che ne consegue prende 401.

**Superficie «online» — obbligatoria, non cosmetica.**

Caduta la barriera, l'esposizione **è** la raggiungibilità, e il pannello Remote
Access offre un bottone che con un click pubblica su Internet una superficie RCE.
Va rimosso `tailscale funnel --bg 443` (`server/routes/remote.ts:66`) tenendo
`serve`, che è tailnet-only — identità per-nodo, ACL, revoca — cioè l'estensione
naturale della LAN e non di Internet. Nello stesso file il target è
`http://localhost:3333` contro un listener TLS (`:65`): **il tunnel non è mai
salito**, e `isActive` (`:34`) legge due chiavi che `tailscale serve status --json`
non emette mai. Il pannello è cosmetico da quando esiste.

**Documentazione.**

`SECURITY.md:19` dichiara IN SCOPE «anything that lets a local-network attacker
read/modify your data or execute code»: si impegna a trattare come vulnerabilità
esattamente il comportamento che stiamo rendendo il default. Va riscritta **nello
stesso commit del codice**, o si stanno invitando segnalazioni su una scelta
deliberata.

## Impact

- **Specs (delta)**: `remote-access/` — RIMOSSE `LAN-PAIR-01` e `LAN-PAIR-02`;
  AGGIUNTE `LAN-OPEN-01` (nessun token, same-origin è l'unica decisione),
  `LAN-OPEN-02` (`/__daemon/*` loopback-only), `LAN-OPEN-03` (il pannello remoto
  espone il tailnet, non Internet). MODIFICATA `REMOTE-01` (il bottone non dice più
  «Funnel»).
- **Server**: `server/lib/auth-gate.ts` (riscrittura del modello + del commento di
  testa), `server.ts:1502-1540` (call site) e `:1448-1458` (daemon),
  `server/routes/remote.ts`.
- **Client**: cancellati `lib/shell/pairing.ts` + test; modificati `main.tsx`,
  `lib/api.ts`, `lib/shell/net.ts`, `hooks/useWebSocket.ts`,
  `components/Sidebar/SidebarStatusBar.tsx`,
  `components/Sidebar/RemoteAccessPanel.tsx`.
- **Test**: `server/lib/auth-gate.test.ts` (31 casi: 6 cancellati, 4 invertiti di
  segno, 8 nuovi), `client/src/lib/shell/net.test.ts` (3 riscritti),
  `client/src/lib/shell/pairing.test.ts` (cancellato, 17 casi), nuovo
  `tests/e2e/lan-same-origin.spec.ts`.
- **Docs**: `SECURITY.md`, `README.md:108-110`, `PRIVACY.md:26`, `docs/ENV.md:52`.
- **`openspec/changes/lan-pwa-pairing-token/`**: ritirata esplicitamente. Lasciarla
  aperta significa che il prossimo agente reimplementa il pairing.
- **Nessuna migration.** Il token del daemon resta, ma solo per `/__daemon/*`.

## Out of scope

- **L'auth centralizzata.** Questa change *toglie*; quella *metterà*. Il punto
  d'innesto è `installNetShim`, documentato nel codice.
- **Il certificato.** Misurato: un'origine HTTPS con SAN sbagliata resta
  `isSecureContext: true` dopo il click-through, con clipboard/mic/`randomUUID`
  vivi. L'unica cosa che il cert marcio uccide è la **registrazione del service
  worker** (`SecurityError`), cioè la PWA installabile. Quindi il cert è il
  prerequisito della PWA, **non** della rimozione della barriera. Task separato.
- **Il sandboxing di `/preview` e `files.ts`.** Reperti gravi e misurati (sotto), ma
  sono un lavoro strutturale a sé.
- **La UI mobile.** Che l'app sia *raggiungibile* non la rende *usabile*: task
  separati nel backlog.

## Risks

1. **La LAN non è fidata, e da oggi la trattiamo come se lo fosse.** Wifi ospiti, TV,
   telecamere, il portatile di un cliente: chiunque raggiunga `:3333` ottiene RCE
   (`/ws/terminal`, `POST /api/terminal/sessions` con cwd e comando scelti,
   `/api/scripts/run`), scrittura e `rm -rf` su path assoluti, JS arbitrario nel
   browser loggato, e lettura di **qualunque** file via `/preview/`. Verificato oggi:
   `GET /preview/etc/hosts` → `200` col contenuto. Sulla LAN aperta ciò include
   `~/.ssh/id_rsa`, `data/topics.db` e `~/.topics/daemon-state.json` — cioè il token
   che protegge `/__daemon/*`. **Questo è il prezzo della richiesta, ed è il motivo
   per cui l'auth centralizzata non è un "poi": è il debito che questa change
   contrae.**
2. **Same-origin protegge dai browser, non dalla rete.** `curl` da un dispositivo LAN
   non manda `Origin` e passa. È deliberato — il CSRF è un attacco da browser — ma
   contro uno script sulla LAN la difesa è zero. (Quello script ha già la LAN, cioè
   ha già tutto.)
3. **DNS rebinding.** Un sito ostile può far risolvere il proprio dominio verso
   `192.168.1.12`: allora `Origin` e `Host` coincidono e la regola dice sì. La difesa
   classica è validare `Host` contro un elenco atteso, cioè l'allowlist che marcisce.
   Mitigazione parziale, da valutare: accettare come `Host` solo IP-literal, `*.local`,
   `*.ts.net`, `localhost` — rifiutando i nomi DNS pubblici, che l'app non usa mai.
   Vite fa già esattamente questo (`client/vite.config.ts:144`, col commento
   «DNS-rebinding protection»).
4. **Nessuna rete di sicurezza automatica.** Zero E2E toccano il gate: la rimozione
   non produrrà un rosso. La suite non ti fermerà e non ti confermerà nulla — per
   questo la change ne aggiunge una nuova.
5. **Nessuna revoca.** Prima si poteva ruotare il token per tagliare fuori un
   dispositivo; dopo, l'unica leva è la rete. È la prima cosa che l'auth
   centralizzata deve restituire.

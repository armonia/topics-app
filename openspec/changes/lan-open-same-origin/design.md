# Design: lan-open-same-origin

## 1. La regola nuova, per intero

```
evaluateAuth({ pathname, method, origin, host, authOff, allowedOrigins })

1. authOff                       → allow    (botola di recupero, invariata)
2. metodo non mutante e non WS   → allow    (le GET le protegge il CORS, §3)
3. Origin assente                → allow    (non è un browser: CLI, MCP, hook, sendBeacon)
4. isSameSite(origin, host)      → allow
5. origin ∈ allowedOrigins       → allow
6. altrimenti                    → 403 "cross-site origin blocked"
```

Un solo asse. Chi raggiunge la porta è un problema di rete; chi guida il browser è
un problema di origine, e resta.

## 2. `isSameSite` confronta l'hostname canonicalizzato, non l'autorità

```
canonHost(h):
  lowercase, senza parentesi IPv6, senza porta
  localhost | 127.* | ::1 | *.localhost   →  "#local"
  altrimenti                              →  h

isSameSite(origin, host) =
  canonHost(new URL(origin).hostname) === canonHost(host)
```

Tre ragioni, tutte verificate sul codice, per cui non può essere `host:porta`:

**Il proxy Tauri.** `desktop-tauri/src-tauri/src/lib.rs:900-930` è uno splice L4
byte-per-byte, senza riscrittura L7: al server arrivano `Origin: tauri://localhost` e
`Host: 127.0.0.1:13333`. Entrambi cadono in `#local` → passa senza allowlist
speciale. Con un confronto di autorità servirebbe un'eccezione cablata.

**Il proxy Vite in dev.** `client/vite.config.ts:159-161` usa `changeOrigin: true` su
`/api` e `/preview`: riscrive **Host** verso il target (`localhost:3330`, o
`127.0.0.1:3333` con `VITE_PROXY_TARGET`) e lascia `Origin: https://localhost:3332`.
Con l'autorità, ogni POST in dev diventa 403.

**È già la semantica di oggi.** `isLocalOrigin` (`auth-gate.ts:97-112`) è già cieca
alla porta e allo schema. Non stiamo allentando: stiamo generalizzando la stessa
regola da «un elenco di nomi locali» a «lo stesso nome del server».

Il costo, esplicito: una pagina servita da un altro processo sulla stessa macchina
(`http://localhost:5173`) può ancora forgiare. È esattamente ciò che accade oggi —
non è una regressione, è la fiducia loopback che questa change non tocca.

## 3. Perché le GET restano fuori dal check

Un `<img>` o `<script>` cross-origin non manda `Origin`: estendere il check a tutti i
metodi non li bloccherebbe comunque. E una `fetch` cross-origin non può **leggere**
la risposta, perché `corsAllowOrigin` (`server.ts:1379-1385`) non emette mai
`Access-Control-Allow-Origin` per un'origine forestiera.

Quell'assenza smette di essere un dettaglio e diventa portante. Va scritta come
commento nel codice **e** pinnata da un test E2E, altrimenti il giorno che qualcuno
allarga il CORS «per far funzionare la PWA» apre in lettura tutta `/api` senza che
niente diventi rosso.

## 4. `Origin` assente → allow, e perché non è un buco

Un browser manda sempre `Origin` su richieste mutanti cross-origin. Chi non lo manda
è un client non-browser: la CLI (`cli/topics.ts`), i tool MCP, gli hook HTTP, i
`sendBeacon` di teardown. Bloccarli romperebbe l'app senza guadagnare nulla: un
attaccante che controlla un processo capace di omettere `Origin` è già dentro la
macchina o dentro la LAN, e in entrambi i casi il CSRF non è più il suo problema.

Rimane un caso da bloccare: `Origin: null` — literal, non assente — che arriva da
`about:blank`, da un iframe sandboxed e da un documento con `data:` URL. Quello **non**
è same-site e prende 403. `tests/e2e/cloud-session-server.spec.ts:29-40` ha già un
helper (`captureFrames`) nato per aggirarlo: resta corretto, cambia solo il commento.

## 5. Ordine dei commit

```
fase 1 (server) → fase 3 (funnel) → fase 2 (client) → test → fase 4 (docs)
```

La fase 3 prima della 2 perché rimuovere il bottone funnel mentre la barriera è già
caduta e il client manda ancora un token inutile è lo stato **più sicuro** in cui
trovarsi se il lavoro si interrompe a metà. L'ordine inverso lascerebbe, in quella
finestra, una superficie aperta con un bottone che la pubblica su Internet.

## 6. Il certificato: fuori scope, ma la decisione va presa una volta

Vincolo che decide tutto: una soluzione che richiede di riemettere il certificato a
ogni cambio di IP si rompe da sola. È già successo — la SAN elenca
`192.168.1.2/.5/.8` e la macchina oggi è `.12` — e **lo script generatore non esiste
nel working tree**: è morto con l'archiviazione di Electron
(`scripts/stage-server-dist.mjs`, ramo `electron-archive`), e generava comunque solo
`DNS:localhost,IP:127.0.0.1`. La procedura vive nella testa di una persona sola.

**La risposta era già nel certificato che c'è.** Il problema non è la SAN marcia: è
che ci si è puntati con un **IP**, e l'IP è l'unica cosa che il DHCP cambia. La SAN
elenca anche `MacBook-Pro-di-Attilio.local`, e quel nome non cambia mai. Verificato il
2026-08-06:

```
https://macbook-pro-di-attilio.local:3333/  →  200, --cacert certs/ca-cert.pem
```

L'iPhone risolve `.local` da solo via Bonjour, senza configurazione. Quindi la
strada è **indirizzare al nome mDNS, non all'IP** — e il problema del DHCP sparisce
senza riemettere niente.

| # | Opzione | Vale | Costa |
|---|---|---|---|
| 1 | **Nome `.local`, cert attuale, click-through** ⭐ | zero lavoro; il nome è già nella SAN e non marcisce; `isSecureContext` resta `true` | un interstiziale da accettare una volta per dispositivo |
| 2 | **Nome `.local` + CA installata sul telefono** ⭐⭐ | niente interstiziale; **sblocca il service worker**, cioè la PWA installabile | installare `certs/ca-cert.pem` una volta per dispositivo (profilo **+** Impostazioni → Info → Attendibilità certificati) |
| 3 | Puntare all'IP, riemettere la SAN | niente | si rompe al prossimo DHCP. È lo stato di oggi, ed è il guasto che stiamo guardando |
| 4 | Dominio vero + ACME DNS-01 | fidato ovunque, anche fuori dalla LAN | il record A punta a un IP privato e va aggiornato al cambio DHCP; credenziali sulla macchina; l'app non esce dalla LAN, quindi non serve |
| 5 | `NO_TLS=1` | niente interstiziale | perde `isSecureContext` (misurato: su HTTP non-localhost `clipboard`, `randomUUID`, `subtle`, `serviceWorker`, `mediaDevices` sono **tutti** `undefined`) e mette in chiaro sulla LAN scrollback dei terminali e chat |

**Consigliata: 1 adesso, 2 quando servirà la PWA installabile.** Nessuno dei due è
un prerequisito per entrare dal telefono.

`tailscale cert` è stato valutato e **scartato**: il tailnet qui è uno strumento di
simulazione della LAN, non un canale di distribuzione, e legare il certificato del
prodotto a un servizio che non fa parte del prodotto è una dipendenza che non serve
a nessuno.

Resta un debito vero e indipendente: **nel working tree non esiste alcuno script che
generi `certs/`**. È morto con l'archiviazione di Electron
(`scripts/stage-server-dist.mjs`, ramo `electron-archive`) e generava comunque solo
`DNS:localhost,IP:127.0.0.1`. La procedura vive nella testa di una persona sola. Uno
script che riemetta il cert dalla CA locale con la SAN giusta — nome mDNS incluso —
va scritto e committato, indipendentemente dall'opzione scelta.

## 7. Matrice di decisione da pinnare nei test

| Origin | Host | Metodo | Atteso |
|---|---|---|---|
| `https://192.168.1.12:3333` | `192.168.1.12:3333` | POST | allow — il telefono |
| `https://192.168.1.12:3333` | `192.168.1.12:3333` | WS | allow |
| `https://evil.com` | `192.168.1.12:3333` | POST | **403** |
| `tauri://localhost` | `127.0.0.1:13333` | POST | allow — `#local` |
| `https://localhost:3332` | `127.0.0.1:3333` | POST | allow — Vite dev |
| `https://macbook.tailXXXX.ts.net` | idem | POST | allow — tailnet |
| `null` | qualunque | POST | **403** — origine opaca |
| *assente* | qualunque | POST | allow — non è un browser |
| qualunque | qualunque | GET | allow — lo protegge il CORS |

# Tasks: device-auth

## 1. Server — l'identità (AUTH-01)

- [x] 1.1 Migration `080-devices.sql`: tabella `devices` con `token_hash` (SHA-256,
  mai il token) e `revoked_at` (revoca, non DELETE — una riga cancellata non
  racconta niente). **Verifica:** applicata al DB vivo, manifest embedded
  rigenerato.
- [x] 1.2 `lib/device-auth.ts` puro: hash, conio del token e del codice, lettura e
  costruzione del cookie, `evaluateIdentity`, percorsi esenti. **Verifica:** 21
  unit, incluso quello che prova su 200 estrazioni che il codice non contiene mai
  caratteri ambigui.
- [x] 1.3 **Il gate diventa a DUE assi, e l'ordine è il punto.** Prima usciva ad
  `allow` per ogni metodo non mutante *prima* di ogni altro controllo: innestare
  l'identità dopo avrebbe lasciato tutte le GET aperte a `curl`, `/preview`
  compreso — la falla misurata. Ora: origine (CSRF, vale anche per chi ha un
  cookie buono) e poi identità. **Verifica:** `GET /preview/etc/hosts` dalla LAN
  → 401 senza cookie, 200 con.
- [x] 1.4 Call site in `server.ts`: risolve l'identità (il DB si tocca solo per un
  peer remoto con un cookie — il percorso locale non paga una query) e aggiorna
  `last_seen_at` al massimo ogni ora, o ~94 chiamate per boot diventerebbero 94
  scritture. **Verifica:** typecheck 0, 2442 test server verdi.

## 2. Server — l'appaiamento (AUTH-02, AUTH-03)

- [x] 2.1 `routes/auth.ts`: `pair/request` (il dispositivo nuovo riceve il codice
  da MOSTRARE), `pair/status` (attende e ritira il cookie, consegna unica),
  `pair/pending`, `pair/approve`, `pair/deny`, `session`, `devices`,
  `devices/:id` (revoca), `logout`. **Verifica:** giro completo con `curl`.
- [x] 2.2 Tre frame WS registrati (`auth:pair-requested`, `auth:pair-resolved`,
  `auth:device-revoked`): un broadcast con un tipo non modellato non compila.
- [x] 2.3 Nome del dispositivo dallo user-agent — «iPhone», non
  `Mozilla/5.0 (iPhone; CPU iPhone OS…`: un elenco illeggibile è un elenco che
  non si guarda.

## 3. Client — l'identità si vede (AUTH-04)

- [x] 3.1 `lib/auth/session.ts` fuori da React: a incontrare il rifiuto è la
  fetch, non un componente, e il WebSocket non può leggere lo stato HTTP del
  proprio upgrade.
- [x] 3.2 `api.ts` riconosce il 401 per IDENTITÀ e lo distingue dal 403 per
  origine. Senza, il client non saprebbe che c'è un gesto da fare.
- [x] 3.3 `PairingGate`: schermo intero, MOSTRA il codice, non ne chiede uno.
  Testi distinti per «mai entrato», «revocato», «scaduto».
- [x] 3.4 `PairingApproval`: il cartello sul Mac, alimentato dal WS così compare
  ovunque l'utente stia guardando.
- [x] 3.5 **La riga sopra la barra di stato** col nome del dispositivo. Muta sul
  computer, dove l'identità è il presupposto e non un'informazione.
- [x] 3.6 Prova nella UI vera, viewport iPhone contro un'istanza isolata: codice
  identico sui due lati (asserito), cancello che sparisce all'approvazione, riga
  che mostra «iPhone». Evidenza in `~/.topics/media/device-auth/`.

## 4. Documentazione

- [x] 4.1 `SECURITY.md`, `README.md`, `PRIVACY.md`: «no built-in authentication»
  non è più vero e va tolto — resta zero occorrenze. Lo scope dichiara ora cosa è
  IN (un dispositivo non autorizzato che entra, una sessione ottenuta senza
  approvazione, una revoca che non morde) e cosa è FUORI (ciò che può fare un
  dispositivo autorizzato, che ha per progetto i poteri del proprietario).

## 5. Completamenti

- [x] 5.1 **Elenco dispositivi in Impostazioni** (`Settings → Dispositivi`), con
  revoca a due passi e i revocati che restano in elenco, barrati — una riga
  cancellata non racconta niente. **Verifica:** aperto nella UI vera, titolo
  «Dispositivi autorizzati» e due voci con «visto adesso · da 192.168.1.12».
  Screenshot in `~/.topics/media/device-auth/pannello-dispositivi.png`.
- [x] 5.4 **`/preview` confinato.** Non aveva nessun confine: l'unico controllo
  era «il path è canonico». Ora passa da `resolveProjectPath` (confronto sul path
  REALE, così un symlink dentro un progetto non è una porta) più le radici di
  media e allegati. **Verifica dal vivo:** `/preview/etc/hosts` → 403, un file di
  progetto → 200.
- [x] 5.5 **Tetto sulle richieste di appaiamento**: 3 per indirizzo, 20 in tutto.
  **Verifica:** la quarta richiesta dallo stesso indirizzo → 429.

## 6. Resta aperto

- [x] 6.1 **Rinominare un dispositivo.** «iPhone» basta con un telefono; con tre
  no. `PATCH /api/auth/devices/:id` (nome potato a 60 caratteri, vuoto → 400) più
  il campo in Impostazioni → Dispositivi.
- [x] 6.2 **Prova su dispositivo VERO.** Fatta dal proprietario dal suo iPhone —
  richiesta, codice, approvazione dal computer, app aperta. Copre proprio ciò che
  il viewport in Chromium non poteva coprire: il click-through
  sull'interstiziale del certificato e il touch.
- [ ] 6.3 **Identità del PROPRIETARIO (es. login Google).** Oggi l'identità dice
  QUALE dispositivo, non CHI. Serve quando le persone diventano più di una — il
  backlog ha già l'idea di «amicizia» per vedere le sessioni altrui. Vincolo da
  sapere prima di provarci: Google non accetta come redirect URI un nome `.local`
  o un IP privato, quindi il telefono non può fare OAuth verso questo server; a
  fare il login sarebbe il COMPUTER (redirect su loopback, che è ammesso per le
  app installate), e l'account servirebbe a firmare le approvazioni, non a
  sostituire la sessione del dispositivo. E richiede Internet al momento del
  login, cosa che oggi l'app non richiede mai.

  **Ripreso dalla change `sharing-orgs`**, dove smette di essere un di più: da
  quando il prodotto si vende a singoli *e* a team, «chi» non è più deducibile da
  «quale dispositivo». Lì il proprietario diventa una `person`, e questo punto è
  il modo in cui quella riga acquista un nome verificabile dall'esterno.

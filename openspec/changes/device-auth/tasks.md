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

## 5. Resta aperto

- [ ] 5.1 **Elenco dispositivi in Impostazioni.** Gli endpoint ci sono e la revoca
  funziona (provata con `curl`), ma manca il pannello: oggi si revoca solo via
  API. Finché non c'è, la promessa «revocabile in qualunque momento» scritta in
  `SECURITY.md` è vera solo per chi sa usare `curl`.
- [ ] 5.2 **Rinominare un dispositivo.** «iPhone» basta con un telefono; con tre
  no.
- [ ] 5.3 **Prova su dispositivo VERO.** Il giro è stato provato con un viewport
  iPhone in Chromium, non con Safari su iOS: mancano il click-through
  sull'interstiziale del certificato e il touch.
- [ ] 5.4 **`/preview` resta da sandboxare.** L'auth chiude la porta; non rende
  sicuro il file server per chi è dentro. `resolveSafePath` esiste in
  `server/utils.ts` con **zero chiamanti**. Va fatto comunque.
- [ ] 5.5 **Nessun rate limit su `pair/request`.** Il verso dell'approvazione
  toglie il brute-force del codice, ma un peer sulla rete può inondare la coda
  delle richieste in attesa. Oggi scadono in tre minuti e vivono in memoria; un
  tetto per IP è comunque da mettere.

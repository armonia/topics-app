# Design — autonomous-credential-store

## Context

Stato mappato sul codice attuale (path:riga citati). Punti d'ancoraggio esistenti:

- **Precedente Keychain in casa**: `server/integrations/chrome-cookies.ts` legge già un
  segreto dal Keychain via **`security` CLI** — `keychainKey()` a `:81` fa
  `execFile("security", ["find-generic-password", "-ws", "Chrome Safe Storage"])` (`:82`),
  poi PBKDF2 (`:84`). È il pattern "config nel file, segreto nel Keychain, letto
  on-demand" da **generalizzare** (fuori repo il precedente analogo è
  `EDM_KEYCHAIN_SERVICE` di edm-mail). Limite: `security -ws` è un accesso da **processo
  bun**, con attribuzione TCC fragile ⇒ per il vault ci spostiamo nel processo Rust.
- **Browser tool + choke-point di digitazione**: schema in `server/browser-tool-spec.ts`
  (`browser_act` a `:74`, action `fill`/`type`, param `text`/`value`/`key` a `:105-107`);
  implementazione in `server/browser-service.ts` — la digitazione reale passa da
  `service.type()` a **`:1104`** (`page.keyboard.type(text)`) e dal dispatcher
  `dispatchInput` case `'type'` a **`:1450`**. `fill` usa Playwright `.fill()`
  (React-safe). Questi sono gli **unici** punti dove il testo entra nella pagina.
- **Bridge processi**: la webview→Rust usa Tauri **`invoke`**
  (`client/src/lib/shell/tauriBrowserOps.ts`, es. `invoke('browser_eval_js', …)` a `:85`).
  Il **server bun** NON invoca comandi Tauri direttamente: coordina i pane nativi via
  **WebSocket** `/ws/browser/:contextId` con protocollo `register_native_executor` /
  `delegateOp` (`server/browser-native-delegate.ts:51/:115`, route in
  `server/browser-engine-registry.ts:130`). Comandi Tauri esistenti in
  `desktop-tauri/src-tauri/src/lib.rs` (~30, es. `perf_metrics` `:96`, `set_traffic_lights`
  `:714`).
- **Firma/entitlement**: `desktop-tauri/src-tauri/Info.plist` esiste ma ha solo ATS
  (`:10-12`); **nessun** file `.entitlements`; `tauri.conf.json` (`identifier
  io.armonia.topics.tauri`, `macOSPrivateApi: true`) senza `signingIdentity`/
  `hardenedRuntime`/`entitlements`. In `Cargo.toml` **non** ci sono `security-framework`,
  `rusqlite`, `keyring`.
- **Segreti in chiaro**: `<DATA_DIR>/browser-state` (+ `_handles/*.json`) da
  `server/browser-state-store.ts:20-21` e `server/browser-login-state.ts` (scrittura
  atomica `0600` a `:122`, contiene cookie decifrati); stati esterni legacy via
  `externalStatesDir()` (`:104-105`, env `TOPICS_EXTERNAL_STATES_DIR`/`JARVIS_STATES_DIR`,
  fallback `~/.claude/jarvis/state/browser-states`).

## Decisioni

### D0 — Firma persistente PRIMA di tutto (prerequisito bloccante)
Creare un **certificato self-signed persistente** in Accesso Portachiavi e usarlo nel
`codesign` del build Tauri (via `signingIdentity` in `tauri.conf.json` o step di firma
nella pipeline). Aggiungere un file `.entitlements` con `keychain-access-groups` +
`com.apple.security.*` minimi e le usage string in `Info.plist`. Effetto: il *designated
requirement* si ancora al **certificato**, non al `cdhash` ⇒ i permessi TCC/Keychain
sopravvivono ai rebuild. **Developer ID non serve** (uso locale). → spec SIGN-01/02.
Il **Full Disk Access** resta **manuale** (handoff Attilio), con stato "in attesa di FDA"
in UI e degrado pulito se assente → SIGN-03.

### D1 — Keychain e chat.db nel processo Rust; bun li chiede via IPC
Il vault vive nel **processo Rust principale** (crate **`security-framework`** per
Keychain, **`rusqlite`** per `chat.db` read-only, crate TOTP RFC 6238 — es.
`totp-rs`/`oath` — oppure fallback `oathtool`). Motivo: i sidecar bun ereditano
l'attribuzione TCC del parent in modo fragile e non documentato.

**Canale bun→Rust (nuovo).** Oggi il bun **non** ha un path `invoke`; il solo ponte
bun↔nativo è il WS `/ws/browser/:contextId` + `register_native_executor`/`delegateOp`.
Due opzioni (scelta in implementazione, spec-neutra):
- **(a)** Estendere il registry native-executor con op `cred_get`/`otp_recent`/`totp_now`
  (riusa il canale esistente, l'executor gira lato app dove i comandi Tauri sono
  disponibili).
- **(b)** Un comando Tauri dedicato esposto su un **IPC locale** (loopback autenticato)
  che il bun chiama solo per le op vault.
Preferenza: **(a)** se l'executor nativo può invocare i comandi Rust del vault; altrimenti
(b). In entrambi i casi il valore non è mai a riposo nel bun.

### D2 — Injection a type-time nel choke-point unico
La risoluzione `{{cred:dominio/campo}}` avviene **subito prima** di
`page.keyboard.type` (`browser-service.ts:1104` e `:1450`) e dentro il ramo `fill`.
Flusso: il tool riceve `text` col placeholder → **resolver** (nel processo che digita)
chiama `cred_get` via D1 → sostituisce → digita → **scarta** il valore. L'LLM e gli
argomenti loggati del tool contengono **solo** il placeholder (INJECT-01). Una funzione
`redactSecrets()` avvolge i logger e i dump del tool (screenshot/HTML) con sostituzione
`***` sui valori risolti della sessione (INJECT-02).

### D3 — Schema vault e audit
Keychain `service = "io.armonia.topics.cred/" + dominio`, `account = campo`
(`username`/`password`/`totp_seed`/…), coerente con `keychain-access-groups`.
CRUD + `cred_get` nel Rust. **Audit log append-only** (file own-by-Rust, o tabella
sqlite dedicata *separata* da chat.db) con `{ts, agente/sessione, dominio, campo, tool,
url}` e **mai** il valore; non cancellabile dall'agente. **Kill-switch** = flag di lock in
memoria/stato Rust che fa fallire ogni `cred_get`; **rotazione** = replace atomico del
Keychain item + voce di audit (VAULT-02/03).

### D4 — Secondo fattore
- **TOTP**: seed nel Keychain, codice generato nel Rust (`totp_now(dominio)`), iniettato
  come un segreto qualsiasi (AUTH-01).
- **OTP-SMS**: `otp_recent(pattern, within_minutes)` in Rust apre `chat.db` **read-only**
  (`?mode=ro`/`immutable`), query parametrica con filtro `date > now-N` e regex sul
  pattern OTP, ritorna **solo** il match numerico. Nessuna proiezione del `text` di altri
  messaggi (AUTH-02). Richiede FDA (SIGN-03).

### D5 — Loop registrazione
Componente orchestrato dall'agente: genera alias (`+tag`/Hide My Email), compila il form,
poi **polla** l'inbox via `gws-mail` (già disponibile) filtrando per **dominio mittente ==
servizio in corso**; estrae codice/link solo da quel messaggio; **mai** aprire link di
mittenti diversi (AUTH-03). Timeout/retry limitati.

### D6 — Passkey via CDP
Sui siti WebAuthn si usa `WebAuthn.addVirtualAuthenticator` via CDP sull'engine chromium
di `browser-service.ts`; le credenziali del virtual authenticator sono trattate come
segreti del vault (AUTH-04). Preferita alla password quando il sito la offre.

### D7 — Guardrail
**Allowlist** in config (lista domini). Il resolver di D2 e l'orchestratore di login/
registrazione consultano l'allowlist **prima** di risolvere qualunque segreto: fuori lista
⇒ stop + richiesta umana. Categorie **banche/PA/sanità** e step **KYC/pagamenti/documenti**
sono **hard-deny** anche se in allowlist; **nessuna carta** entra nel vault (AUTH-05,
VAULT-01).

### D8 — Migrazione + deprecazione jbrowser
Migratore **idempotente** con **rollback**: importa `~/.claude/jarvis/router/.env`
(~11 chiavi) e gli `storageState` (`browser-state` + `_handles`, stati esterni legacy) nel
vault; i sorgenti in chiaro si **cestinano (trash) solo dopo** riavvio verde che legge dal
vault (MIGRATE-01/02). **jbrowser** (`:3344`, fuori repo) è deprecato: i suoi
`browser-states`/`browser-profiles` confluiscono nel vault e nessun flusso nuovo vi
dipende (MIGRATE-03).

## Trade-off dichiarato (esplicito)

Unattended ⇒ ogni processo che gira **come l'utente** può leggere le credenziali (il vault
è sbloccato a runtime). La protezione mira a **LLM, log e cloud** — dove sta il rischio
reale (esfiltrazione via prompt/telemetria) — **non** al malware locale, che avrebbe
comunque accesso all'ambiente utente. Compensazioni **dichiarate come tali**: allowlist,
audit log append-only, kill-switch, superficie di permessi minima (solo Keychain + chat.db
read-only), redaction hard.

## Rischi / mitigazioni
- **Firma non persistente** (rischio #1): senza D0, ogni rebuild rompe l'unattended →
  D0 è **bloccante**, verificata in CI (SIGN-01 "firma adhoc rifiutata").
- **Leak del segreto** oltre il choke-point (es. un secondo path di digitazione futuro):
  centralizzare la risoluzione in un solo resolver + test che il placeholder non venga mai
  risolto fuori da `browser-service`.
- **chat.db**: rischio di leggere troppo → query read-only, finestra temporale stretta,
  regex OTP, mai proiettare `text` generico; degrado se manca FDA.
- **Migrazione distruttiva**: mai `rm`, sempre trash e solo dopo verde; rollback testato.
- **Attribuzione TCC dei sidecar**: evitata mettendo Keychain/chat.db nel Rust (D1).

## Testing
- **Unit (Rust)**: `cred_get`/rotazione/kill-switch (Keychain mock o gruppo di test),
  `totp_now` contro vettori RFC 6238, `otp_recent` su un `chat.db` fixture (finestra +
  pattern), audit log append-only (nessun valore).
- **Unit (bun)**: resolver placeholder (`{{cred:…}}` → chiamata IPC, allowlist deny,
  categoria vietata), `redactSecrets()` su log/errori/dump.
- **E2E (Playwright)**: login su una pagina di test con injection (il valore reale entra
  nel form, il transcript/tool-args mostrano solo il placeholder); flip allowlist
  (dominio fuori lista → stop). Passkey/CDP con virtual authenticator su fixture.
- **Firma**: check in build che il binario NON sia adhoc e porti l'entitlement Keychain.
- **Migrazione**: idempotenza (doppio run), rollback, "sorgenti cestinati solo dopo verde".

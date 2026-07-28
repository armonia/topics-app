# Tasks — autonomous-credential-store

Convenzione: ogni fase chiude con build verde (`cd desktop-tauri/src-tauri && cargo build`
per il Rust, `cd client && tsc -b` + `bun run build:client` per il TS) e i test della fase.
`[ ]` = da fare. **Le fasi sono ordinate: la 0 è bloccante per tutte le altre.**

## Phase 0 — Firma persistente + entitlement (PREREQUISITO BLOCCANTE)
- [ ] 0.1 Creare in Accesso Portachiavi un **certificato self-signed persistente** (code
  signing) e documentarne la creazione nel repo (script/README, non il materiale privato).
- [ ] 0.2 `desktop-tauri/src-tauri/*.entitlements`: `keychain-access-groups`
  (`io.armonia.topics.tauri`) + entitlement minimi; referenziarlo dal build/firma.
- [ ] 0.3 `Info.plist`: aggiungere le usage string necessarie (accanto all'ATS esistente).
- [ ] 0.4 `tauri.conf.json` / pipeline: firmare con l'identità persistente (non adhoc).
- [ ] 0.5 Check di CI/build: **fallire** se il binario è adhoc/senza l'entitlement Keychain
  (guardrail SIGN-01). Verifica manuale: rebuild → Keychain senza nuovo prompt.
- [ ] 0.6 **Handoff FDA (manuale, Attilio)**: istruzioni + stato "in attesa di FDA" in UI;
  degrado pulito della sola feature OTP-SMS se FDA assente.

## Phase 1 — Credential vault nel processo Rust
- [ ] 1.1 `Cargo.toml`: aggiungere `security-framework`, `rusqlite`, crate TOTP (RFC 6238).
- [ ] 1.2 Modulo Rust `cred`: CRUD Keychain con schema `service=io.armonia.topics.cred/<dom>`,
  `account=<campo>`; comando/handler `cred_get(dominio, campo)`. Rifiuto categoria "carta".
- [ ] 1.3 **Audit log append-only** (store separato da chat.db): `{ts, sessione, dominio,
  campo, tool, url}`, mai il valore; non cancellabile dall'agente.
- [ ] 1.4 **Kill-switch** (lock in-memory che fa fallire `cred_get`) + **rotazione**
  atomica del Keychain item, entrambe auditate.
- [ ] 1.5 **Canale bun→Rust** per le op vault: estendere il native-executor
  (`browser-native-delegate.ts` / `/ws/browser`) con `cred_get`/`totp_now`/`otp_recent`,
  oppure IPC loopback dedicato. Il valore non è mai a riposo nel bun.

## Phase 2 — Injection `{{cred:…}}` + redaction
- [ ] 2.1 Resolver placeholder nel processo che digita: parse `{{cred:dominio/campo}}`,
  consulta **allowlist**, chiama `cred_get`, sostituisce **subito prima** di
  `page.keyboard.type` (`browser-service.ts:1104` e `:1450`) e nel ramo `fill`. Scarta il
  valore dopo l'uso.
- [ ] 2.2 `redactSecrets()`: wrap dei logger server/sidecar e dei dump dei browser tool
  (screenshot/HTML/errori) → `***` sui valori risolti della sessione.
- [ ] 2.3 Test: il placeholder non è mai risolto fuori dal resolver; il valore reale entra
  nel form ma non nel transcript/tool-args/log.

## Phase 3 — Secondo fattore
- [ ] 3.1 TOTP: `totp_now(dominio)` in Rust (seed dal Keychain), vettori RFC 6238.
- [ ] 3.2 OTP-SMS: `otp_recent(pattern, within_minutes)` — `chat.db` **read-only**
  (`immutable=1`), filtro finestra + regex OTP, ritorna solo il codice. Richiede FDA.
- [ ] 3.3 Passkey: `WebAuthn.addVirtualAuthenticator` via CDP in `browser-service.ts`;
  credenziali del virtual authenticator nel vault.

## Phase 4 — Registrazione autonoma + guardrail
- [ ] 4.1 Loop registrazione: genera alias (`+tag`/Hide My Email), compila form, polla
  inbox via `gws-mail`, match sul **dominio mittente atteso**, estrae codice/link; mai
  link di mittenti diversi. Timeout/retry.
- [ ] 4.2 **Allowlist** in config + hard-deny categorie (banche/PA/sanità, KYC/pagamenti/
  documenti). Fuori allowlist ⇒ stop + richiesta umana (nessuna injection).

## Phase 5 — Migrazione + deprecazione jbrowser
- [ ] 5.1 Migratore idempotente: importa `~/.claude/jarvis/router/.env` (~11 chiavi) e gli
  `storageState` (`<DATA_DIR>/browser-state` + `_handles`, stati esterni legacy) nel vault.
- [ ] 5.2 Rollback + verifica "riavvio verde"; **cestinare (trash, non rm)** i sorgenti in
  chiaro **solo dopo** verde.
- [ ] 5.3 Deprecare **jbrowser** (`:3344`): confluenza `browser-states`/`browser-profiles`
  nel vault; documentare che nessun flusso nuovo vi dipende.

## Phase 6 — Verifica end-to-end
- [ ] 6.1 E2E: login con injection + TOTP; flip allowlist (dominio fuori lista → stop).
- [ ] 6.2 E2E: registrazione autonoma su servizio di test con verifica email.
- [ ] 6.3 Riprova firma persistente: rebuild → nessun re-prompt Keychain, FDA intatto.

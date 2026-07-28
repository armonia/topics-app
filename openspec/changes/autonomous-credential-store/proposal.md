## Why

Oggi l'agente non sa autenticarsi da solo. Ogni login nel browser di Topics richiede che
Attilio digiti a mano username/password/OTP a runtime; la registrazione a un servizio
nuovo è del tutto manuale. Questo rompe qualsiasi flusso non-presidiato (task notturni,
loop di board, sub-agenti). In parallelo i segreti sono già **sparsi in chiaro su disco**:
`~/.claude/jarvis/router/.env` porta ~11 chiavi API in chiaro, e le sessioni browser
(cookie/`storageState`) sono salvate non cifrate in `data/browser-state`, oltre ai profili
del daemon esterno **jbrowser** (`:3344`) — un duplicato funzionale di
`browser-service.ts` + `browser-tool-spec.ts` che va deprecato, non integrato.

Vogliamo che Attilio autorizzi **una tantum** e poi l'agente faccia login **e**
registrazione da solo, senza prompt, con i segreti in un vault vero (Keychain macOS) e
**mai** esposti all'LLM, ai log o alla rete. Costo target: **0 €** (niente
1Password/Bitwarden/Twilio/Developer ID).

Blocco preliminare noto: `Topics.app` è firmata **adhoc/linker-signed** (TeamIdentifier
not set). Con firma adhoc il permesso TCC/Keychain è ancorato al **cdhash** del binario:
ogni rebuild revoca il Full Disk Access e ri-apre il prompt Keychain, distruggendo
l'unattended. Va risolto **per primo**.

> **Nota di scope.** Questo change è la **sola proposta** (spec-first). Nessun codice
> finché Attilio non approva; l'implementazione è un task successivo.

## What Changes

Un sottosistema **credential vault + auth autonoma**, tutto dentro Topics, con l'accesso
ai permessi macOS ancorato al processo **Rust principale** (Tauri), non ai sidecar bun.

1. **Prerequisito bloccante — firma persistente + entitlement.** Certificato
   **self-signed persistente** (Accesso Portachiavi) usato nel `codesign` del build, così
   il *designated requirement* si ancora al **certificato** e sopravvive ai rebuild.
   Entitlement `keychain-access-groups` + usage string in `Info.plist` (oggi assenti in
   `desktop-tauri/src-tauri`). Il **Full Disk Access** resta un passaggio **manuale** di
   Attilio in Impostazioni di Sistema (TCC non ha bypass programmatici): documentato come
   **handoff esplicito**, non automatizzato.

2. **Credential store (Keychain).** Naming `service`/`account` per dominio, CRUD, comando
   Tauri `cred_get`, **audit log append-only** di ogni accesso (chi/quando/quale dominio —
   **mai il valore**). Generalizza il pattern già in casa `EDM_KEYCHAIN_SERVICE`
   (config nel file, segreto nel vault).

3. **Injection `{{cred:dominio/campo}}`.** L'LLM vede **solo** il placeholder; la
   sostituzione avviene a **type-time** nel processo che digita (nei browser tool
   esistenti — `browser_act` e affini), con **redaction hard** nei log. Il valore non
   entra mai nel context, nei log, nella rete. Stesso pattern di browser-use
   `sensitive_data` / Anchor Browser secret values.

4. **Secondo fattore autonomo.**
   - **TOTP**: seed nel Keychain, generazione codice (oathtool o impl. nativa Rust).
   - **OTP via SMS**: l'iPhone inoltra gli SMS al Mac → codici in
     `~/Library/Messages/chat.db`. Lettura **read-only, filtrata**: solo ultimi N minuti,
     solo pattern OTP numerico, **mai** dump di conversazioni né testo di messaggi
     personali. Nessun Twilio.
   - **Passkey**: virtual authenticator via CDP (`WebAuthn.addVirtualAuthenticator`) dove
     il sito la supporta.

5. **Registrazione autonoma.** Alias email (Gmail `+tag` o iCloud Hide My Email) →
   polling inbox via `gws-mail` → estrazione codice/link con **match sul dominio atteso**
   (mai aprire link da mittenti diversi dal servizio in corso) → conferma.

6. **Guardrail.** **Allowlist** domini in config: fuori dalla lista l'agente **si ferma e
   chiede**. Mai banche, PA, sanità; mai KYC/documenti/pagamenti; **nessuna carta** nel
   vault. **Kill-switch** (lock immediato del vault) + **rotazione** credenziali.

7. **Migrazione dei segreti in chiaro** nel vault: `~/.claude/jarvis/router/.env` (~11
   chiavi) e gli `storageState`/cookie (`data/browser-state`,
   `browser-profiles`/`browser-states` di jbrowser). Idempotente, con **rollback**; i
   `.env` originali si **cestinano solo** dopo che tutto riparte verde.

8. **Deprecazione jbrowser** (`:3344`): duplicato funzionale già superato da
   `browser-service.ts`; i suoi stati di sessione confluiscono nel vault.

**Trade-off dichiarato.** Unattended ⇒ le credenziali sono leggibili da qualunque
processo che gira come l'utente. La protezione è verso **LLM, log e cloud** (il rischio
reale), **non** verso malware locale. Compensazioni: allowlist, audit log, kill-switch,
superficie di permessi minima.

Non-goal: pagamenti, KYC, carte; integrazione di password-manager di terzi;
Developer ID / notarizzazione; qualunque servizio a pagamento.

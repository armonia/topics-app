## ADDED Requirements

### Requirement: VAULT-01 — Credential store su Keychain con naming per dominio

I segreti SHALL essere conservati nel **Keychain macOS**, con schema di naming
deterministico `service` = prefisso applicativo + **dominio**, `account` = **campo**
(es. `username`, `password`, `totp_seed`). L'accesso al Keychain (e a
`~/Library/Messages/chat.db`) SHALL avvenire **nel processo Rust principale** (crate
`security-framework` + `rusqlite`), **non** nei sidecar bun. Il server bun SHALL ottenere
i valori solo via comando Tauri (es. `cred_get`, `otp_recent`). Nessuna carta di
pagamento SHALL essere accettata nel vault.

#### Scenario: get di una credenziale per dominio/campo
- **GIVEN** una credenziale salvata per `dominio=example.com`, `campo=password`
- **WHEN** il server bun invoca `cred_get(example.com, password)` via IPC Tauri
- **THEN** il processo Rust legge il Keychain e ritorna il valore al chiamante interno,
  senza che il valore transiti nei sidecar bun a riposo

#### Scenario: rifiuto dati di pagamento
- **GIVEN** una richiesta di salvare un numero di carta / PAN nel vault
- **THEN** l'operazione è rifiutata (categoria vietata), nulla viene scritto

### Requirement: VAULT-02 — Audit log append-only di ogni accesso

Ogni lettura/uso di una credenziale SHALL produrre una voce **append-only** che registra
**chi** (agente/sessione), **quando**, **quale dominio/campo** e **contesto** (tool/URL).
La voce **NON** SHALL mai contenere il valore del segreto. Il log SHALL essere
consultabile dall'utente e **non** cancellabile dall'agente.

#### Scenario: accesso registrato senza il valore
- **GIVEN** un agente che usa una credenziale in un login
- **WHEN** l'iniezione avviene
- **THEN** una voce di audit riporta agente/timestamp/dominio/campo/URL, e una ricerca del
  valore del segreto nel log non produce risultati

### Requirement: VAULT-03 — Kill-switch (lock immediato) e rotazione

Il vault SHALL esporre un **kill-switch** che, invocato, blocca **immediatamente** ogni
`cred_get` successivo (vault "locked") finché non viene sbloccato esplicitamente
dall'utente. Il vault SHALL supportare la **rotazione** di una credenziale (sostituzione
atomica del valore, invalidando quello precedente) tracciata nell'audit log.

#### Scenario: kill-switch blocca le letture
- **GIVEN** il vault sbloccato
- **WHEN** l'utente attiva il kill-switch
- **THEN** ogni `cred_get` successivo fallisce con stato "vault locked" finché l'utente non
  sblocca, e l'evento è registrato nell'audit log

#### Scenario: rotazione atomica
- **GIVEN** una credenziale esistente per un dominio
- **WHEN** viene ruotata con un nuovo valore
- **THEN** le letture successive tornano il nuovo valore, il vecchio non è più ottenibile,
  e la rotazione è auditata (senza valori)

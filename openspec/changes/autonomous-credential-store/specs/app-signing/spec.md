## ADDED Requirements

### Requirement: SIGN-01 — Firma persistente ancorata a un certificato (prerequisito bloccante)

`Topics.app` SHALL essere firmata con un **certificato self-signed persistente**
(non adhoc/linker-signed) al momento del build, così che il *designated requirement* si
ancori all'**identità del certificato** e non al `cdhash` del binario. Il permesso
Keychain e TCC concessi all'app SHALL quindi **sopravvivere a un rebuild** senza revoca né
nuovo prompt. Nessun **Developer ID** o notarizzazione è richiesto: l'ancora è locale.

Questo requisito è un **prerequisito bloccante**: nessuna funzione di vault o auth
autonoma SHALL essere considerata funzionante finché la firma non è persistente.

#### Scenario: rebuild non revoca i permessi
- **GIVEN** Topics.app firmata con il certificato self-signed persistente e con Keychain
  già autorizzato
- **WHEN** il progetto viene ricompilato e reinstallato
- **THEN** l'app accede al Keychain **senza** nuovo prompt e il Full Disk Access resta
  concesso (il designated requirement matcha ancora)

#### Scenario: firma adhoc rifiutata dal build
- **GIVEN** la pipeline di build
- **WHEN** il binario risulta firmato adhoc / senza TeamIdentifier o certificato atteso
- **THEN** il passo di firma fallisce con un errore esplicito (non produce un artefatto
  che perderebbe i permessi al rebuild successivo)

### Requirement: SIGN-02 — Entitlement e usage string per Keychain

Il bundle Tauri SHALL dichiarare l'entitlement `keychain-access-groups` e una **usage
string** (`NSAppleEventsUsageDescription`/purpose string pertinente) nel `Info.plist`,
oggi assenti in `desktop-tauri/src-tauri`. Il gruppo di accesso Keychain SHALL essere
coerente tra entitlement e naming del vault (SIGN-03/VAULT-01).

#### Scenario: entitlement presente nel bundle firmato
- **GIVEN** l'app buildata e firmata
- **WHEN** si ispezionano gli entitlement del binario
- **THEN** `keychain-access-groups` è presente e coincide con il gruppo usato dal vault;
  l'usage string è presente nell'Info.plist

### Requirement: SIGN-03 — Full Disk Access come handoff manuale documentato

La concessione del **Full Disk Access** (necessaria per leggere
`~/Library/Messages/chat.db`) SHALL essere trattata come **passo manuale** di Attilio in
Impostazioni di Sistema → Privacy e sicurezza. La proposta e la UI SHALL **documentare**
questo handoff (istruzioni esplicite, stato "in attesa di FDA"), e il sistema **non** SHALL
tentare bypass programmatici di TCC. In assenza di FDA, la lettura OTP-SMS SHALL degradare
in modo pulito (feature disabilitata + messaggio), senza crash.

#### Scenario: FDA non concesso → degrado pulito
- **GIVEN** l'app avviata senza Full Disk Access
- **WHEN** un flusso richiede un OTP via SMS da `chat.db`
- **THEN** la feature OTP-SMS è segnalata come non disponibile con istruzioni per
  concedere FDA, e il resto del vault continua a funzionare

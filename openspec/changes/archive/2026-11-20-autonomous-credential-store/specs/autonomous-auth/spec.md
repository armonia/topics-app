## ADDED Requirements

### Requirement: AUTH-01 — Secondo fattore TOTP autonomo

Il vault SHALL conservare i **seed TOTP** (Keychain, campo `totp_seed` per dominio) e
generare il codice a 6 cifre al momento del login (oathtool o implementazione nativa Rust,
RFC 6238). Il seed **NON** SHALL mai raggiungere l'LLM; il codice generato è iniettato con
lo stesso pattern placeholder (INJECT-01).

#### Scenario: login con TOTP
- **GIVEN** un dominio con `totp_seed` salvato e un form che chiede il codice a 6 cifre
- **WHEN** l'agente raggiunge lo step 2FA
- **THEN** il codice TOTP corrente è generato nel processo Rust e iniettato a type-time; il
  seed non compare in context/log/rete

### Requirement: AUTH-02 — OTP via SMS da chat.db (read-only, filtrato)

Quando il secondo fattore arriva via **SMS** (iPhone che inoltra al Mac), il sistema SHALL
leggere `~/Library/Messages/chat.db` in **sola lettura** dal processo Rust
(`rusqlite`), estraendo **solo**: messaggi entro **ultimi N minuti** (N configurabile,
default piccolo) **e** che matchano un **pattern OTP numerico**. Il sistema **NON** SHALL
mai fare dump di conversazioni, restituire testo di messaggi personali, né persistere il
contenuto dei messaggi. Espone un comando tipo `otp_recent(pattern, within_minutes)` che
ritorna **solo** il codice estratto.

#### Scenario: estrazione del solo codice
- **GIVEN** un OTP a 6 cifre arrivato via SMS 30 secondi fa e altri messaggi personali recenti
- **WHEN** l'agente invoca `otp_recent` durante un login
- **THEN** viene ritornato solo il codice numerico; nessun testo di altri messaggi è letto,
  ritornato o loggato

#### Scenario: nessun OTP recente
- **GIVEN** nessun messaggio OTP entro la finestra temporale
- **WHEN** `otp_recent` è invocato
- **THEN** ritorna vuoto (l'agente attende/ritenta), senza leggere oltre la finestra

### Requirement: AUTH-03 — Registrazione autonoma con alias email e match sul dominio

L'agente SHALL poter **registrare** un account da solo: generare un **alias email**
(Gmail `+tag` o iCloud Hide My Email), completare il form, poi **pollare l'inbox** via
`gws-mail` per il messaggio di verifica. L'estrazione del codice/link SHALL applicare un
**match sul dominio atteso**: SHALL aprire/usare **solo** link il cui mittente/dominio
coincide col servizio in registrazione; link da mittenti diversi SHALL essere **ignorati**.

#### Scenario: verifica email della registrazione
- **GIVEN** una registrazione in corso su `service.com` e una mail di verifica da `service.com`
- **WHEN** l'agente polla l'inbox dell'alias
- **THEN** estrae il codice/link **di quella mail** e completa la verifica

#### Scenario: link da mittente non atteso ignorato
- **GIVEN** durante la registrazione arriva anche una mail con link da un dominio diverso
- **WHEN** l'agente processa l'inbox
- **THEN** quel link **non** viene aperto; solo il messaggio del dominio atteso è usato

### Requirement: AUTH-04 — Passkey via virtual authenticator CDP

Dove il sito supporta le **passkey/WebAuthn**, il sistema SHALL usare un **virtual
authenticator** via CDP (`WebAuthn.addVirtualAuthenticator`) sull'engine chromium
esistente, preferendolo alla password quando disponibile. Le credenziali del virtual
authenticator SHALL essere gestite come segreti del vault.

#### Scenario: login via passkey
- **GIVEN** un sito con passkey già registrata nel virtual authenticator
- **WHEN** l'agente avvia il login WebAuthn
- **THEN** l'autenticazione si completa via CDP senza input umano e senza password

### Requirement: AUTH-05 — Allowlist di dominio e categorie vietate

Le operazioni autonome (login, registrazione, injection) SHALL essere consentite **solo**
per domini presenti in una **allowlist** di config. Per un dominio fuori lista l'agente
SHALL **fermarsi e chiedere** autorizzazione umana, senza digitare nulla. Le categorie
**banche, PA, sanità** e le operazioni di **KYC, documenti d'identità, pagamenti** SHALL
essere **sempre vietate**, anche se il dominio fosse in allowlist.

#### Scenario: dominio non in allowlist blocca
- **GIVEN** un login richiesto su un dominio assente dall'allowlist
- **WHEN** l'agente tenta di procedere
- **THEN** si ferma e chiede autorizzazione umana; nessuna credenziale viene risolta o digitata

#### Scenario: categoria vietata sempre bloccata
- **GIVEN** un dominio bancario/PA/sanitario o uno step di pagamento/KYC
- **WHEN** l'agente lo incontra
- **THEN** l'operazione è rifiutata a prescindere dall'allowlist, con nota di audit

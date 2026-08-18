## ADDED Requirements

### Requirement: DESKTOP-NOTIF-01 — Consegna banner nativi su macOS via UserNotifications

Su macOS, la shell Tauri SHALL postare le notifiche del comando `notify` tramite il
framework moderno `UserNotifications` (`UNUserNotificationCenter`), NON tramite la
deprecata `NSUserNotificationCenter`. All'avvio (processo bundled) la shell SHALL
richiedere l'autorizzazione `.alert` una volta, così che l'app compaia in
Impostazioni → Notifiche e sia autorizzabile dall'utente.

#### Scenario: completamento sessione → banner consegnato
- **GIVEN** Topics.app bundled con autorizzazione notifiche concessa
- **WHEN** una sessione Claude transita in `awaiting-user` e il client invoca `notify`
- **THEN** macOS consegna il banner (usernoted `Delivering ...` senza errore
  `LegacyConnection`) e la notifica appare nel Notification Center

#### Scenario: primo avvio chiede il permesso
- **GIVEN** primo avvio dell'app dopo il fix, nessuna entry in ncprefs
- **WHEN** l'app arriva a `setup()`
- **THEN** macOS mostra il prompt di autorizzazione e l'app compare in
  Impostazioni → Notifiche indipendentemente dalla risposta

### Requirement: DESKTOP-NOTIF-02 — Banner anche ad app frontmost (gating lato client)

Il delegate `willPresent` SHALL presentare la notifica come banner anche quando
Topics.app è l'app frontmost. La decisione se notificare (focus della tab, finestra,
`notifyEvenWhenFocused`) spetta ESCLUSIVAMENTE al client (`decideTerminalBanner`,
`useCompletionNotifier`): la shell esegue ciò che il client ha già deciso.

#### Scenario: app frontmost, tab non visibile
- **GIVEN** Topics.app frontmost ma la tab della sessione completata NON è il pannello attivo
- **WHEN** il client invoca `notify`
- **THEN** il banner appare comunque

### Requirement: DESKTOP-NOTIF-03 — Contratto fire-and-forget e ambienti degradati

Il comando `notify` SHALL mantenere il contratto esistente: mai un errore al caller.
In processo non-bundled (`cargo run` dev) la shell SHALL fare fallback al path plugin
esistente senza crash. Autorizzazione negata → no-op silenzioso OS-side. Su
Windows/Linux il path `tauri-plugin-notification`/`notify-rust` SHALL restare invariato.

#### Scenario: dev non-bundled non crasha
- **GIVEN** shell avviata con `cargo run` (nessun bundle identifier)
- **WHEN** boot + invocazione `notify`
- **THEN** nessuna eccezione ObjC; l'app resta viva

#### Scenario: permesso negato
- **GIVEN** utente ha negato l'autorizzazione
- **WHEN** il client invoca `notify`
- **THEN** nessun banner, nessun errore propagato al client; il permesso resta
  riattivabile da Impostazioni → Notifiche

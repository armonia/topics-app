# Tasks — fix-macos-native-notifications

Convenzione: ogni gruppo chiude con `cargo check` verde in `desktop-tauri/src-tauri`.
`[ ]` = da fare.

## Phase 0 — Dipendenze
- [x] 0.1 `Cargo.toml`: aggiunte sotto `[target.'cfg(target_os = "macos")'.dependencies]`
  `objc2 = "0.6"`, `objc2-foundation = { "0.3", features NSBundle/NSString/NSError }`,
  `block2 = "0.6"`, `objc2-user-notifications = { "0.3", features UNUserNotificationCenter/
  UNNotificationContent/UNNotificationRequest/UNNotificationTrigger/UNNotification/
  UNNotificationResponse/UNNotificationSettings/block2 }` (UNNotificationTrigger serve al
  gate di `requestWithIdentifier:content:trigger:`). Nessun dup objc2 nel lock.

## Phase 1 — Modulo macOS
- [x] 1.1 `macos_notifications`: `is_bundled()` (guard `NSBundle.bundleIdentifier`),
  `post(title, body)` (UNMutableNotificationContent + UNNotificationRequest, identifier
  `topics-notif-<pid>-<seq>` per-notifica, trigger nil).
- [x] 1.2 Delegate `UNUserNotificationCenterDelegate` (`define_class!`):
  `willPresent → .Banner|.List`; `didReceive → ensure_window_visible(main)` via
  `run_on_main_thread`. AppHandle negli ivars; strong ref leaked (delegate weak property).
- [x] 1.3 Wiring: `install()` (delegate + `requestAuthorization(.Alert)`) in `setup()`;
  comando `notify` → path UN su macOS bundled, fallback plugin altrove.

## Phase 2 — Verifica live (macchina prod, 2026-07-07)
- [x] 2.1 `cargo build --release` (2m04s, 0 warning nuovi); swap binario + codesign adhoc;
  rilancio (PID 96086).
- [x] 2.2→BLOCCANTE TROVATO (diagnostica in `~/Library/Logs/topics-notifications.log`):
  `requestAuthorization → granted=false "Notifications are not allowed for this
  application"`, `authorizationStatus=1 (Denied)`, nessun prompt, nessuna entry ncprefs
  (app non listata → non abilitabile a mano). **macOS 26 nega l'autorizzazione UN alle
  app senza firma con catena Apple.** Provato empiricamente con 2 probe minimal Swift:
  bundle id vergine + firma adhoc → negata; + identità self-signed locale ("Topics Local
  Signing") → negata uguale. Conferme esterne: kitty da nixpkgs (adhoc) stesso sintomo su
  Tahoe; doc Electron "app must be code-signed for notifications"; Apple DTS raccomanda
  Apple Development al posto di adhoc. → SERVE certificato Apple (Apple Development per
  il locale, Developer ID Application per le release).
- [x] 2.3 Pipeline moderna comunque verificata: usernoted (log stream) `Adding new
  request … req:"topics-notif-96086-N" … entitlement check success … Delivering … to
  [ .alert .lockScreen .notificationCenter ]` SENZA errore `LegacyConnection` — il
  posting UN funziona; è la PRESENTAZIONE a schermo che l'OS blocca finché l'app non ha
  firma Apple + consenso. 7 post reali dal client nel primo quarto d'ora: lato app tutto
  scorre.
- [ ] 2.4 Dopo firma con certificato Apple: rilancio → prompt di sistema → Consenti →
  banner a schermo + click-to-focus da confermare.
- [x] 2.5 Regressione dev: guard `is_bundled()` su ogni entry point (binario nudo →
  `bundleIdentifier` nil → skip UN, fallback plugin); non eseguito `cargo run` live per
  non spawnare una seconda istanza sulla macchina di prod.
- [x] 2.6 Topics.app di prod rilanciata e lasciata in esecuzione.

## Phase 3 — Chiusura
- [x] 3.1 Commit (pathspec esplicito, messaggio convenzionale, no trailer).
- [ ] 3.2 Bump versione lockstep (`tauri.conf.json` + `Cargo.toml` + root `package.json`)
  quando si decide di rilasciare; tag `tauri-vX.Y.Z` fuori scope di questo change.

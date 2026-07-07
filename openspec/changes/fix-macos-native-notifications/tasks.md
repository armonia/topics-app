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
- [~] 2.2 Nessun prompt osservato e nessuna entry ncprefs — ma la consegna risulta
  AUTORIZZATA (vedi 2.3): su questo sistema macOS 26 pare auto-consentire l'app UN al
  primo post. Se in futuro serve regolare lo stile banner, verificare quando l'entry
  compare in Impostazioni → Notifiche.
- [x] 2.3 Iniezione `UserPromptSubmit`→`Stop` su sessione idle: usernoted (log stream)
  `Adding new request … req:"topics-notif-96086-1" … successfully processed …
  Delivering … to [ .alert .lockScreen .notificationCenter ]` — SENZA errore
  `LegacyConnection`. Un post reale (seq-0) era già partito dal traffico vivo.
  Banner a schermo non confermato visivamente (app fullscreen in primo piano al momento
  del test — possibile Focus); la consegna OS è verificata dal log.
- [ ] 2.4 Click sul banner → app in primo piano (da confermare a mano al prossimo banner).
- [x] 2.5 Regressione dev: guard `is_bundled()` su ogni entry point (binario nudo →
  `bundleIdentifier` nil → skip UN, fallback plugin); non eseguito `cargo run` live per
  non spawnare una seconda istanza sulla macchina di prod.
- [x] 2.6 Topics.app di prod rilanciata e lasciata in esecuzione.

## Phase 3 — Chiusura
- [x] 3.1 Commit (pathspec esplicito, messaggio convenzionale, no trailer).
- [ ] 3.2 Bump versione lockstep (`tauri.conf.json` + `Cargo.toml` + root `package.json`)
  quando si decide di rilasciare; tag `tauri-vX.Y.Z` fuori scope di questo change.

# Design — fix-macos-native-notifications

## Contesto

Il comando attuale (`lib.rs:735-739`):

```rust
#[tauri::command]
fn notify(app: tauri::AppHandle, title: String, body: String) {
    use tauri_plugin_notification::NotificationExt;
    let _ = app.notification().builder().title(title).body(body).show();
}
```

Su macOS finisce in `mac-notification-sys` → `NSUserNotificationCenter` (deprecata) →
usernoted la rifiuta (`no notification allowed to be sent to it`). Serve il framework
moderno `UserNotifications` con autorizzazione esplicita.

## Approccio scelto: UN framework diretto in lib.rs (macOS), plugin altrove

### Alternative scartate

- **Bump `tauri-plugin-notification`**: upstream v2 usa ancora `notify-rust` su desktop
  (`desktop.rs:180`) → stesso bug. Scartata.
- **Solo `requestAuthorization` UN + posting legacy invariato**: potrebbe sbloccare la
  `LegacyConnection` una volta autorizzata l'app, ma è comportamento non documentato di
  usernoted (mix di due API sulla stessa identità) e resta appeso a un'API deprecata che
  Apple può rimuovere del tutto. Scartata come fix, utile solo come esperimento diagnostico.
- **`osascript display notification`**: posta con l'identità di Script Editor. Kludge. Scartata.

### Struttura

Nuovo modulo `#[cfg(target_os = "macos")] mod macos_notifications` in `lib.rs`
(o file `macos_notifications.rs` a fianco, coerente con come lib.rs organizza gli altri
blocchi AppKit):

```rust
// Cargo.toml [target.'cfg(target_os = "macos")'.dependencies]
// objc2 = "0.6", objc2-foundation = "0.3", block2 = "0.6",
// objc2-user-notifications = { version = "0.3", features = [
//   "UNUserNotificationCenter", "UNNotificationContent", "UNNotificationRequest",
//   "UNNotificationSettings", "block2",
// ] }
// (tutte già nel lock come transitive: 0.6.4 / 0.3.2 / 0.6.2 / 0.3.2 → nessun dup)
```

Tre funzioni pubbliche:

1. `is_bundled() -> bool` — `NSBundle::mainBundle().bundleIdentifier().is_some()`.
   `UNUserNotificationCenter::currentNotificationCenter()` **lancia un'eccezione ObjC**
   (`bundleProxyForCurrentProcess is nil`) in un processo non-bundle: ogni entry point
   del modulo fa early-return se non bundled, così `cargo run` dev resta vivo (lì il
   fallback è il path plugin legacy: al peggio non-consegna, com'è oggi).

2. `request_authorization()` — chiamata una volta in `setup()` (stesso punto dove oggi
   si registrano tray/dock):
   ```rust
   let center = UNUserNotificationCenter::currentNotificationCenter();
   center.requestAuthorizationWithOptions_completionHandler(
       UNAuthorizationOptions::Alert,          // NIENTE .sound: tono lato client
       &RcBlock::new(|_granted: Bool, _err| {}), // fire-and-forget, esito non bloccante
   );
   ```
   Il primo avvio mostra il prompt di sistema; dai successivi è no-op (stato persistito
   da macOS). Qui si installa anche il **delegate** (punto 4).

3. `post(title: &str, body: &str)` — chiamata dal comando `notify`:
   ```rust
   let content = UNMutableNotificationContent::new();
   content.setTitle(&NSString::from_str(title));
   content.setBody(&NSString::from_str(body));
   let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
       &NSString::from_str(&uuid),  // uuid v4 per-notifica: mai coalescere
       &content,
       None,                        // trigger nil = consegna immediata
   );
   center.addNotificationRequest_withCompletionHandler(&request, None);
   ```
   Contratto invariato col client: fire-and-forget, mai errore.

4. **Delegate** `UNUserNotificationCenterDelegate` via `define_class!` (objc2):
   - `userNotificationCenter:willPresentNotification:withCompletionHandler:` →
     `UNNotificationPresentationOptions::Banner | List`. Senza questo, il framework
     **sopprime i banner quando l'app è frontmost**: regressione rispetto al contratto
     esistente, dove il gating focus/visibilità lo decide GIÀ il client
     (`decideTerminalBanner` + `notifyEvenWhenFocused`) e la shell esegue e basta.
   - `userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:` →
     attiva/porta in primo piano la finestra principale (parity col vecchio
     `-activate` di terminal-notifier). Prima iterazione: solo `show + focus` della
     main window; niente deep-link al topic (il payload non trasporta il topicId oggi).
   - Il delegate va tenuto vivo (static `OnceLock`) e assegnato sul **main thread**
     (`run_on_main`), come già fa `set_dock_badge`.

Il comando diventa:

```rust
#[tauri::command]
fn notify(app: tauri::AppHandle, title: String, body: String) {
    #[cfg(target_os = "macos")]
    {
        if macos_notifications::is_bundled() {
            macos_notifications::post(&title, &body);
            return;
        }
    }
    use tauri_plugin_notification::NotificationExt;
    let _ = app.notification().builder().title(title).body(body).show();
}
```

`tauri-plugin-notification` resta come dipendenza (Windows/Linux + fallback dev macOS).

## Rischi / incognite

- **App adhoc-signed — VERIFICATO DAL VIVO: BLOCCANTE.** Su macOS 26 `requestAuthorization`
  ritorna `granted=false "Notifications are not allowed for this application"`
  (status Denied, nessun prompt, app non listata in Impostazioni → Notifiche) per
  QUALSIASI app senza catena di firma Apple: probe minimal con firma adhoc E con
  identità self-signed locale entrambe negate. Il fix UN in questo change resta
  necessario (il path legacy è morto comunque) ma serve ANCHE firmare l'app con un
  certificato Apple: "Apple Development" per la macchina locale, "Developer ID
  Application" per le release distribuite (che oggi escono non firmate → nessun utente
  macOS 26 riceve banner; risolverebbe anche la firma dell'auto-updater).
- **Prompt negato dall'utente**: `post()` diventa no-op OS-side (per design: stesso
  contratto silenzioso di oggi), ma ora l'app È in Impostazioni → Notifiche e
  l'autorizzazione è riattivabile a mano.
- **Thread-safety**: le API UNCenter sono thread-safe per il posting; solo il set del
  delegate va sul main thread. Il comando Tauri può restare sync (ritorna subito).

## Verifica (live, macchina di prod)

1. `cargo build --release` in `desktop-tauri/src-tauri`.
2. Hotfix swap: binario → `~/Applications/Topics.app/Contents/MacOS/app`, `codesign
   --force --deep -s -`, rilancio app (che va POI lasciata aperta: la usa l'utente).
3. Al primo avvio: prompt "Consenti notifiche" → Consenti → entry
   `io.armonia.topics.tauri` presente in `ncprefs`/Impostazioni.
4. Iniezione hook sintetici su una sessione idle (stesso metodo della diagnosi):
   `UserPromptSubmit` → 2s → `Stop` via `curl -k` su `/api/claude-hooks/...` con token.
5. Attesi: (a) banner a schermo "in attesa di te", (b) `log stream` di usernoted mostra
   `Delivering ...` SENZA errore `LegacyConnection`, (c) notifica visibile nel
   Notification Center.
6. Regressione dev: `cargo run` (non-bundled) non crasha al boot né su notify.

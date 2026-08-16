# Proposal — fix-macos-native-notifications

## Why

**Le notifiche native macOS della shell Tauri non sono MAI state consegnate su questa
macchina** — diagnosi verificata empiricamente il 2026-07-07 iniettando hook sintetici
(`UserPromptSubmit`→`Stop`) su una sessione idle e osservando il log di `usernoted`:

```
Record <NotificationRecord app:"io.armonia.topics.tauri" ... staticCategory:"<LEGACY ...>">
  successfully processed by pipeline, scheduled for delivery.
E  Cannot sent msg to <LegacyConnection identifier: io.armonia.topics.tauri>,
  no notification allowed to be sent to it
```

Tutta la pipeline a monte **funziona**: hook Claude Code → `POST /api/claude-hooks/:event`
(HTTPS :3333, bearer token) → phase machine (`claude-session-state.ts`) → broadcast WS
`session:state` → `useCompletionNotifier` → comando Rust `notify`. Il banner arriva fino a
`usernoted` e viene scartato **all'ultimo hop**, in silenzio.

Causa: `tauri-plugin-notification` 2.3.3 → `notify-rust` 4.18 → `mac-notification-sys`
0.6.15 posta via la **API deprecata `NSUserNotificationCenter`**. Su macOS 26 le
connessioni legacy prive di autorizzazione vengono rifiutate, e l'app **non compare mai**
in Impostazioni → Notifiche (0 entry in `ncprefs` tra 131 app) — quindi non è nemmeno
autorizzabile a mano. Sul desktop il plugin è un guscio: `request_permission()` e
`permission_state()` ritornano `Granted` hardcoded (`desktop.rs:61-66`), nessuno chiede
mai l'autorizzazione al sistema.

Upstream non salva: `plugins-workspace` branch v2 usa ancora `notify_rust` su desktop →
il bump di versione non risolve.

Effetto utente: "sessione Claude finita / serve approvazione" produce badge/fill in-app e
badge dock, ma **zero banner OS** — il segnale principale quando l'app non è in vista.

## What Changes

Su macOS, il comando `notify` di `desktop-tauri/src-tauri/src/lib.rs` posta via
**`UNUserNotificationCenter`** (framework moderno `UserNotifications`, crate
`objc2-user-notifications` — già transitiva nell'albero deps):

1. **Autorizzazione all'avvio**: una chiamata `requestAuthorization(.alert)` (senza
   `.sound`: il tono lo suona già il client via WebAudio) al primo avvio bundled. macOS
   mostra il prompt di sistema una volta; l'app compare in Impostazioni → Notifiche.
2. **Posting**: `UNNotificationRequest` con `UNMutableNotificationContent` (title/body).
3. **Delegate `willPresent`**: senza delegate il framework sopprime i banner quando l'app
   è frontmost — romperebbe il contratto esistente (`notifyEvenWhenFocused`, gating già
   deciso dal client). Il delegate restituisce `.banner` + `.list`.
4. **Guard dev/un-bundled**: `UNUserNotificationCenter.currentNotificationCenter()`
   lancia un'eccezione ObjC se il processo non è un bundle (`cargo run` da terminale) →
   guard su `NSBundle.mainBundle.bundleIdentifier`, fallback no-op.
5. **Windows/Linux invariati**: lì `notify-rust` funziona; il path plugin resta.

## Impact

- **File toccati**: `desktop-tauri/src-tauri/src/lib.rs` (comando `notify` + setup),
  `desktop-tauri/src-tauri/Cargo.toml` (deps dirette `objc2-user-notifications 0.3`,
  `objc2-foundation 0.3`, `block2 0.6`, `objc2 0.6` — versioni già nel lock).
- **Nessun cambio client/server**: il contratto `tauriInvoke('notify', {title, body})`
  resta identico (fire-and-forget, mai errore al caller).
- **UX una tantum**: al primo avvio post-fix macOS chiede "Consenti notifiche da
  Topics?" — l'utente deve cliccare Consenti.
- **Spec**: nuova capability `desktop-notifications` (delta in questo change).
- **Rollout locale**: hotfix swap del binario nel `.app` di prod + codesign adhoc
  (pattern consolidato), poi ordinaria release `tauri-vX.Y.Z`.

# macOS code signing & notarization (Developer ID)

**Why this matters.** macOS 26 refuses `UserNotifications` authorization to any app
whose signature does not chain to Apple — ad-hoc **and** locally self-signed builds are
both rejected with no prompt, and the app never even appears in *System Settings →
Notifications*. Topics currently ships **unsigned**, which is the root cause of the dead
native banners on every release. The cure is signing + notarizing with a **Developer ID
Application** certificate. Bundling `terminal-notifier` is not a fix — it is ad-hoc signed
too and would fall the same way on a clean machine.

The release workflow (`.github/workflows/tauri-release.yml`) is already **armed**: it maps
six `APPLE_*` secrets into `tauri-action`. `tauri-action` only attempts signing when
`APPLE_CERTIFICATE` is a non-empty string, so until the secrets are set the macOS job
ships unsigned exactly as before. Set the secrets and the next `tauri-vX.Y.Z` release
signs + notarizes automatically — no workflow edit needed.

## One-time setup (requires an active Apple Developer Program membership)

Add all six under **repo → Settings → Secrets and variables → Actions**.

### 1. Create the "Developer ID Application" certificate
- Xcode → *Settings → Accounts* → your Team → **Manage Certificates** → **+** →
  *Developer ID Application*. (Or developer.apple.com → *Certificates* → **+**.)
- Keychain Access → *login* keychain → *My Certificates* → right-click
  **Developer ID Application: … (TEAMID)** → **Export** → format **.p12** → set a
  password → save `topics-signing.p12`.

### 2. The six secrets

| Secret | Value |
|--------|-------|
| `APPLE_CERTIFICATE` | `base64 -i topics-signing.p12 \| pbcopy` — paste the base64 |
| `APPLE_CERTIFICATE_PASSWORD` | the .p12 export password you chose |
| `APPLE_SIGNING_IDENTITY` | exact cert name, e.g. `Developer ID Application: Attilio Cianci (TEAMID)` |
| `APPLE_ID` | Apple ID email of the developer account |
| `APPLE_PASSWORD` | an **app-specific** password (appleid.apple.com → *Sign-In & Security → App-Specific Passwords → +*) — **not** the account password |
| `APPLE_TEAM_ID` | 10-char Team ID (developer.apple.com → *Membership*) |

`APPLE_SIGNING_IDENTITY` must match the certificate name character-for-character — copy it
from `security find-identity -v -p codesigning`.

## Verify (on a signed + notarized build)
- Tauri command `notification_status` → `authorized: true` / `authState: "granted"`.
- *System Settings → Notifications* lists Topics; the app's status row flips to
  "I banner di sistema arrivano".
- Chain log: `~/Library/Logs/topics-notifications.log`.

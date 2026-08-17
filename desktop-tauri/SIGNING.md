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

## Step 0 — Enrolment (as an **organization**, not an individual)

Everything below presumes a paid membership. We don't have one yet, and it is the only
part of this document that **cannot be scripted**: creating the Apple Account, accepting
the agreement that binds the company, and paying are legal and financial acts. Per
[Apple's own rules](https://developer.apple.com/help/account/membership/program-enrollment/),
they must be done by someone with **legal binding authority** for the company — for us,
Attilio. Nobody else, and no tool.

Enrol as an **organization**, not as an individual: only an organization membership puts
the COMPANY on the certificate (an individual one would sign as a natural person, and
converting later requires Apple Support).

What Apple checks, and what we have:

| Requirement | Our value |
|-------------|-----------|
| Legal entity (no DBAs / trade names) | the company's registered name, exactly as filed |
| D‑U‑N‑S Number | already obtained (free) — see `.personal-terms`, it is not in this repo |
| Legal binding authority | whoever can sign for the company — must be the one enrolling |
| Work email on the company domain | an `@armonia.io` address, with 2FA on |
| Public, functional website on that domain | <https://armonia.io> |

Two things that bite:

- **Use a fresh Apple Account** on the company domain, not a personal one. The account
  becomes the *Account Holder*, and the Account Holder is the only role that can create a
  Developer ID Application certificate — so it has to be an address that outlives any one
  person's laptop. Two-factor authentication is mandatory before enrolment starts.
- **Organizations pay last.** Individuals pay immediately; an organization submits the
  enrolment, waits for Apple Developer Support to verify the D‑U‑N‑S and the binding
  authority (they may ask for notarized business documents), and only then gets the email
  that unlocks the 99 USD/year purchase. Budget days, not minutes.

Enrol on the web at <https://developer.apple.com/programs/enroll/>. Once the membership is
active, `scripts/apple-signing-setup.sh csr` takes over and drives steps 1–3 below
(no secret ever passes as a command-line argument).

## One-time setup (requires an active Apple Developer Program membership)

`scripts/apple-signing-setup.sh` automates all of it — `csr` → `importa` → `segreti` →
`verifica`. The manual equivalent, for reference:

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

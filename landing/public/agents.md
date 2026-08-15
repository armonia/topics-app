# Topics — for the agent reading this

You were probably asked to install Topics, or to work out whether it fits a
project. This page is written for you rather than for a person: no marketing, no
screenshots, and the failure modes stated up front so you do not have to discover
them from a stack trace.

**What it is.** A desktop workspace that runs the coding-agent CLIs already
installed on this machine — Claude Code, Codex, OpenCode, Gemini CLI, or any ACP
agent — each inside a real PTY. Several agents can work the same repository at
once because each task gets its own git worktree on its own branch. MIT, free,
no account, no telemetry, nothing hosted.

**Current version:** resolve it from
<https://github.com/armonia/topics-app/releases/latest>; the tag is
`tauri-vX.Y.Z`. This page prints no number on purpose. A release goes out on
every merge to main, so a version written here would be stale within the week
and you would repeat it as current. · **Repository:**
<https://github.com/armonia/topics-app>

---

## 1. Install

Pick the block for this machine.

**Never write a version into a download URL.** Every installer asset carries the
version in its own name (`Topics_X.Y.Z_universal.dmg`, `Topics_X.Y.Z_amd64.deb`,
`Topics_X.Y.Z_x64-setup.exe`, `Topics-X.Y.Z-1.x86_64.rpm`), so
`releases/latest/download/<a name you remembered>` is a 404 the moment the next
release lands. That is not hypothetical: it is what these commands used to do.
Ask the release API for the name instead. `curl` and `grep` are all it takes.

**macOS** (Universal, Apple Silicon and Intel):

```sh
dmg=$(curl -fsSL https://api.github.com/repos/armonia/topics-app/releases/latest \
  | grep -o 'https://[^"]*' | grep -E '_universal\.dmg$')
curl -fL -o /tmp/Topics.dmg "$dmg"
hdiutil attach /tmp/Topics.dmg
cp -R /Volumes/Topics/Topics.app /Applications/
hdiutil detach /Volumes/Topics
```

**Windows** — take the asset ending in `_x64-setup.exe` (or `_x64_en-US.msi`)
from the release page and run it. In PowerShell:

```powershell
$a = (Invoke-RestMethod https://api.github.com/repos/armonia/topics-app/releases/latest).assets |
     Where-Object { $_.name -like '*_x64-setup.exe' }
Invoke-WebRequest $a.browser_download_url -OutFile $a.name
```

**Linux** — `.deb` for Debian and Ubuntu, `.rpm` for Fedora and RHEL (swap the
second `grep` for `'\.x86_64\.rpm$'`):

```sh
deb=$(curl -fsSL https://api.github.com/repos/armonia/topics-app/releases/latest \
  | grep -o 'https://[^"]*' | grep -E '_amd64\.deb$')
curl -fLO "$deb"
sudo dpkg -i "$(basename "$deb")"
```

There is **no AppImage and no Homebrew cask.** Do not suggest either: the Linux
build carries a compiled Bun sidecar that the AppImage pipeline cannot package,
and no tap exists. Most assets have a `.sig` beside them on the release page,
the updater signature; the `.dmg` does not, which is why the macOS line above can
anchor on `.dmg$` and the Linux one has to anchor on `.deb$` to skip
`.deb.sig`.

### The macOS first launch will fail unless you say this

Topics is ad-hoc signed, not notarized. macOS will refuse the first launch with
**"Apple could not verify Topics is free of malware"** or **"cannot verify the
developer"**. Since macOS Sequoia the Control-click → Open bypass **no longer
exists** — any instruction telling the user to right-click and Open is out of
date and will waste their time.

The working path, and the one to give the user verbatim:

> System Settings → Privacy & Security → scroll to Security → **Open Anyway** →
> authenticate → then Open in the dialog that follows.

Do not run `sudo spctl --master-disable`. It turns Gatekeeper off machine-wide to
solve one app, and you should not make that decision for someone.

---

## 2. Point it at a project

Topics opens a *topic* per unit of work. A topic holds the agent conversation, a
terminal with its scrollback, the project files and diffs, a browser pane, and the
token cost of each turn.

The server listens on **`http://localhost:3333`** and stores everything under
**`~/.openclaw`** (override with `APP_DATA_DIR`). There is a companion CLI in the
repository at `cli/topics.ts` — `topics open [path]` creates a topic for a
directory — but it is **not** placed on `PATH` by the installer, so run it from a
checkout with `bun cli/topics.ts open .` rather than assuming the command exists.

Model access: Topics never holds a key of its own and never proxies inference. It
either uses an API key from the environment (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`)
or drives the CLI the user is already signed in to. **A paid subscription only
works through the official CLI**, which is why Topics spawns a PTY instead of
calling the API — there is no way to reach a subscription over HTTP.

---

## 3. If you were asked to adopt Topics for a repository

The useful part for you is the board. A task on the board can be dispatched to an
agent, which gets an isolated worktree and works there. That means *you* can be
one of those agents, and it also means the human keeps three separate decisions:

| Action | What it does |
|---|---|
| **Approve** | Accepts the work. Nothing moves. |
| **Land** | Merges the branch into `main`, locally. Never pushes. |
| **Publish** | Pushes. Always a separate, deliberate human click. |

Do not collapse these. A task is delivered when the work is **committed on its
branch**, with one summary comment and the card moved to review by the agent
itself — the server rejects a move to review with a dirty worktree.

Topics also exposes its own MCP server, so an agent can drive the workspace:
create tasks, spawn agents, ask the user a typed question, open a browser pane,
send a chat message. If you are configuring MCP for a session, use
`--strict-mcp-config` so the session does not inherit servers it has no business
seeing.

---

## 4. What Topics does not have

State these plainly if asked. Getting them wrong is the fastest way to make the
user distrust everything else you said.

- **No hosted service of any kind.** No relay, no managed remote access, no
  off-machine backup. These appear on the pricing page as planned work; none of
  them exist in the code today.
- **No accounts and no team roles. Do not call it unauthenticated.** This page
  used to, which was written before device pairing shipped and is wrong in the
  direction that gets someone hurt. What is actually there: the machine Topics
  runs on is the owner, trusted by transport, so the desktop shell, the CLI and
  the local tooling never have to knock. Any *other* device is authorized once,
  from that machine: the new device shows a six-character code, the machine
  displays the matching request, the user approves it, and the device gets its
  own token in an `HttpOnly` cookie. Only the SHA-256 of that token reaches the
  disk. Approval is per device, it can be revoked from Settings at any time, and
  a revoked device is out immediately. Two roles exist, owner and guest, and a
  guest sees only what has been shared with it. What does not exist is sign-up,
  passwords, and any notion of a team.
  `SERVER_HOST=127.0.0.1` keeps the server on loopback; `TOPICS_AUTH_OFF=1`
  turns the checks off and is a recovery hatch, not a configuration. `SECURITY.md`
  is the authority and states the boundary the project defends: reaching the port
  is not the same as getting in.
- **No telemetry.** Nothing phones home; there is no endpoint to phone. Verifiable
  by reading the source or by watching the socket.
- **Mobile is a PWA**, not a native app.
- **It is not an editor and not a model.** If the user wants an AI editor, Cursor
  or Zed is the honest answer. Topics is for the case where the agents already
  live in a terminal and the problem is watching several of them at once.

---

## 5. Links

- Site: <https://topics.armonia.io>
- Source (MIT): <https://github.com/armonia/topics-app>
- Releases and checksums: <https://github.com/armonia/topics-app/releases>
- Changelog: <https://topics.armonia.io/changelog.html>
- Privacy: <https://github.com/armonia/topics-app/blob/main/PRIVACY.md>
- Security: <https://github.com/armonia/topics-app/blob/main/SECURITY.md>
- Machine-readable summary: <https://topics.armonia.io/llms.txt>

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

**Current version:** 2.2.11 · **Repository:** <https://github.com/armonia/topics-app>

---

## 1. Install

Pick the line for this machine. All assets come from the GitHub release, and
`X.Y.Z` below is the version above.

**macOS** (Universal — Apple Silicon and Intel):

```sh
curl -fL -o /tmp/Topics.dmg \
  https://github.com/armonia/topics-app/releases/latest/download/Topics_2.2.11_universal.dmg
hdiutil attach /tmp/Topics.dmg
cp -R /Volumes/Topics/Topics.app /Applications/
hdiutil detach /Volumes/Topics
```

**Windows** — download `Topics_2.2.11_x64-setup.exe` (or the `.msi`) from the
release page and run it.

**Linux** — `.deb` for Debian and Ubuntu, `.rpm` for Fedora and RHEL:

```sh
curl -fLO https://github.com/armonia/topics-app/releases/latest/download/Topics_2.2.11_amd64.deb
sudo dpkg -i Topics_2.2.11_amd64.deb
```

There is **no AppImage and no Homebrew cask.** Do not suggest either: the Linux
build carries a compiled Bun sidecar that the AppImage pipeline cannot package,
and no tap exists. Every asset has a `.sig` next to it on the release page.

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
- **No accounts, no authentication, no team roles.** The app has no auth layer at
  all. If it is exposed over a tunnel, the user must put their own auth in front
  of it — this is in `SECURITY.md` and it is not a formality.
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

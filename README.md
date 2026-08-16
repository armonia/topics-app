# Topics

> A desktop workspace for [Claude Code](https://claude.com/claude-code) and other CLI coding agents — organize your sessions into focused topics, each with its own project context, terminal, and browser.
>
> An open, **agent-first** alternative to Cursor, Windsurf & co.: instead of wrapping an editor around a model, Topics is a home for the terminal AI agents you already run.

<!-- Optional: drop a screenshot or short GIF here once available -->
<!-- ![Topics screenshot](docs/screenshot.png) -->

## Download

Grab the latest build for your platform from the **[latest release](https://github.com/armonia/topics-app/releases/latest)**:

| Platform | File |
|----------|------|
| **macOS** (Universal: Apple Silicon + Intel) | `.dmg` |
| **Windows** | `.exe` installer (also `.msi` on the Tauri channel) |
| **Linux** | `.deb` · `.rpm` |

All builds and their checksums live on the [Releases](https://github.com/armonia/topics-app/releases) page.

There is no `.AppImage`: the Linux build carries a compiled Bun sidecar that AppImage's `linuxdeploy` step cannot package, so CI builds `deb,rpm` only.

> **v2 = Tauri.** Starting with **v2.0.0** the desktop app ships as a [Tauri](https://tauri.app) shell (`desktop-tauri/`), released from `tauri-vX.Y.Z` tags (release names "Topics (Tauri) …"). The older **Electron** shell was **archived in v2.0.0** — its source is preserved on the `electron-archive` branch and can be restored from there if ever needed. The legacy Electron installers (`v*` tags) remain downloadable on the Releases page but are no longer built or updated.

> **macOS first launch.** Builds are not notarized yet, so macOS refuses the first launch with *"Apple could not verify Topics is free of malware"*. Since macOS Sequoia the Control-click → Open bypass **no longer works** — the path that does is: **System Settings → Privacy & Security →** scroll to **Security → Open Anyway →** authenticate → **Open** in the dialog that follows. You only do this once. Windows SmartScreen may ask you to confirm.

## Auto-update

Topics checks GitHub Releases for new versions. Use **menu → Check for Updates**: the app downloads the update once you confirm, then installs it on restart. Updates are never applied silently.

## What it does

- **Topic-based organization** — group your Claude Code / agent sessions by project or context, in tabs
- **Project integration** — file explorer, Git changes, an embedded terminal (run your agent here) and browser per topic
- **Agent monitoring** — see every session's state and get notified when an agent finishes or needs you
- **Context visualization** — see how much context each session is using
- **Bring your own agent & keys** — drives the `claude-code` and `codex` CLIs already installed on your machine (covered by your subscription, no API bill), or talks to the Anthropic (`claude`) and OpenAI (`openai`) APIs with your own keys, or relays through an optional `openclaw` gateway

## Running agents without the CLI

By default Topics runs agents **inside its own server** instead of spawning one
`claude`/`codex` process per session. It reuses the credentials the CLI already
wrote (`~/.claude/.credentials.json` or `~/.jcode/auth.json`) — you still log in
with `claude` → `/login`; Topics only reads that file. Set the runtime back to
`cli` in Settings if you prefer a process per agent.

The difference is what a session *costs*, measured on the same machine
(12 cores / 34 GB, macOS) with real turns, same model on both sides:

| | CLI (one process per agent) | Native runtime |
|---|---|---|
| Memory per session | ~432 MB | **0.25–0.9 MB** |
| 64 sessions at once | not attempted | **4.1–4.7 s**, 64/64 answered |

The marginal cost stays flat from 8 to 64 concurrent sessions, and the
wall-clock time grows far slower than the session count: the network dominates,
not the machine. Those ranges come from four runs across three independent
servers — a single run looks tighter than the thing really is. Two honest
caveats. The 64-session row was measured on the native runtime only, so read it
as "this is what the native runtime does", not as a race it won. And the first
turn on a cold server costs ~11 MB (code paths running for the first time),
which is warm-up, not the price of a session. Raw numbers, every run and what
each does *not* prove, are in [`bench/results/`](bench/results/):

```bash
# An ISOLATED server: pointing this at your dev server creates real topics in
# your real database. Credentials must be in place BEFORE it starts — the test
# server sandboxes HOME, and one started without them answers every turn with
# "Not logged in" while still looking healthy.
export DATA_DIR=/tmp/bench-conc BUN_PORT=39480
mkdir -p "$DATA_DIR/.home/.jcode" && cp ~/.jcode/auth.json "$DATA_DIR/.home/.jcode/"
TOPICS_HOME="$DATA_DIR/.topics-home" ./scripts/start-test-server.sh &

scripts/bench/native-concurrency.sh --base https://127.0.0.1:39480 --scale 8,32,64
```

Concurrency is still capped by a **CPU** policy (roughly `cores / 3`), not by
memory: an agent that compiles burns real cores even when its session is just an
array in RAM, and half the machine is deliberately left to the person using it.

## Configuration

Topics reads configuration from environment variables (or a `.env` file). Copy `.env.example` to `.env` and set what you need:

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Local server port | `3333` |
| `AI_PROVIDER` | Pins one provider: `claude-code`, `codex`, `claude`, `openai` or `openclaw`. Leave it unset. Unset is not a ranking: the default is decided by your keys (`ANTHROPIC_API_KEY` → `claude`, else `OPENAI_API_KEY` → `openai`, else `GATEWAY_URL` → `openclaw`, else `claude`), and it stays the default for as long as it is connected. The subscription-first order `claude-code` → `codex` → `claude` → `openai` → `openclaw` only picks the REPLACEMENT once the current default goes offline, so with a key set the CLIs above it never get a turn. A pin beats connectivity, so a pinned provider that is offline stays the target and its chats never answer | first key set, else `claude` |
| `GATEWAY_TOKEN` | OpenClaw gateway token (required when `AI_PROVIDER=openclaw`) | — |
| `GATEWAY_URL` | OpenClaw gateway URL | `http://127.0.0.1:18789` |
| `ANTHROPIC_API_KEY` | Anthropic API key (required when `AI_PROVIDER=claude`) | — |
| `CLAUDE_MODEL` | Model id for the `claude` provider | — |
| `OPENAI_API_KEY` | OpenAI API key (required when `AI_PROVIDER=openai`) | — |
| `OPENAI_MODEL` | Model id for the `openai` provider | — |
| `ELEVENLABS_API_KEY` | ElevenLabs key — text-to-speech, and Scribe v2 dictation/speech-to-text (optional) | — |
| `STT_PROVIDER` | Speech-to-text engine: `auto` tries ElevenLabs Scribe v2 → OpenAI `gpt-transcribe` → Deepgram Nova-3 → Groq Whisper turbo → local whisper.cpp, using whichever keys you have. Pin one (`openai`) or set an order (`openai,local`) | `auto` |
| `STT_LANGUAGE` | ISO-639-1 dictation language; unset means the model auto-detects | auto |
| `MOONDREAM_API_KEY` | Moondream key — enables browser vision grounding (optional) | — |
| `APP_DATA_DIR` | Where conversations and app data are stored | `~/.openclaw` |

You bring your own keys. Topics stores everything locally — see [PRIVACY.md](PRIVACY.md).

## Build from source

Requires [Bun](https://bun.sh/) and Node.js 20+.

```bash
git clone https://github.com/armonia/topics-app.git
cd topics-app
bun install

# Client (Vite/React/Tailwind) → public/
cd client && bun run build && cd ..

# Run the server
cp .env.example .env   # then edit
bun run start          # http://localhost:3333
```

### Desktop shell — Tauri (primary, v2)

Requires the [Rust toolchain](https://rustup.rs/). Build the client first (above) — Tauri
embeds `public/` as its `frontendDist` at compile time:

```bash
cd desktop-tauri/src-tauri && cargo run          # dev build, embeds public/
```

Package installers locally with the [Tauri CLI](https://tauri.app/reference/cli/)
(`cargo install tauri-cli`):

```bash
cd desktop-tauri && cargo tauri build
```

Official installers are built by CI from `tauri-vX.Y.Z` tags
(`.github/workflows/tauri-release.yml`).

### Desktop shell — Electron (archived)

The Electron shell was **archived in v2.0.0** and its source (`electron-app/`) removed from
`main`. It is fully recoverable on the `electron-archive` branch:

```bash
git checkout electron-archive -- electron-app   # restore the source, or
git switch electron-archive                     # check out the whole pre-removal state
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the dev workflow.

## Security

Topics runs a **local server** and by default listens on **every network interface** — not just localhost. That is what lets you open it from your phone on the same Wi-Fi.

**Other devices must be authorized once.** Open Topics from the new device: it shows a six-character code, your computer shows the matching request, you approve it. Authorization is per device and revocable. The machine Topics runs on is trusted by transport, so you can never lock yourself out of your own computer.

Authentication says who may use Topics — it does not make an untrusted network safe. Run it on a network you trust, and to restrict the server to your own machine set `SERVER_HOST=127.0.0.1`.

**Do not expose Topics to the public internet.** If you use remote-access tooling (Tailscale, Cloudflare Tunnel, etc.), put your own authentication in front of it. To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Legal

Topics is open source under the [MIT License](LICENSE) — provided **"as is", without warranty of any kind**.

Topics is an independent project by [Armonia](https://armonia.io). It is **not affiliated with or endorsed by** Anthropic, OpenClaw, or ElevenLabs. Those names and marks belong to their respective owners. Topics talks to third-party services using **keys and accounts you provide**, and your use of them is governed by each provider's own terms. See [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) and [PRIVACY.md](PRIVACY.md).

MIT © [Armonia](https://armonia.io)

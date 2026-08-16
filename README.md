# Topics

> A desktop home for the coding agents you already run — Claude Code, Codex and
> friends — with every session in its own topic: its project, its terminal, its
> browser.
>
> Agents run **inside Topics**, not as one process each: **200 sessions
> answering at once fit in 162 MB of RAM** ([measured](#running-agents-without-the-cli)).
> An open, agent-first alternative to Cursor & co. — instead of wrapping an
> editor around a model, Topics is a home for the agents themselves.

<!-- Optional: drop a screenshot or short GIF here once available -->
<!-- ![Topics screenshot](docs/screenshot.png) -->

## Download

Grab the latest build for your platform from the **[latest release](https://github.com/armonia/topics-app/releases/latest)**:

| Platform | File |
|---|---|
| **macOS** (Apple Silicon + Intel) | `.dmg` |
| **Windows** | `.exe` (also `.msi`) |
| **Linux** | `.deb` · `.rpm` — no AppImage: the build carries a compiled Bun sidecar that `linuxdeploy` cannot package |

> **macOS first launch.** Builds are not notarized yet, so macOS refuses the
> first launch. The Control-click → Open bypass no longer works since Sequoia:
> go to **System Settings → Privacy & Security → Open Anyway**, authenticate,
> then **Open**. Once only. Windows SmartScreen may ask you to confirm.

Topics checks GitHub Releases for updates and installs them on restart once you
confirm — never silently.

## What it does

- **Topics, not tabs** — group agent sessions by project or context, each with its own file explorer, Git changes, terminal and browser
- **See every agent at once** — state, context used, and a notification when one finishes or needs you
- **Agents without the process tax** — sessions live inside the server, so a hundred of them cost less than one CLI
- **Your agent, your keys** — drives the `claude-code` and `codex` CLIs you already have (covered by your subscription, no API bill), or the Anthropic and OpenAI APIs with your own keys

## Running agents without the CLI

**200 agent sessions, answering at once, in 162 MB of RAM.** Measured, not
estimated — see the numbers below.

By default Topics runs agents **inside its own server** instead of spawning one
`claude`/`codex` process per session. It reuses the credentials the CLI already
wrote (`~/.claude/.credentials.json` or `~/.jcode/auth.json`) — you still log in
with `claude` → `/login`; Topics only reads that file. Set the runtime back to
`cli` in Settings if you prefer a process per agent.

The difference is what a session *costs*. Measured on the same machine
(12 cores / 34 GB, macOS), same model, same trivial turn, **same session count**
on both sides:

| | CLI — one process per agent | Native runtime |
|---|---|---|
| **Memory per session** (3 sessions) | ~432 MB | **2.3 MB** — about **188x** less |

Pushed further, the native runtime gets *cheaper per session* as the count
rises: the fixed cost of a turn spreads. Runs across independent servers, every
turn checked for a real answer:

| Concurrent sessions | Answered | Memory per session | Whole server | Wall clock |
|---|---|---|---|---|
| 8 | 8/8 | 0.7–2.7 MB | | ~2 s |
| 32 | 32/32 | 0.8–1.0 MB | | ~2.9 s |
| 64 | 64/64 | 0.25–0.9 MB | | 3.9–4.7 s |
| **100** | **100/100** | 0.87 MB | 101 → **135 MB** | **5.1 s** |
| **200** | **200/200** | 0.71 MB | → **162 MB** | **5.6 s** |

Time grows far slower than the session count, because the network dominates, not
the machine. For scale: 200 CLI processes at the measured 432 MB each would be
~86 GB — an arithmetic projection, not a run. It is also why that comparison was
never attempted.

**Three things this does not prove.** The 188x is the only honest cross-runtime
number: it compares equal session counts. Do not pair the 432 MB with the 64-way
figures — the CLI was never put through that run, so there is no "who wins under
load" answer here. And the first turn on a cold server costs ~11 MB, which is
warm-up, not the price of a session.

Every run, and what each one fails to show, is in
[`bench/results/`](bench/results/). To reproduce:

```bash
# An ISOLATED server: pointing this at your dev server creates real topics in
# your real database. Credentials must be in place BEFORE it starts — the test
# server sandboxes HOME, and one started without them answers every turn with
# "Not logged in" while still looking healthy. The script's preflight catches
# that before it spends 64 turns on it.
export DATA_DIR=/tmp/bench-conc BUN_PORT=39480
mkdir -p "$DATA_DIR/.home/.claude"
cp ~/.claude/.credentials.json "$DATA_DIR/.home/.claude/"   # or ~/.jcode/auth.json → .home/.jcode/
TOPICS_HOME="$DATA_DIR/.topics-home" ./scripts/start-test-server.sh &

scripts/bench/native-concurrency.sh --base https://127.0.0.1:39480 --scale 8,32,64
```

> Copying a live `~/.claude/.credentials.json` whose access token has **expired**
> makes the test server refresh it — and the refresh token *rotates*, which
> breaks your real `claude` login. Use a credential that is still valid, or
> expect to run `/login` again.

Concurrency is still capped by a **CPU** policy (roughly `cores / 3`), not by
memory: an agent that compiles burns real cores even when its session is just an
array in RAM, and half the machine is deliberately left to the person using it.

## Configuration

**You don't need any of this to start.** Provider, model and API keys are in
**Settings**, and what you set there always wins over the environment. The
variables below exist for headless runs, CI and containers — places without a
window to click in.

Copy `.env.example` to `.env` if you need them.

| Variable | Description | Default |
|---|---|---|
| `PORT` | Local server port | `3333` |
| `APP_DATA_DIR` | Where conversations and app data are stored | `~/.openclaw` |
| `ANTHROPIC_API_KEY` | Anthropic API key — only for the direct `claude` provider, not for the CLI or the native runtime | — |
| `OPENAI_API_KEY` | OpenAI API key — only for the direct `openai` provider | — |
| `ELEVENLABS_API_KEY` | Text-to-speech and Scribe v2 dictation | — |
| `MOONDREAM_API_KEY` | Browser vision grounding | — |

<details>
<summary>Advanced: provider pinning, models, gateway, dictation</summary>

Every row here has a **Settings** equivalent that overrides it. Reach for these
only when there is no UI to reach for.

| Variable | Description | Default |
|---|---|---|
| `AI_PROVIDER` | Pins one provider (see below) | auto |
| `CLAUDE_MODEL` | Model id for the `claude` provider | — |
| `OPENAI_MODEL` | Model id for the `openai` provider | — |
| `GATEWAY_URL` | OpenClaw gateway URL | `http://127.0.0.1:18789` |
| `GATEWAY_TOKEN` | OpenClaw gateway token (required with `AI_PROVIDER=openclaw`) | — |
| `STT_PROVIDER` | Dictation engine: `auto`, one name (`openai`), or an order (`openai,local`) | `auto` |
| `STT_LANGUAGE` | ISO-639-1 dictation language | auto-detect |

**How the default provider is picked when `AI_PROVIDER` is unset.** Your keys
decide: `ANTHROPIC_API_KEY` → `claude`, else `OPENAI_API_KEY` → `openai`, else
`GATEWAY_URL` → `openclaw`, else `claude`. That choice stays for as long as it
is connected.

The subscription-first order `claude-code` → `codex` → `claude` → `openai` →
`openclaw` only picks the **replacement** once the current default goes offline
— so with an API key set, the CLIs above it never get a turn.

**Pinning beats connectivity.** A pinned provider that is offline stays the
target, and its chats never answer. That is deliberate: a pin is an instruction,
not a preference.

`STT_PROVIDER=auto` tries ElevenLabs Scribe v2 → OpenAI `gpt-transcribe` →
Deepgram Nova-3 → Groq Whisper turbo → local whisper.cpp, using whichever keys
you have.

</details>

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

### Desktop shell (Tauri)

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
(`.github/workflows/tauri-release.yml`). The pre-v2 Electron shell was archived
in v2.0.0 and lives on the `electron-archive` branch.

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

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
| **Linux** | `.AppImage` · `.deb` (Tauri also ships `.rpm`) |

All builds and their checksums live on the [Releases](https://github.com/armonia/topics-app/releases) page.

> **v2 = Tauri.** Starting with **v2.0.0** the desktop app ships as a [Tauri](https://tauri.app) shell (`desktop-tauri/`), released from `tauri-vX.Y.Z` tags (release names "Topics (Tauri) …"). The older **Electron** shell was **archived in v2.0.0** — its source is preserved on the `electron-archive` branch and can be restored from there if ever needed. The legacy Electron installers (`v*` tags) remain downloadable on the Releases page but are no longer built or updated.

> On first launch macOS may warn that the app is from an unidentified developer — right-click the app and choose **Open**. Windows SmartScreen may ask you to confirm. (Signed/notarized builds are tracked in the issues.)

## Auto-update

Topics checks GitHub Releases for new versions. Use **menu → Check for Updates**: the app downloads the update once you confirm, then installs it on restart. Updates are never applied silently.

## What it does

- **Topic-based organization** — group your Claude Code / agent sessions by project or context, in tabs
- **Project integration** — file explorer, Git changes, an embedded terminal (run your agent here) and browser per topic
- **Agent monitoring** — see every session's state and get notified when an agent finishes or needs you
- **Context visualization** — see how much context each session is using
- **Bring your own agent & keys** — works against the Anthropic API directly, or via an optional OpenClaw gateway

## Configuration

Topics reads configuration from environment variables (or a `.env` file). Copy `.env.example` to `.env` and set what you need:

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Local server port | `3333` |
| `AI_PROVIDER` | `claude`, `openai`, or `openclaw` — when unset, auto-detected from available keys (`ANTHROPIC_API_KEY` → `claude`, else `OPENAI_API_KEY` → `openai`, else `openclaw` only if `GATEWAY_URL` is set) | `claude` |
| `GATEWAY_TOKEN` | OpenClaw gateway token (required when `AI_PROVIDER=openclaw`) | — |
| `GATEWAY_URL` | OpenClaw gateway URL | `http://127.0.0.1:18789` |
| `ANTHROPIC_API_KEY` | Anthropic API key (required when `AI_PROVIDER=claude`) | — |
| `CLAUDE_MODEL` | Model id for the `claude` provider | — |
| `OPENAI_API_KEY` | OpenAI API key (required when `AI_PROVIDER=openai`) | — |
| `OPENAI_MODEL` | Model id for the `openai` provider | — |
| `ELEVENLABS_API_KEY` | ElevenLabs key — enables text-to-speech (optional) | — |
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

Topics runs a **local server with no built-in authentication or access control**, and by default it listens on **every network interface** — not just localhost. That is what lets you open it from your phone on the same Wi-Fi. It also means **anyone who can reach the port has full control**: your files, your terminals, your API keys.

**The network is the boundary.** Run Topics on a network you trust. To restrict it to your own machine, set `SERVER_HOST=127.0.0.1`.

**Do not expose Topics to the public internet.** If you use remote-access tooling (Tailscale, Cloudflare Tunnel, etc.), put your own authentication in front of it. To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Legal

Topics is open source under the [MIT License](LICENSE) — provided **"as is", without warranty of any kind**.

Topics is an independent project by [Armonia](https://armonia.io). It is **not affiliated with or endorsed by** Anthropic, OpenClaw, or ElevenLabs. Those names and marks belong to their respective owners. Topics talks to third-party services using **keys and accounts you provide**, and your use of them is governed by each provider's own terms. See [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) and [PRIVACY.md](PRIVACY.md).

MIT © [Armonia](https://armonia.io)

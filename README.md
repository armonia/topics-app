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
| **macOS** (Apple Silicon / Intel) | `Topics-*.dmg` |
| **Windows** | `Topics-Setup-*.exe` |
| **Linux** | `Topics-*.AppImage` · `.deb` |

All builds and their checksums live on the [Releases](https://github.com/armonia/topics-app/releases) page.

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
| `AI_PROVIDER` | `openclaw` or `claude` | `openclaw` |
| `GATEWAY_TOKEN` | OpenClaw gateway token (required when `AI_PROVIDER=openclaw`) | — |
| `GATEWAY_URL` | OpenClaw gateway URL | `http://127.0.0.1:18789` |
| `ANTHROPIC_API_KEY` | Anthropic API key (required when `AI_PROVIDER=claude`) | — |
| `CLAUDE_MODEL` | Model id for the `claude` provider | — |
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

Desktop shell (Electron):

```bash
cd electron-app && npm install && npm start
```

Package installers for the current OS (publishes to GitHub Releases when `GH_TOKEN` is set):

```bash
cd electron-app && npm run build
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the dev workflow.

## Security

Topics runs a **local server with no built-in authentication or access control**. It is meant to run on your own machine, bound to localhost.

**Do not expose Topics to the public internet.** If you use remote-access tooling (Tailscale, Cloudflare Tunnel, etc.), put your own authentication in front of it. To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Legal

Topics is open source under the [MIT License](LICENSE) — provided **"as is", without warranty of any kind**.

Topics is an independent project by [Armonia](https://armonia.io). It is **not affiliated with or endorsed by** Anthropic, OpenClaw, or ElevenLabs. Those names and marks belong to their respective owners. Topics talks to third-party services using **keys and accounts you provide**, and your use of them is governed by each provider's own terms. See [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) and [PRIVACY.md](PRIVACY.md).

MIT © [Armonia](https://armonia.io)

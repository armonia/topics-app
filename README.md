# Topics

> A powerful companion app for [OpenClaw](https://github.com/openclaw/openclaw) — organize your AI conversations into focused topics with project context.

## Features

- 🗂️ **Topic-based organization** — Group related conversations by project or context
- 🖥️ **Multi-panel layout** — Work on multiple topics side-by-side
- 📁 **Project integration** — File explorer, Git changes, and process monitoring
- 🌐 **Integrated browser** — Browse the web without leaving the app
- ⏰ **Cron Jobs** — View and manage scheduled tasks
- 🌍 **Remote Access** — Share your Topics instance via Tailscale or Cloudflare Tunnel
- 📊 **Context visualization** — See how much context each conversation uses
- 📱 **Mobile-friendly** — Responsive design works on any device
- 🔔 **Unread badges** — Never miss new messages

## Quick Start

### Prerequisites

- [Bun](https://bun.sh/) or Node.js 18+
- [OpenClaw](https://github.com/openclaw/openclaw) running locally

### Installation

```bash
# Clone the repository
git clone https://github.com/armonia/topics-app.git
cd topics-app

# Install dependencies
bun install

# Build the client
cd client && bun run build && cd ..

# Copy and edit environment config
cp .env.example .env

# Start the server
bun run server.ts
```

The server will start at `http://localhost:3333`.

### Desktop App (Electron)

```bash
cd electron-app
npm install
npm start
```

## Configuration

Copy `.env.example` to `.env` and customize:

```bash
cp .env.example .env
```

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | `3333` |
| `HOST` | Server host | `localhost` |
| `OPENCLAW_GATEWAY_URL` | OpenClaw gateway URL | `http://localhost:3000` |

## Development

```bash
# Start dev server with hot reload
bun run dev

# Build client
cd client && bun run build

# Start Electron in dev mode
cd electron-app && npm start
```

## Architecture

```
topics-app/
├── client/          # React frontend (Vite + TypeScript + Tailwind)
├── electron-app/    # Desktop wrapper with browser integration
├── server.ts        # Backend server (Bun/Node)
├── public/          # Static assets
└── messages/        # Stored conversations (gitignored)
```

## Integration with OpenClaw

Topics integrates seamlessly with OpenClaw:

1. **Session bridging** — Each topic creates an isolated OpenClaw session
2. **Tool access** — Full access to OpenClaw tools (browser, exec, files, etc.)
3. **Context management** — Custom system prompts per topic/project
4. **Cron jobs** — View and manage OpenClaw scheduled tasks

## Auto-Update

Topics can auto-update from git:

```bash
# In the app menu: View → Check for Updates
# Or manually:
git pull origin main
```

## Remote Access

### Tailscale Funnel

```bash
tailscale funnel 3333
```

### Cloudflare Tunnel

```bash
cloudflared tunnel --url http://localhost:3333
```

## Security

Topics is a **local development tool** designed to run on your own machine. It does not include authentication or access control on its API endpoints.

**Do not expose Topics to the public internet without additional security measures.** If you use remote access features (Tailscale, Cloudflare Tunnel), ensure you have appropriate authentication in place.

If you discover a security vulnerability, please report it privately by opening a GitHub issue marked as confidential rather than disclosing it publicly.

## Contributing

Pull requests are welcome! Please read our [Contributing Guide](CONTRIBUTING.md) first.

## License

MIT © [Armonia](https://armonia.io)

---

Made with ❤️ by [Armonia](https://armonia.io) for the [OpenClaw](https://openclaw.ai) community.

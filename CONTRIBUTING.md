# Contributing to Topics

Thanks for your interest in contributing! Here's how you can help.

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/YOUR_USERNAME/topics-app.git`
3. Install dependencies: `bun install`
4. Start the server: `bun run server.ts`
5. Build the client: `cd client && bun run build`

## Development Workflow

### Client changes (React/TypeScript)

```bash
cd client && bun run build
```

The server serves static files from `public/`. You must rebuild after client changes.

### Server changes

```bash
pkill -f "bun run server.ts"; sleep 1
bun run server.ts &
```

### Electron changes

```bash
cd electron-app && npm install && npm start
```

## Submitting Changes

1. Create a feature branch: `git checkout -b feature/your-feature`
2. Make your changes
3. Test locally (server + client build)
4. Commit with a clear message
5. Push and open a Pull Request

## Code Style

- TypeScript strict mode is enabled
- Use existing patterns in the codebase
- No unused variables (prefix with `_` if intentionally unused)

## Reporting Issues

Open an issue with:
- Steps to reproduce
- Expected vs actual behavior
- Browser/OS information

## Security

If you find a security vulnerability, please report it privately rather than opening a public issue. See [SECURITY.md](SECURITY.md) for how to report it.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.

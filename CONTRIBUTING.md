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

## Releasing

Maintainers cut a release by tagging a version. CI (`.github/workflows/release.yml`)
then builds and publishes installers for macOS, Windows, and Linux to the GitHub
Release, along with the `latest*.yml` manifests that power in-app auto-update.

```bash
# 1. Bump the version in electron-app/package.json — it MUST equal the tag,
#    or electron-updater compares against the wrong manifest and won't match.
# 2. Tag and push:
git tag -a v1.2.3 -m "v1.2.3" && git push origin v1.2.3
```

**macOS is a single Universal build** (`--mac --universal`): one
`Topics-<version>-universal.dmg` that runs natively on both Apple Silicon and
Intel. GitHub retired the Intel (`macos-13`) runner, so x64 is no longer built on
its own machine; instead `scripts/stage-server-dist.mjs` (run with
`STAGE_UNIVERSAL=1`) downloads each architecture's official **bun** and **node**
and `lipo`s them into fat binaries, while `node-pty` ships both macOS prebuilds.

Two `@electron/universal` merge requirements are baked into the build — **don't
remove them**:

1. The universal staging **strips symlinks** from the bundled `node_modules`
   (the `.bin/*` CLI shims otherwise break the merge with *"the number of mach-o
   files is not the same between arm64 and x64"*). The server resolves modules by
   directory, so this is safe.
2. `electron-app/package.json` sets `mac.x64ArchFiles: "**/server/**"` — the fat
   `bun`/`node` and single-arch `node-pty` prebuilds are identical across both
   architecture trees, so they must be allow-listed as leave-as-is.

Verify a universal build locally before tagging (on an Apple Silicon Mac):

```bash
cd electron-app && bun run build:ts && STAGE_UNIVERSAL=1 bun run stage:server \
  && npx electron-builder --mac --universal --publish never
lipo -archs dist/mac-universal/Topics.app/Contents/MacOS/Topics   # → x86_64 arm64
```

(The local DMG step needs `python` on `PATH`, which dev macOS may lack but the CI
runner has — the merge and the resulting universal `.app` are what matter.)

The bundled server is shipped as a real `bun`+`node` runtime plus source and
`node_modules` (electron-builder `extraResources` → `Resources/server/`), **not**
`bun build --compile` (which breaks the node-pty bridge, the MCP subprocess, and
`import.meta.dir` resolution). macOS code-signing/notarization (needed for
auto-update to self-replace and to avoid a Gatekeeper warning) requires the Apple
signing secrets to be set in CI; unsigned builds still run.

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

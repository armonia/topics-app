# Third-Party Notices

Topics is distributed under the [MIT License](LICENSE). It bundles and depends on third-party software and connects to third-party services, each governed by its own license and terms.

## Bundled / packaged software

The desktop application embeds:

- **Electron** and the bundled **Chromium** and **Node.js** runtimes — Electron and Node.js are MIT-licensed; Chromium and its components are distributed under the BSD 3-Clause license and other licenses. The full set of component licenses is included inside the packaged application.

At runtime / build time Topics also uses, among others:

- `@anthropic-ai/sdk` (Anthropic SDK) — MIT
- `electron-updater` / `electron-builder` — MIT
- `node-pty` — MIT
- `playwright-core` — Apache-2.0
- `web-push` — MPL-2.0
- `zod` — MIT
- **React**, **Vite**, **Tailwind CSS** (client) — MIT
- **Bun** (server runtime) — MIT

Each package is © its respective authors and provided under its own license. Refer to each project's repository for the authoritative license text.

## Third-party services

Topics can connect to the following services **using credentials you supply**. Topics does not provide, proxy, or pay for access to any of them — you bring your own keys/accounts, and your use is governed by each provider's terms:

- **Anthropic API** (Claude) — the primary backend, used in `claude` mode with your `ANTHROPIC_API_KEY`.
- **OpenClaw** — an optional gateway backend, used in `openclaw` mode.
- **ElevenLabs** — optional text-to-speech, with your `ELEVENLABS_API_KEY`.
- **Moondream** — optional browser vision grounding, with your `MOONDREAM_API_KEY`.

You are responsible for complying with each provider's terms of service, acceptable-use policies, and any usage costs.

## Trademarks & non-endorsement

"OpenClaw", "Anthropic", "Claude", "ElevenLabs", "Moondream", and other names and logos are trademarks of their respective owners. Topics is an **independent** project by Armonia and is **not affiliated with, sponsored by, or endorsed by** any of these companies. Names are used only to describe interoperability.

# Third-Party Notices

Topics is distributed under the [MIT License](LICENSE). It bundles and depends on third-party software and connects to third-party services, each governed by its own license and terms.

## Bundled / packaged software

The desktop app (v2 and later) is a **Tauri** shell: a small Rust binary that renders the UI in the webview the operating system already provides. No browser engine is bundled, so which engine runs the UI depends on the platform:

- **macOS**: **WKWebView**, part of the system WebKit framework. Provided and updated by Apple.
- **Windows**: the **Microsoft Edge WebView2** Runtime. Installed and updated by Microsoft under its own terms.
- **Linux**: **WebKitGTK**, LGPL-2.1-or-later (with BSD-2-Clause parts). Topics links against the copy installed on the machine, dynamically and unmodified, which keeps the LGPL relinking right intact. This is the only LGPL obligation the *shell* carries; the compiled server sidecar below carries another one, on every platform.

The Rust side is **Tauri** and its official plugins, plus **wry** / **tao** for the webview, and **tokio**, **native-tls**, **sysinfo**, the **objc2** stack (macOS), **webview2-com** and **windows** (Windows), **webkit2gtk**, **javascriptcore-rs**, **cairo-rs**, **glib**, **gio**, **soup3** (Linux). These crates are dual MIT or Apache-2.0 unless their repository says otherwise.

The installers also carry three compiled sidecar binaries, listed under `bundle.externalBin` in the Tauri config:

- **topics-server**: the Bun server compiled to a standalone binary with `bun build --compile`. **Bun** itself is MIT, but that build statically embeds Bun's JavaScript engine, **JavaScriptCore** (part of WebKit), into the binary: LGPL-2.1-or-later, with BSD-2-Clause and Apache-2.0 parts. This applies to the macOS, Windows and Linux installers alike, and it is a *static* link, so it is the notice obligation that travels furthest. WebKit's sources, including the exact revision Bun builds, are published at [github.com/oven-sh/webkit](https://github.com/oven-sh/webkit).
- **pty-bridge**: a Rust daemon that spawns the shell and agent PTYs. Built on **portable-pty** (MIT).
- **webrtc-bridge**: a Rust daemon that shares one server-side browser pane over WebRTC. Built on **webrtc-rs** (MIT or Apache-2.0), **zune-jpeg** (MIT or Apache-2.0 or Zlib, at your option), and Cisco's **OpenH264** (BSD-2-Clause). H.264 itself is patent-encumbered: the applicable patent terms are Cisco's, published at openh264.org.

At runtime and build time Topics also uses, among others:

Server:

- `@anthropic-ai/sdk` (Anthropic SDK): MIT
- `@xterm/headless`: MIT
- `node-pty`: MIT
- `playwright-core`: Apache-2.0
- `web-push`: MPL-2.0
- `zod`: MIT
- **Bun** (server runtime): MIT

Client:

- `react` and `react-dom`, `vite`, `tailwindcss`: MIT
- `@codemirror/view` and the other CodeMirror 6 packages, `@xterm/xterm`: MIT
- `zustand`, `immer`, `react-virtuoso`, `react-markdown`, `mermaid`, `katex`, `rrweb`: MIT
- `highlight.js`: BSD-3-Clause
- `lucide-react`: ISC

Each package is © its respective authors and provided under its own license. Refer to each project's repository for the authoritative license text.

The legacy Electron installers still listed on the Releases page (the `v*` tags, up to and including the last v1 build) do embed **Electron** with its **Chromium** and **Node.js** runtimes, under the licenses shipped inside those packages. That shell was archived in v2.0.0 and is no longer built or updated.

## Third-party services

Topics can connect to the following services **using credentials you supply**. Topics does not provide, proxy, or pay for access to any of them — you bring your own keys/accounts, and your use is governed by each provider's terms. There is no default backend: a fresh install talks to nothing until you either have one of these CLIs on your PATH or set one of these keys.

Agent backends:

- **Anthropic** (Claude) — reached two ways. In `claude-code` mode Topics drives the `claude` CLI already installed on your machine, which signs in with your own Claude account or key. In `claude` mode it calls the Anthropic API directly with your `ANTHROPIC_API_KEY`.
- **OpenAI** — reached two ways as well. In `codex` mode Topics drives the `codex` CLI installed on your machine, signed in with your own ChatGPT account or key. In `openai` mode it calls the OpenAI API with your `OPENAI_API_KEY`.
- **OpenClaw** — an optional gateway backend, used in `openclaw` mode, running wherever you point `GATEWAY_URL`.
- **ACP agents** (Gemini and friends) — optional, registered only when the agent's own executable is on your machine, and driven with whatever credentials that executable already holds.

Optional extras:

- **ElevenLabs** — text-to-speech, and speech-to-text dictation, with your `ELEVENLABS_API_KEY`.
- **OpenAI**, **Deepgram**, **Groq** — alternative dictation engines, each used only when its key is set (`OPENAI_API_KEY`, `DEEPGRAM_API_KEY`, `GROQ_API_KEY`). With no key at all, dictation falls back to whisper.cpp running locally.
- **Moondream** — browser vision grounding, with your `MOONDREAM_API_KEY`.

You are responsible for complying with each provider's terms of service, acceptable-use policies, and any usage costs.

## Trademarks & non-endorsement

"OpenClaw", "Anthropic", "Claude", "OpenAI", "ChatGPT", "Codex", "Gemini", "ElevenLabs", "Deepgram", "Groq", "Moondream", and other names and logos are trademarks of their respective owners. Topics is an **independent** project by Armonia and is **not affiliated with, sponsored by, or endorsed by** any of these companies. Names are used only to describe interoperability.

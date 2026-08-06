# Privacy

Topics is **local-first**. Your conversations, topics, and project context are stored on your own machine and are not sent to Armonia.

## What Topics stores, and where

- Conversations, topics, settings, and related data are stored locally under your app data directory (`APP_DATA_DIR`, default `~/.openclaw`).
- Nothing is uploaded to any Armonia-operated server.

## Telemetry

Topics contains **no analytics and no telemetry**. We do not collect usage statistics, crash reports, or any data about you.

## Network connections

Topics only makes outbound network requests to the services **you configure**:

- The Anthropic API (in `claude` mode), and/or an optional OpenClaw gateway (`GATEWAY_URL`).
- Optional services you enable: ElevenLabs (TTS), Moondream (browser vision).
- GitHub Releases, to check for and download application updates.

When Topics talks to these services, the relevant data (e.g. your prompts) is handled under **that provider's** privacy policy and terms. Review them before sending sensitive information.

## Your responsibility

Topics listens on every network interface by default, so your phone on the same Wi-Fi can reach it — but any device other than your own computer must be **authorized once, by you, from that computer**, and can be revoked at any time. An authorized device has your powers: it can read your local data. Approve only devices you control. Run Topics on a network you trust, do not expose it to the public internet, and to restrict it to your own machine set `SERVER_HOST=127.0.0.1` (see [SECURITY.md](SECURITY.md)).

---

_This document describes the Topics application's behavior. It is not legal advice and does not modify the [MIT License](LICENSE)._

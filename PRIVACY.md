# Privacy

Topics is **local-first**. Your conversations, topics and project context live on your own machine. Armonia sees them only if you turn on the paid relay and use ours, which routes traffic from outside your network through our infrastructure.

## What Topics stores, and where

- Conversations, topics, settings, and related data are stored locally under your app data directory (`APP_DATA_DIR`, default `~/.openclaw`).
- The app does not upload them anywhere on its own.

## Analytics

The app does not collect usage statistics or crash reports.

## The relay, if you subscribe

Reaching Topics from outside your own network is a paid feature, and it works by routing traffic through a relay. If you use the one Armonia operates, that traffic passes through our infrastructure; `TOPICS_RELAY_URL` lets you point at your own instead. Billing goes through Stripe, which receives what it needs to charge you.

Everything local keeps working with the relay off, or with the subscription expired, or with our servers down: the licence is verified offline against a signed token, and an unreadable or expired token falls back to the full free plan.

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

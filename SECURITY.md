# Security Policy

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report privately via GitHub Security Advisories:
[**Report a vulnerability**](https://github.com/armonia/topics-app/security/advisories/new)

If you cannot use GitHub Advisories, email **security@armonia.io** with details and, if possible, a proof of concept. We aim to acknowledge reports within 5 business days and to coordinate a fix and disclosure timeline with you.

## Scope

Topics is a **local-first** application that runs a server with **no built-in authentication** on your own machine. By default that server listens on **every network interface**, not only `localhost`, so any device that can reach its port can use it — including your phone on the same Wi-Fi, which is a deliberate feature.

**The network is the security boundary.** Topics does not try to be safe on a network you do not control. Run it on a trusted network, or restrict it to your own machine by setting `SERVER_HOST=127.0.0.1`.

- **Out of scope: anything reachable by an attacker who is already on your network.** With access to the port, they can read and write files, drive terminals, and run commands. This is by design, not a defect: there is no authentication layer to bypass. Exposing Topics to an untrusted network — or to the public internet through a tunnel — without putting your own authentication in front of it is your responsibility.
- Issues in third-party services Topics connects to (OpenClaw, Anthropic, ElevenLabs, Moondream) should be reported to those providers.

**In scope: anything that lets a WEB ORIGIN cross the boundary.** A website you visit runs in your browser, on your machine, and can therefore reach the server without being on your network at all. Topics defends against that with a same-origin check on every mutating request and WebSocket upgrade (`server/lib/auth-gate.ts`). A way to make the server accept a state-changing request driven by a page you did not open is a vulnerability — please report it. So is anything that lets a page **read** an `/api` response cross-origin (that is prevented by never emitting `Access-Control-Allow-Origin` for a foreign origin), and anything that exfiltrates API keys or executes code beyond what a local user already controls.

## Supported versions

Security fixes are applied to the latest release. Please upgrade to the newest version before reporting.

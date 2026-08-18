# Security Policy

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report privately via GitHub Security Advisories:
[**Report a vulnerability**](https://github.com/armonia/topics-app/security/advisories/new)

If you cannot use GitHub Advisories, email **security@armonia.io** with details and, if possible, a proof of concept. We aim to acknowledge reports within 5 business days and to coordinate a fix and disclosure timeline with you.

## Scope

Topics is a **local-first** application that runs a server on your own machine. By default that server listens on **every network interface**, not only `localhost`, so your phone on the same Wi-Fi can reach it — which is a deliberate feature.

**Reaching the port is not the same as getting in.** Every device other than the machine Topics runs on must be **authorized once**, from that machine: the new device shows a six-character code, the computer displays the matching request, and you approve it. Authorization is per device and can be revoked at any time. Requests arriving from the machine itself (the desktop shell, the CLI, local tooling) are trusted by transport — that is also what keeps you from locking yourself out.

**Run it on a network you trust anyway.** Authentication controls who can use Topics; it does not make an untrusted network safe. To restrict the server to your own machine, set `SERVER_HOST=127.0.0.1`. Exposing Topics to the public internet through a tunnel remains your responsibility, and is discouraged.

- **Out of scope: what an *authorized* device can do.** An approved device has the owner's powers by design — it can read and write files, drive terminals, and run commands. Approve only devices you control, and revoke the ones you no longer use.
- **Out of scope: `TOPICS_AUTH_OFF=1`.** It disables the checks on purpose, as a recovery hatch.
- Issues in third-party services Topics connects to (OpenClaw, Anthropic, ElevenLabs, Moondream) should be reported to those providers.

**In scope: anything that lets an unauthorized device in** — a way to reach a gated path (`/api`, `/ws`, `/preview`, `/media`, `/uploads`) from another machine without an approved session, to obtain a session without the owner approving it, or to keep using one after it was revoked.

### Which names the server answers to

DNS rebinding does not forge a cross-site request, it makes one genuinely same-site: a page on a name the attacker controls, pointed at `127.0.0.1`, shares your origin and your loopback trust. Topics therefore checks the `Host` header before anything else and answers only to the names it is actually reached by (`server/lib/auth-gate.ts`): an IP literal, `localhost` and `*.localhost`, `*.local` (mDNS), `*.ts.net` (Tailscale), and any hostname you declared in `TOPICS_ALLOWED_ORIGINS`. A request with no `Host` at all is accepted, because only local tooling can omit it — a browser always sends one.

Two consequences worth knowing before you file a bug:

- **A short name without a dot is refused.** `http://macbook:3333` — the name your router or the macOS DNS search may resolve — returns 403, and so do the router-assigned suffixes `.lan` and `.home.arpa`. This is deliberate: those names have no owner, and whoever controls the network's DHCP or resolver decides where they point. Declare the name in `TOPICS_ALLOWED_ORIGINS` (comma-separated, hostname or full origin) and it is accepted.
- **`*.local` is trusted against the *public* DNS, not against your LAN.** The zone is reserved (RFC 6762), so no attacker can register a `.local` name and rebind it. Someone already on your Wi-Fi can still answer mDNS for one — the same neighbour who can already reach the port. Run Topics on a network you trust.

**In scope: anything that lets a WEB ORIGIN cross the boundary.** A website you visit runs in your browser, on your machine, and can therefore reach the server without being on your network at all. Topics defends against that with a same-origin check on every mutating request and WebSocket upgrade (`server/lib/auth-gate.ts`). A way to make the server accept a state-changing request driven by a page you did not open is a vulnerability — please report it. So is anything that lets a page **read** an `/api` response cross-origin (that is prevented by never emitting `Access-Control-Allow-Origin` for a foreign origin), and anything that exfiltrates API keys or executes code beyond what a local user already controls.

## Supported versions

Security fixes are applied to the latest release. Please upgrade to the newest version before reporting.

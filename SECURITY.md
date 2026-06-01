# Security Policy

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report privately via GitHub Security Advisories:
[**Report a vulnerability**](https://github.com/armonia/topics-app/security/advisories/new)

If you cannot use GitHub Advisories, email **security@armonia.io** with details and, if possible, a proof of concept. We aim to acknowledge reports within 5 business days and to coordinate a fix and disclosure timeline with you.

## Scope

Topics is a **local-first** application that runs a server with **no built-in authentication** on your own machine. It is designed to be bound to `localhost`.

- Exposing Topics to untrusted networks without your own authentication layer is **out of scope** (and explicitly discouraged — see the README Security section).
- Issues in third-party services Topics connects to (OpenClaw, Anthropic, ElevenLabs, Moondream) should be reported to those providers.

In scope: anything that lets a local-network or web-origin attacker read/modify your data, exfiltrate API keys, or execute code beyond what a local user already controls.

## Supported versions

Security fixes are applied to the latest release. Please upgrade to the newest version before reporting.

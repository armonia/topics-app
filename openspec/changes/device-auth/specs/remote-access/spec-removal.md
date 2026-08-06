# Delta: remote-access — the tunnel panel is removed

## REMOVED Requirements

### Requirement: REMOTE-01 — Tunnel Management

**Reason**: the panel exposed the server through a third-party tunnel, and it was
never doing what it claimed. Its target spoke plain HTTP to a TLS listener, so the
tunnel never came up; its active-state check read keys the provider does not emit,
so it could not have reported the truth either. It has been cosmetic since it
existed.

It is also the wrong shape for this product. A tunnel terminates on the machine
and forwards to loopback, so every request arriving through it presents itself to
the server as local — the most trusted class there is, the only one that opens the
daemon endpoints. A tunnel therefore *inverts* the trust boundary rather than
extending it, and no check inside the server can tell such a request from one the
owner made. Offering that as a one-click gesture in a menu put the strongest
possible exposure behind the weakest possible deliberation.

The tool it wrapped is a personal utility of the operator, not a component of
Topics: a person who installs Topics does not have it, and should not need it to
open the app from their phone at home. That case is served by `AUTH-01`–`AUTH-04`:
reach the server on the local network, authorize the device once.

**Migration**: the panel, its route, and the binary resolver are deleted. Anyone
who had enabled a tunnel through it can turn it off with the same command-line
tool that created it; nothing in Topics depends on it. Reaching Topics from
outside the local network remains possible with tooling of the operator's choice —
it is a transport concern, and the device authorization still applies underneath.

### Requirement: LAN-OPEN-03 — The remote-access panel exposes the tailnet, not the public internet

**Reason**: superseded by the removal above. The requirement constrained *how* the
panel should expose the server; there is no panel to constrain.

**Migration**: none. The narrower behaviour it mandated — never publishing to the
public internet from the UI — is satisfied by construction now that the UI offers
no exposure gesture at all.

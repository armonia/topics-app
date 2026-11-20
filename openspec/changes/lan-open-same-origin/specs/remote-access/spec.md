# Delta: remote-access — open LAN access, same-origin as the only gate

## ADDED Requirements

### Requirement: LAN-OPEN-02 — The daemon control endpoints are loopback-only

The system SHALL restrict the `/__daemon/*` control endpoints to loopback peers, in
addition to the existing bearer-token check, and SHALL compare that token in
constant time. A non-loopback peer SHALL be refused before the token is examined.

#### Scenario: A LAN peer cannot reach the daemon endpoints
- **GIVEN** a request to any `/__daemon/*` path from a non-loopback address
- **WHEN** the server handles it
- **THEN** the server SHALL respond `401` without comparing the presented token

#### Scenario: The local CLI and shell still control the daemon
- **GIVEN** a request from `127.0.0.1` carrying the correct daemon token
- **WHEN** the server handles it
- **THEN** the server SHALL serve it exactly as before

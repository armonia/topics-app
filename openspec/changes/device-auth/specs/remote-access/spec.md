# Delta: remote-access — per-device authentication

## ADDED Requirements

### Requirement: AUTH-01 — Every request from another machine carries an identity

The server SHALL require an identity for every gated path — the API, WebSocket
upgrades, and the file-serving roots — when the request does not come from the
machine the server runs on. Requests from that machine SHALL be trusted by
transport, so the owner can never be locked out.

The identity decision SHALL be made for **every** method, including reads. The
server SHALL NOT exempt non-mutating requests from it: the absence of a
cross-origin read permission stops a web page, but it does not stop a command-line
client on the network.

The identity axis and the origin axis SHALL both be satisfied. A request carrying
a valid session but driven from a foreign origin SHALL still be refused, because a
valid session driven by a page the owner did not open is precisely the attack the
origin check exists for.

A refusal for identity SHALL be distinguishable from a refusal for origin, so the
client can offer the authorization flow instead of failing silently.

#### Scenario: An unknown device is refused, on reads too
- **GIVEN** a device on the network that has never been authorized
- **WHEN** it requests any gated path, including a read
- **THEN** the server SHALL refuse it
- **AND** the refusal SHALL identify itself as an identity problem

#### Scenario: The machine running Topics is always trusted
- **GIVEN** a request originating from the machine the server runs on
- **WHEN** it reaches any gated path
- **THEN** the server SHALL serve it without any credential

#### Scenario: A valid session does not defeat the origin check
- **GIVEN** an authorized device
- **WHEN** a page from a foreign origin drives it into a mutating request
- **THEN** the server SHALL refuse the request

#### Scenario: The session travels without the client arranging it
- **GIVEN** an authorized device
- **WHEN** it issues any request, opens the WebSocket, or loads a file from a gated root
- **THEN** the session SHALL accompany the request without per-call-site handling

### Requirement: AUTH-02 — A new device is authorized by the trusted machine, not by guessing

To gain access, a new device SHALL display a short verification code, and the
machine that already holds access SHALL display the same request and approve or
refuse it. The new device SHALL NOT be asked to enter a secret.

The verification code SHALL avoid characters that a person can confuse when
comparing two screens. A pending request SHALL expire, and an expired request
SHALL NOT be approvable.

The request for approval SHALL reach the trusted machine wherever the user is
looking, not only inside a settings surface.

#### Scenario: The two screens show the same code
- **GIVEN** a new device asks for access
- **WHEN** the trusted machine displays the request
- **THEN** the code shown on both SHALL be identical

#### Scenario: Approval grants access to that device only
- **GIVEN** a pending request that the owner approves
- **WHEN** the new device continues
- **THEN** it SHALL gain access
- **AND** no other device SHALL gain access from that approval

#### Scenario: A refusal is told, not left hanging
- **GIVEN** a pending request that the owner refuses
- **WHEN** the new device polls
- **THEN** it SHALL be told it was refused
- **AND** SHALL be able to ask again

#### Scenario: An expired request cannot be approved
- **GIVEN** a request older than its expiry
- **WHEN** approval is attempted
- **THEN** the server SHALL refuse it

### Requirement: AUTH-03 — Access is revocable, and revocation takes effect at once

The system SHALL let the owner revoke an authorized device. A revoked device SHALL
lose access on its next request, without waiting for anything to expire, and its
refusal SHALL say it was revoked rather than that it was never known. The record of
a revoked device SHALL be retained rather than erased.

#### Scenario: Revocation is immediate
- **GIVEN** an authorized device
- **WHEN** the owner revokes it
- **THEN** its next request SHALL be refused

#### Scenario: A revoked device is told why
- **GIVEN** a revoked device
- **WHEN** it is refused
- **THEN** the refusal SHALL distinguish revocation from never having been authorized

#### Scenario: Revoking one device does not affect the others
- **GIVEN** two authorized devices
- **WHEN** one is revoked
- **THEN** the other SHALL keep working

### Requirement: AUTH-04 — The identity is visible

When the current session belongs to an authorized device, the interface SHALL show
which device it is, above the status bar. On the machine the server runs on the
interface SHALL show nothing, because there the identity is the premise rather than
information.

A device that is not authorized SHALL be told so plainly, with the gesture that
resolves it, rather than being left in an indefinite connecting state.

#### Scenario: An authorized device shows its name
- **GIVEN** the session belongs to an authorized device
- **WHEN** the interface renders
- **THEN** the device's name SHALL be visible above the status bar

#### Scenario: The local machine shows nothing
- **GIVEN** the session is trusted by transport
- **WHEN** the interface renders
- **THEN** no device identity SHALL be shown

#### Scenario: An unauthorized device is not left waiting silently
- **GIVEN** a device that is not authorized
- **WHEN** it opens the app
- **THEN** it SHALL be told it is not authorized
- **AND** SHALL be shown what to do about it

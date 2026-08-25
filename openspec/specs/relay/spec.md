# relay Specification

## Purpose

Reaching this installation from another network, and what that changes about
trust — written from `tests/e2e/relay-reachability.spec.ts`.

Two shapes of arrival are covered, and they are not the same thing:

- **Through the tube**, with a peer that speaks the relay protocol
  (`RELAY-E2E-01..05`). This proves the protocol carries requests and sockets
  and that the machine replays them against its dedicated listener.
- **Through the BRIDGE** (`relay/src/ponte.ts`, `RELAY-E2E-06..09`), which turns
  an ordinary `Request` into a `Response`. This is the only form a phone in front
  of a relay URL can use: it has an address bar, not a protocol client. Until the
  bridge existed, everything the first group proves was of no use to anybody.

**What is real here and what is not.** The machine end is production code — the
relay client and its proxy — replaying against the same dedicated listener that
sits behind the tunnel in production, and the server behind it is a real one.
The Cloudflare Worker is NOT: `shared/relay-fake.ts` stands in for it, routing
without understanding. Deploying the Worker is a separate, human step.

Two claims from the `relay` proposal are therefore OUT of scope here and no
requirement below asserts them: `RELAY-01` (the machine dials out and nothing
listens for the public) and `RELAY-02` (idle connections hibernate and cost
nothing).

Who a guest is and what confines them belongs to `sharing-guests`; this
capability only says that passing through the relay changes none of it.

## Requirements

### Requirement: RELAY-E2E-01 — Arriving through the relay confers nothing

The proxy SHALL replay what reaches it rather than reimplement any of it, so a
guest arriving through the relay SHALL be exactly the guest it was on the local
network: not promoted to owner because the peer the server sees is `127.0.0.1`,
and not shut out by a second layer nobody asked for.

A granted resource SHALL be readable through the relay and SHALL come back as an
intact body. That the request really travelled the proxy SHALL be checked, not
assumed: the machine SHALL have registered a guest session by the time the first
answer arrives.

The confinement SHALL be inherited, not re-implemented: a resource that was not
granted SHALL stay closed, the collection endpoint SHALL stay refused, and an
arrival with no credential — or with a token nobody issued — SHALL NOT get in.

#### Scenario: A granted chat is readable through the relay
- **GIVEN** a guest holding a `read` grant on a topic
- **WHEN** it requests `GET /api/topics/:id/messages` through the relay
- **THEN** the response status SHALL be 200
- **AND** the body SHALL parse as JSON

#### Scenario: The machine registered the attachment
- **GIVEN** the first answered request
- **WHEN** the machine's guest sessions are counted
- **THEN** there SHALL be at least one

#### Scenario: A chat that was not granted stays closed
- **GIVEN** the same guest and a topic it holds no grant on
- **WHEN** it requests that topic's messages through the relay
- **THEN** the response SHALL be 403 or 404

#### Scenario: The relay is not a way to become the owner
- **GIVEN** the same guest
- **WHEN** it requests `GET /api/topics` through the relay
- **THEN** the response SHALL be 403

#### Scenario: No credential, no entry — even from a `127.0.0.1` peer
- **GIVEN** the relay
- **WHEN** `GET /api/topics` arrives with no session cookie
- **THEN** the response SHALL be 401
- **AND** with a session cookie holding an unknown token it SHALL be 401 or 403

### Requirement: RELAY-E2E-02 — Writing through the relay is refused, and leaves nothing behind

The read-only axis SHALL survive the relay unchanged. A guest reaching a granted
resource through the relay SHALL be refused `PATCH`, `DELETE`, and the creation
of anything new, with 403.

The refusal SHALL be observed from the owner's port as well as from the status
code: the resource SHALL be unchanged, and the resource the guest attempted to
create SHALL NOT exist. A 403 returned after the write already happened would
read as green.

#### Scenario: The same resource reads through the relay
- **GIVEN** a guest holding a `read` grant on a topic
- **WHEN** it reads that topic's messages through the relay
- **THEN** the response SHALL be 200

#### Scenario: Every write is refused
- **GIVEN** the same guest and topic
- **WHEN** it issues `PATCH /api/topics/:id`, `DELETE /api/topics/:id`, and `POST /api/topics` through the relay
- **THEN** each response SHALL be 403

#### Scenario: Nothing was written
- **GIVEN** those refusals
- **WHEN** the owner lists topics from the main port
- **THEN** the topic SHALL still exist under its original name
- **AND** no topic SHALL exist under the name the guest tried to create

### Requirement: RELAY-E2E-03 — A WebSocket crosses the relay and delivers, without delivering too much

The protocol SHALL replay a WebSocket upgrade, not only request/response: an
upgrade that does not cross the tube leaves the product with nothing live from
outside the house. The socket SHALL report itself open on the guest side and
SHALL deliver at least the application's `welcome` frame, which is the only frame
that always arrives regardless of what the machine happens to be doing.

The guest broadcast filter SHALL apply to frames delivered through the relay
exactly as it does on the local network: the id of a resource the guest holds no
grant on SHALL NOT appear in any frame it receives. The claim SHALL rest on a
positive control — an owner socket on loopback SHALL have received the same
event.

#### Scenario: The upgrade survives the tube
- **GIVEN** a guest opening `/ws` through the relay with its cookie
- **WHEN** the handshake completes
- **THEN** the socket SHALL report itself open
- **AND** a `welcome` frame SHALL arrive

#### Scenario: The owner sees what the guest must not
- **GIVEN** a topic the guest holds no grant on
- **WHEN** the owner renames it
- **THEN** a frame carrying its id SHALL reach the owner's loopback socket

#### Scenario: The guest's relayed frames never carry that id
- **GIVEN** the same event, already observed on the owner's socket
- **WHEN** the frames delivered to the guest through the relay are read
- **THEN** none SHALL contain that topic's id

### Requirement: RELAY-E2E-04 — The relay routes and does not understand

> Written from the test. The `relay` proposal's `RELAY-03` claims end-to-end
> encryption with the key in the URL fragment; what ships and is proven here is
> narrower — the routing envelope carries no request path, no body and no session
> token, and the bridge of `RELAY-E2E-06..09` is a PEER of the session, so it
> reads its own traffic in the clear by design.

What the relay can read SHALL be the envelope and nothing else. The request path
— which carries resource ids — travels inside the payload and SHALL NOT surface
in the envelope, and neither SHALL the session token.

The claim SHALL be paired with two controls, because each without the other is
vacuous: the id SHALL be shown to have actually crossed the wire, and the
envelopes SHALL be shown to be non-empty — a relay that routed nothing would
satisfy "the id does not appear" perfectly.

Opacity SHALL NOT have been obtained by discarding the request: the same cookie
SHALL keep working through the relay afterwards, and an arrival with no cookie
SHALL still be refused.

#### Scenario: The id crossed the wire
- **GIVEN** a guest reading a granted topic through the relay
- **WHEN** the raw envelopes that crossed the relay are inspected
- **THEN** at least one SHALL contain that topic's id

#### Scenario: And the relay cannot read it
- **GIVEN** the same traffic
- **WHEN** the readable part of each envelope is inspected
- **THEN** the topic's id SHALL NOT appear there
- **AND** neither SHALL the request payload
- **AND** neither SHALL the guest's session token

#### Scenario: The envelopes are not empty
- **GIVEN** the same traffic
- **WHEN** the envelopes are inspected
- **THEN** at least one SHALL be a routed envelope toward the host or toward the guest

#### Scenario: Opacity did not cost the request
- **GIVEN** the same guest
- **WHEN** it repeats the read with its cookie, and then without it
- **THEN** the first SHALL be 200
- **AND** the second SHALL be 401 or 403

### Requirement: RELAY-E2E-05 — With no listener configured, the proxy refuses instead of guessing

When `TOPICS_TUNNEL_PORT` is not configured, the proxy SHALL refuse the request
with 503 rather than fall back to the main port. Guessing it would mean replaying
every arrival from the relay against the port on which every request is LOCAL by
construction — that is, letting the internet in as the owner of the house.

The refusal SHALL be a declared answer and not a dead lane: it SHALL travel back
through the tube as an envelope addressed to the guest.

#### Scenario: A request through a relay with no listener configured
- **GIVEN** a relay whose installation has no tunnel port configured
- **WHEN** a guest requests `GET /api/topics` through it
- **THEN** the response SHALL be 503

#### Scenario: The refusal came back through the tube
- **GIVEN** that 503
- **WHEN** the envelopes are inspected
- **THEN** at least one SHALL be addressed to the guest

### Requirement: RELAY-E2E-06 — An ordinary browser request crosses the bridge and comes back identical

The bridge SHALL accept a plain HTTPS request built from nothing but a relay URL
— what a phone can produce — and return a plain `Response`.

The body SHALL be defined as correct by comparison, not by re-describing it: it
SHALL be byte-identical to what the same guest obtains by knocking directly on
the dedicated listener, SHALL remain parseable JSON, and the response headers
SHALL carry the content type back.

The bridge SHALL NOT assert any identity of its own — two authorities on who
somebody is are one too many — so the confinement observed at the tunnel listener
SHALL hold unchanged: a resource that was not granted stays closed, the
collection endpoint stays refused, an arrival with no cookie is refused, and
writes are refused with nothing written.

#### Scenario: A granted chat reads through the bridge
- **GIVEN** a guest holding a `read` grant on a topic
- **WHEN** it issues an ordinary `GET` to the bridge URL for that topic's messages
- **THEN** the response status SHALL be 200

#### Scenario: The body is the same body
- **GIVEN** that response
- **WHEN** it is compared with the same request made directly to the dedicated listener
- **THEN** the two bodies SHALL be identical
- **AND** the body SHALL parse as JSON
- **AND** the response content type SHALL be JSON

#### Scenario: The confinement does not change for having crossed the bridge
- **GIVEN** the same guest
- **WHEN** it requests a topic it holds no grant on, then `GET /api/topics`, then the same with no cookie
- **THEN** the first SHALL be 403 or 404
- **AND** the second SHALL be 403
- **AND** the third SHALL be 401

#### Scenario: Writes through the bridge are refused and leave nothing
- **GIVEN** the same guest
- **WHEN** it issues `PATCH` on the granted topic and `POST /api/topics` through the bridge
- **THEN** both SHALL be 403
- **AND** from the owner's port the topic's name SHALL be unchanged
- **AND** the topic the guest tried to create SHALL NOT exist

### Requirement: RELAY-E2E-07 — A body larger than one frame is split and comes back whole

A response body larger than the tube's frame size (`TUBO_BYTE_PER_FRAME`, 96 KiB)
SHALL be split across frames and reassembled, so that reachability does not stop
at small answers.

That the split actually happened SHALL be verified rather than assumed — more
than one data frame SHALL have travelled in the answering direction — because
otherwise the requirement would be satisfied by a two-line body and prove nothing
about reassembly.

"Whole" SHALL be defined by comparison with the same request made directly to the
dedicated listener: same length and same content, with both ends of the payload
present.

#### Scenario: The body is bigger than one frame
- **GIVEN** a granted topic seeded with three messages of 120 KiB each
- **WHEN** the guest reads its messages through the bridge
- **THEN** the response SHALL be 200
- **AND** the body SHALL be larger than 96 KiB

#### Scenario: It really travelled in pieces
- **GIVEN** that response
- **WHEN** the frames in the answering direction are counted
- **THEN** more than one data frame SHALL have been sent

#### Scenario: And it came back whole
- **GIVEN** that response
- **WHEN** it is compared with the same request made directly to the dedicated listener
- **THEN** the lengths SHALL match
- **AND** the contents SHALL be identical
- **AND** the first and last seeded markers SHALL both be present

### Requirement: RELAY-E2E-08 — A WebSocket opened from the browser delivers both ways

The bridge SHALL replay a WebSocket upgrade for a browser: the handshake SHALL
answer 101 rather than a page describing a failure.

Delivery SHALL be proven in BOTH directions. Machine → browser is proven by the
`welcome` frame. Browser → machine is proven by a round trip that depends on
nothing else: a `ping` sent by the browser SHALL be accepted, and the `pong` SHALL
come back — a `pong` cannot exist if the outbound leg did not arrive.

The guest broadcast filter SHALL apply to this socket too, against a positive
control on the owner's loopback socket.

#### Scenario: The upgrade opens
- **GIVEN** a browser-shaped upgrade request to `/ws` through the bridge, carrying the guest's cookie
- **WHEN** the handshake completes
- **THEN** the status SHALL be 101

#### Scenario: Machine to browser
- **GIVEN** that socket
- **WHEN** it is read
- **THEN** a `welcome` frame SHALL arrive

#### Scenario: Browser to machine and back
- **GIVEN** that socket
- **WHEN** the browser sends `{"type":"ping"}`
- **THEN** the socket SHALL accept the frame
- **AND** a `pong` SHALL come back

#### Scenario: The filter holds on this socket too
- **GIVEN** a topic the guest holds no grant on, renamed by the owner
- **WHEN** the owner's loopback socket has been seen to receive the event
- **THEN** no frame delivered to the browser SHALL contain that topic's id

### Requirement: RELAY-E2E-09 — When the machine is not connected, the bridge says so and stops waiting

> Written from the test. The `relay` proposal's `RELAY-05` states this as an
> interface message; what ships and is proven here is the protocol answer beneath
> it — a status, a readable sentence, and a WebSocket close code.

While the installation is not connected to the relay, a request through the
bridge SHALL be answered 503, promptly rather than after the bridge's timeout,
and with a readable sentence in the body rather than an empty page. The claim
SHALL rest on a positive control: the very same request SHALL return 200 while the
machine is connected.

A WebSocket that was alive SHALL be closed with the code that names the reason
(`WS_PONTE_GIU`). Staying open toward a machine that is no longer there resembles
working, which is the worst way to fail.

#### Scenario: While the machine is connected
- **GIVEN** a guest holding a `read` grant on a topic
- **WHEN** it reads that topic's messages through the bridge
- **THEN** the response SHALL be 200
- **AND** a socket opened through the bridge SHALL receive `welcome` and SHALL NOT be closed

#### Scenario: The machine goes away
- **GIVEN** the installation disconnects from the relay
- **WHEN** the same request is made again
- **THEN** the response SHALL be 503
- **AND** it SHALL arrive in less than five seconds, rather than at the bridge's timeout
- **AND** the body SHALL say that the installation is not connected

#### Scenario: The live socket is closed with a reason
- **GIVEN** the socket that was alive before the disconnection
- **WHEN** its close is inspected
- **THEN** the close code SHALL be the one that means the installation is offline

### Requirement: RELAY-E2E-11 — The envelope is sealed, and a tampered one does not open

What crosses the relay SHALL be encrypted end to end, and the relay SHALL be
able to route it without being able to read it. Only what ROUTING needs — the
rendezvous name and the reference of the shared thing — SHALL travel in the
clear, and neither of those SHALL open anything on its own.

The key SHALL live ONLY in the URL fragment. That is the one part of a link a
browser never sends to a server; a key in the query string or the path is a key
in somebody's access log.

The nonce SHALL be generated inside the sealing function and SHALL NOT be
reachable by any caller. Reusing a nonce under this cipher does not weaken it,
it BREAKS it — it exposes the authentication key. Making it impossible to pass
is the only version of that rule that holds.

Opening SHALL return the SAME "no" for every failure — wrong key, altered
ciphertext, altered nonce, malformed envelope, unknown version — and SHALL never
raise a distinguishable error. Telling the failures apart would build an oracle
for whoever is trying them.

The plaintext SHALL NOT appear anywhere in the envelope, not even encoded.

#### Scenario: one bit changed
- **GIVEN** a sealed envelope whose ciphertext or nonce is altered by a single bit
- **THEN** opening SHALL return nothing

#### Scenario: an unknown version
- **GIVEN** an envelope carrying a version this code does not know
- **THEN** opening SHALL return nothing, and SHALL NOT guess a format

#### Scenario: a link with no fragment
- **GIVEN** a share link stripped of its fragment
- **THEN** it SHALL be unusable

### Requirement: RELAY-E2E-12 — The rendezvous name is a digest, and it is not the installation's identity

The name a machine is reachable by through the relay SHALL be derived from a
secret by a one-way digest with a domain-separating prefix, and SHALL be a pure
function: no registry, no first-come-first-served, no shared state to keep in
sync between the two sides that compute it.

That name SHALL NOT be the installation's own identifier. They used to be the
same value, and that meant whoever received a share link could impersonate the
machine — the far side evicts the previous host when a new claim arrives.

The formula SHALL live where BOTH sides that compute it can import it. Two
copies of the same derivation are two things that one day produce different
names.

The secret SHALL be rejected before the digest is computed when it is not a
string, is shorter than the declared minimum, or is longer than the declared
maximum — the last one so an oversized input cannot buy work. A malformed name
SHALL be rejected even when the secret is right.

The secret SHALL travel in a request HEADER and never in a path or a query
string, which end up in the logs of whoever sits in between.

A constant-time comparison is NOT required and SHALL NOT be implied: the secret
is never compared, only transformed, and the name is public by construction —
it is in the links.

#### Scenario: the same secret, both sides
- **GIVEN** the same secret derived on the machine and on the far side
- **THEN** the name SHALL be identical, and SHALL match the value fixed by contract

#### Scenario: a secret that is nearly right
- **GIVEN** a secret that is truncated, or carries an extra space, or differs in case
- **THEN** it SHALL NOT match

#### Scenario: an enormous secret
- **GIVEN** a secret longer than the declared maximum
- **THEN** it SHALL be refused BEFORE any digest is computed

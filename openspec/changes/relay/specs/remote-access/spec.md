# Delta: remote-access — reachability without exposure

## ADDED Requirements

### Requirement: RELAY-01 — The machine dials out; it never listens

The installation SHALL reach the relay by opening an **outbound** connection and
registering itself. It SHALL NOT accept inbound connections from the public
network, SHALL NOT require a port to be forwarded, and SHALL NOT require the
operator to own a domain or configure DNS.

The concept SHALL NOT surface in the interface. A person shares something and
gets a link; a person opens the link and sees the thing. Nothing in that
sentence is a network concept, and nothing in the interface SHALL make it one.

The local application SHALL keep working when the relay is unreachable. The
relay carries what is shared with others; it SHALL NOT be on the path of the
owner's own work.

#### Scenario: Nothing listens for the public
- **GIVEN** an installation configured to use the relay
- **WHEN** its network is inspected
- **THEN** no port SHALL be open for inbound public connections

#### Scenario: The relay going down does not stop the owner
- **GIVEN** the relay is unreachable
- **WHEN** the owner uses the application locally
- **THEN** it SHALL work unchanged

### Requirement: RELAY-02 — Idle connections cost nothing

The relay SHALL hold connections in a hibernatable form, so that a connection
with no traffic incurs no duration cost.

This is a requirement and not an optimization: for the same workload, holding
the socket awake instead of hibernating it costs roughly **forty times** more.
The economics of the whole feature depend on this single choice, so it SHALL be
verified rather than assumed.

Pixel-level co-browsing SHALL NOT travel through the relay's stateful objects.
It SHALL remain peer-to-peer.

#### Scenario: An idle session is not billed for duration
- **GIVEN** a registered installation with no traffic
- **WHEN** the billing period is measured
- **THEN** no duration SHALL accrue for that connection

#### Scenario: Screen streams do not enter the relay
- **GIVEN** a co-browsing session between two participants
- **WHEN** its transport is inspected
- **THEN** the pixel stream SHALL NOT pass through the relay's stateful objects

### Requirement: RELAY-03 — The relay cannot read what it carries

Payloads between an installation and a guest SHALL be encrypted end to end, and
the key SHALL travel in the part of the URL that browsers do not send to
servers. The relay SHALL be able to route a payload without being able to
interpret it.

The claim and the implementation SHALL ship together. If the encryption is
deferred, the confidentiality claim SHALL be deferred with it — a promise made
before it is true is worse than one made late.

Because the link carries the key, the link **is** the credential: it SHALL be
revocable and SHALL expire, and the interface SHALL say so where the link is
produced.

#### Scenario: The relay sees only ciphertext
- **GIVEN** a guest viewing a shared resource
- **WHEN** the traffic at the relay is inspected
- **THEN** the payload SHALL NOT be interpretable there

#### Scenario: A revoked link stops working
- **GIVEN** a link that was shared
- **WHEN** it is revoked
- **THEN** opening it SHALL no longer grant access

### Requirement: RELAY-04 — Reaching a thing is not the same as being allowed to see it

The relay SHALL establish reachability only. Every existing rule about identity
and permission SHALL continue to be enforced by the installation itself: who the
requester is, what has been granted to them, and that a guest may only read.

The relay SHALL NOT introduce a second system that decides who someone is. Two
authorities on identity must be kept in agreement forever, and the one that
disagrees silently is the one nobody is looking at.

#### Scenario: Arriving through the relay grants nothing by itself
- **GIVEN** a request that reaches an installation through the relay
- **WHEN** it asks for something that was not shared with it
- **THEN** it SHALL be refused exactly as it would be on the local network

#### Scenario: A guest still cannot write
- **GIVEN** a guest reaching a shared resource through the relay
- **WHEN** it attempts a write
- **THEN** it SHALL be refused

### Requirement: RELAY-05 — When the machine is off, the interface says so

While an installation is not connected, anything shared from it SHALL be
presented as **temporarily unreachable**, naming the reason, rather than as
empty or broken.

Continuing a session elsewhere when the machine goes offline is explicitly not
part of this: it would move the work off the owner's machine, which is the one
property the product is built on. Should it ever be offered, it SHALL be an
explicit, separately chosen service — never a default, and never a silent
fallback.

#### Scenario: A guest opening a link to a sleeping machine
- **GIVEN** a shared link whose installation is offline
- **WHEN** a guest opens it
- **THEN** the interface SHALL say the machine is not reachable right now
- **AND** it SHALL NOT present an empty result as if nothing had been shared

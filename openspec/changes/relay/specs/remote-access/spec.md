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

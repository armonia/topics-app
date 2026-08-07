# Delta: remote-access — sharing is one model, and a guest is confined by the gate

## ADDED Requirements

### Requirement: SHARE-01 — One grant model, not one table per kind of thing

Sharing SHALL be expressed by a single relation of the shape *subject → level →
resource*, carrying the provenance of the permission. Adding a new kind of
shareable thing SHALL NOT require a new table, and adding a new kind of recipient
SHALL NOT require duplicating the existing ones.

A resource SHALL be shareable only if it has a durable row of its own to which a
permission can be attached. State that exists only inside a serialized blob SHALL
NOT be declared shareable, because a permission row pointing at something the
server cannot address, filter, or cascade from is a promise the server cannot
keep.

The relation SHALL record where a permission came from, distinguishing one granted
by hand from one derived from a container, so that "why does this person see this?"
has an answer and a container's grants can be withdrawn without touching the
explicit ones.

#### Scenario: A second kind of resource costs no new table
- **GIVEN** the grant relation with one kind of resource in it
- **WHEN** a second kind that has its own durable row is shared
- **THEN** it SHALL be stored in the same relation
- **AND** no table SHALL be added for it

#### Scenario: Blob-resident state is refused as a resource
- **GIVEN** state that exists only inside a serialized blob written whole
- **WHEN** sharing it is attempted
- **THEN** the system SHALL NOT offer it as a shareable resource

#### Scenario: Provenance survives revocation of a container
- **GIVEN** a resource granted by hand AND another granted via a container
- **WHEN** the container's grants are withdrawn
- **THEN** the container-derived grant SHALL be removed
- **AND** the hand-granted one SHALL remain

### Requirement: SHARE-02 — A guest is confined by the gate, not by the routers

The confinement of a restricted recipient SHALL be decided at the single point
that already decides authorization, and SHALL be expressed as an allowlist of
reachable paths. It SHALL NOT be implemented by adding filters inside the
individual routers, and it SHALL NOT be implemented by hiding things in the
client.

An endpoint that answers with a **set** SHALL NOT be placed on that allowlist. The
gate sees the path and not the body, so it cannot filter a collection; a restricted
recipient SHALL instead discover what it has from an endpoint that is built from
the grants themselves and therefore has nothing to filter.

#### Scenario: A filter in one router does not confine
- **GIVEN** a restricted recipient
- **WHEN** it requests a listing served by a router other than the one carrying the filter
- **THEN** the request SHALL still be refused

#### Scenario: A collection endpoint is not reachable
- **GIVEN** a restricted recipient
- **WHEN** it requests an endpoint that returns a collection of resources
- **THEN** the server SHALL refuse it
- **AND** the recipient SHALL still be able to learn what it was granted

#### Scenario: Only the granted entity is served
- **GIVEN** a restricted recipient granted one resource
- **WHEN** it requests another resource of the same kind by id
- **THEN** the server SHALL refuse it

### Requirement: SHARE-03 — Live updates reach a guest, filtered twice

A restricted recipient SHALL receive live updates for what it was granted. The
connection SHALL NOT be closed as a means of confinement, because a shared thing
that never changes on screen is a photograph and defeats the purpose of sharing it.

What travels on that connection SHALL be filtered first by frame **type** against
an allowlist, and then by the **entity** the frame refers to. Filtering by entity
alone SHALL NOT be relied upon: frames that carry no entity reference would pass
such a filter unexamined.

The allowlist SHALL be verified against the emitted frame registry, so that a name
that does not exist cannot be added. A frame type absent from the allowlist SHALL
simply not be sent, and adding a new one SHALL be a deliberate act.

#### Scenario: An update to a granted resource arrives
- **GIVEN** a restricted recipient with a live connection and one granted resource
- **WHEN** that resource changes
- **THEN** the recipient SHALL receive the update

#### Scenario: A frame with no entity does not travel
- **GIVEN** a restricted recipient with a live connection
- **WHEN** a frame that carries no entity reference is broadcast
- **THEN** it SHALL NOT be delivered to that recipient

#### Scenario: An allowlisted type for a foreign entity does not travel
- **GIVEN** a restricted recipient with a live connection
- **WHEN** an allowlisted frame type is broadcast for a resource it was not granted
- **THEN** it SHALL NOT be delivered to that recipient

#### Scenario: The allowlist cannot name a frame that does not exist
- **GIVEN** the frame-type allowlist
- **WHEN** it is checked against the registry of emitted frames
- **THEN** every entry SHALL correspond to a registered type

### Requirement: SHARE-04 — A guest gets its own application, not the owner's with things removed

A restricted recipient SHALL be served an interface built for it, decided before
the application mounts. The owner's application SHALL NOT be mounted and then
covered or trimmed.

The reason is behavioural, not cosmetic: an application whose parts each ask the
server for things the gate refuses produces a screen of errors, and those are real
refused requests, repeated. A recipient who sees errors concludes the product is
broken rather than that the content is not theirs.

An empty result SHALL be stated as a normal condition and SHALL say whose move is
next, so that "nothing shared yet" cannot be read as a failure.

#### Scenario: The guest interface replaces the application
- **GIVEN** a recipient whose role is restricted
- **WHEN** the application starts
- **THEN** the restricted interface SHALL be mounted instead of the owner's application

#### Scenario: Nothing shared is explained
- **GIVEN** a restricted recipient with no grants
- **WHEN** it opens the application
- **THEN** the emptiness SHALL be presented as normal
- **AND** the interface SHALL say what would make something appear

### Requirement: SHARE-05 — Sharing is offered where the thing lives, and says who can see it

The gesture that shares a resource SHALL sit with the resource itself, SHALL be
generic over the kind of resource, and SHALL list who currently has access,
showing for each whether the access was granted by hand or derived from a
container.

Only a restricted recipient SHALL be offerable as a target. Offering to share with
a recipient that already sees everything SHALL be refused, because such a row would
suggest it is limiting something when it is not.

When no possible target exists, the control SHALL say how to create one rather
than presenting an empty list.

#### Scenario: An unrestricted recipient is refused as a target
- **GIVEN** a recipient that already has full access
- **WHEN** sharing a resource with it is attempted
- **THEN** the server SHALL refuse
- **AND** the refusal SHALL explain that the recipient already sees everything

#### Scenario: The control says where access came from
- **GIVEN** a resource shared by hand and another derived from a container
- **WHEN** the sharing control is opened
- **THEN** each entry SHALL show which of the two it is

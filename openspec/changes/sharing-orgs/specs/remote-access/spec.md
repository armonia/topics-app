# Delta: remote-access — the subject of a grant becomes a principal

## ADDED Requirements

### Requirement: ORG-01 — A request resolves to a bounded set of principals

The system SHALL resolve a remote request's identity into a set of **principals**
of depth at most two: the device, the person it belongs to, and the non-revoked
organizations that person is a non-revoked, non-locally-blocked member of.

Nested organizations SHALL NOT be admitted. The bounded depth is the **condition
of validity** for resolving at read time rather than materializing, not a default
that may later be relaxed: a fixed-length path is a join, an unbounded one is a
graph walk, and the argument for this design does not survive the change. A test
SHALL fail if a parent column appears on the organization table.

Every revocation column SHALL be read on every resolution. A revocation column
that exists and is never read is worse than none: it makes a revocation look
performed.

#### Scenario: Two devices of one person share what that person was granted
- **GIVEN** a person with two paired devices and a grant to that person
- **WHEN** either device requests the resource
- **THEN** the server SHALL serve it

#### Scenario: Removing someone from an organization withdraws access at once
- **GIVEN** a resource granted to an organization and a member with a device
- **WHEN** the membership is revoked
- **THEN** the next request from that device SHALL be refused
- **AND** no reconciliation pass SHALL be required for this to hold

#### Scenario: Nesting is refused by construction
- **GIVEN** the organization table
- **WHEN** a migration introduces a parent column on it
- **THEN** a test SHALL fail

### Requirement: ORG-02 — Ownership of the installation is local, and never conferred by an organization

The system SHALL derive whether a device is confined **only** from: the presence
of a person, that person not being revoked, and that person belonging to the
installation's local owner set. Membership of an organization SHALL NOT confer
ownership of the machine.

The reason is that organization membership will be a replica whose authority is
remote — it is the licence and the billing relationship — while the machine, its
filesystem, its terminals and its subscription are not. Were ownership to depend
on it, a declined payment or a row removed in a panel would demote the owner to a
guest **on their own machine**, and the failure would arrive through a channel
the owner does not control.

The local owner set SHALL NOT be writable by any synchronization process, and
SHALL carry no remote-identity column.

A device with no person SHALL be treated as confined. Every branch SHALL fail
towards fewer powers: an unrecognized subject counts as a guest, never as an
owner.

#### Scenario: A teammate is a guest on someone else's machine
- **GIVEN** two people in the same organization, one of whom owns the installation
- **WHEN** the other opens that installation from their own device
- **THEN** they SHALL be confined to what has been shared with them

#### Scenario: Losing the organization does not lose the machine
- **GIVEN** the owner's person record, and their organization membership removed
- **WHEN** they use their own installation
- **THEN** they SHALL still be its owner

#### Scenario: Synchronization cannot grant ownership
- **GIVEN** a synchronization process with write access to the replicated tables
- **WHEN** it runs
- **THEN** it SHALL NOT be able to alter who owns the installation

### Requirement: ORG-03 — One door for every question asked of the grant table

Every read and write of the grant relation SHALL pass through a single module. A
test SHALL fail if the relation or its subject column is named anywhere else.

This is a requirement and not a convention because the failure it prevents is
silent in the safe direction: a reader left behind, still filtering for the old
subject kind, returns **less** rather than more. It fails closed, which means
nothing breaks loudly and the gap can persist unnoticed.

Deciding whether a principal may read a resource SHALL be one indexed lookup, and
a denial SHALL take precedence over any permission.

The system SHALL be able to answer, for a resource, both **who was granted it**
and the **effective** set that expands to, and SHALL be able to enumerate *all*
the reasons a principal sees something rather than the first one found.

#### Scenario: A denial outranks a permission
- **GIVEN** a principal granted a resource through one path and denied it through another
- **WHEN** access is decided
- **THEN** it SHALL be refused

#### Scenario: The interface can explain an access
- **GIVEN** a principal that can see a resource through more than one path
- **WHEN** the reasons are requested
- **THEN** all of them SHALL be returned

### Requirement: ORG-04 — A person can be granted something before they have any device

The system SHALL allow granting a resource to a person who has not yet paired any
device, and that grant SHALL take effect on the first device they pair **without
any grant row being written** at that moment.

Today the ordering is reversed: a recipient who has not paired is not
representable at all, so inviting someone means waiting for their device to
appear and only then sharing. That is not the order in which anyone would
describe the act.

Reassigning a device to a different person SHALL be possible from the interface,
and SHALL NOT modify any existing grant.

#### Scenario: Sharing precedes pairing
- **GIVEN** a person with no devices, granted a resource
- **WHEN** they pair their first device
- **THEN** they SHALL see the resource
- **AND** no grant row SHALL have been written at pairing time

#### Scenario: A device paired to the wrong person can be moved
- **GIVEN** a device attributed to the wrong person
- **WHEN** it is reassigned
- **THEN** existing grants SHALL be untouched

### Requirement: ORG-05 — One module translates a credential into an identity

The system SHALL resolve a credential into an identity in a single module, used
by the HTTP gate, the WebSocket upgrade, and the endpoint that reports the
session. Three translations that must agree and are written separately will
eventually disagree, and the one that disagrees silently is the WebSocket path,
whose result is never seen by the client.

A connection SHALL re-resolve its principals when the underlying membership
changes, rather than carrying the set it was stamped with for its lifetime. All
of a device's connections SHALL be closed when that device is revoked or
reassigned.

#### Scenario: A live connection notices a membership change
- **GIVEN** an open connection whose principals were resolved at connect time
- **WHEN** the membership behind them changes
- **THEN** subsequent delivery SHALL respect the new set

#### Scenario: Revocation ends the connections
- **GIVEN** a device with open connections
- **WHEN** it is revoked
- **THEN** its connections SHALL be closed

### Requirement: ORG-06 — Replication is possible, and grants are not replicated

Tables that will one day be authored elsewhere SHALL carry, from their first
migration, the columns that make reconciliation possible — origin, a unique
remote identity, a revision, and timestamps — and SHALL use tombstones rather
than deletion. Adding them later would mean rebuilding the tables a second time,
because the constraints cannot be altered in place.

Grants SHALL NOT be replicated. The control plane SHALL be able to write only the
directory — people, organizations, memberships — and SHALL NOT know about local
resources. A revocation decided locally SHALL survive reconnection: synchronization
SHALL NOT be able to clear it.

#### Scenario: A local block outlives a sync
- **GIVEN** a membership blocked locally
- **WHEN** synchronization restores the remote record
- **THEN** the local block SHALL still hold

#### Scenario: The control plane cannot see local resources
- **GIVEN** the set of tables synchronization may write
- **WHEN** it is enumerated
- **THEN** it SHALL contain no local resource and no grant

### Requirement: ORG-07 — The interface asks who, not what role, and stays quiet about organizations of one

The approval prompt for a new device SHALL ask **which person** the device
belongs to, with one's own self preselected, and SHALL NOT ask for a role: the
role is derived, and asking for it invites a choice that contradicts the model.

The interface SHALL NOT use the word "organization" toward someone whose only
organization has a single member. A solo user is an organization of one so that
the code has one path, not so that the product has two vocabularies.

#### Scenario: Pairing asks for a person
- **GIVEN** a new device requesting access
- **WHEN** the prompt appears
- **THEN** it SHALL offer the choice of person, defaulting to oneself

#### Scenario: A solo user never reads the word
- **GIVEN** a user whose only organization has one member
- **WHEN** they use the interface
- **THEN** the concept SHALL NOT be named to them

### Requirement: ORG-08 — The account is never a gate

An account SHALL NOT be required to install, to open the application for the
first time, to use it locally, or to reach it from the same network. Those paths
SHALL keep working with no account, no network, and no third party aware that
the installation exists.

An account SHALL be required only for what genuinely needs an authority outside
the machine: being found from a **different** network, keeping people and
organizations consistent **across** installations, and licensing.

The distinction is the product, not a preference. A local-first tool that asks
who you are before it will run has already conceded the thing it is selling —
and the concession is invisible in a feature list, which is why it must be a
requirement rather than a habit.

An account SHALL therefore be addable to an installation that already holds
data, and adding one SHALL NOT create a second identity alongside the local one:
the existing local person SHALL acquire the remote identity. An installation
that has been used for a year before signing in is the normal case, not an edge
one.

Signing in on a second installation SHALL reconcile to the same person rather
than producing two. Two people who are one person split what has been shared
with them, and the split is silent.

Loss of contact with the account service SHALL degrade only the things that need
it. It SHALL NOT reduce local capability, and SHALL NOT be presented as an error
state on a machine that is working.

#### Scenario: A fresh installation, never signed in
- **GIVEN** a machine that has never had an account
- **WHEN** the application is installed and opened
- **THEN** it SHALL be fully usable locally
- **AND** it SHALL NOT ask who the user is

#### Scenario: Authorizing a phone on the same network
- **GIVEN** an installation with no account
- **WHEN** a phone on the same network asks for access
- **THEN** the existing device authorization SHALL be sufficient

#### Scenario: Signing in after a year of use
- **GIVEN** an installation with an established local person and their history
- **WHEN** an account is connected for the first time
- **THEN** the existing person SHALL acquire the remote identity
- **AND** no second person SHALL appear

#### Scenario: The account service is unreachable
- **GIVEN** a signed-in installation that cannot reach the account service
- **WHEN** the owner works locally
- **THEN** every local capability SHALL remain
- **AND** the interface SHALL NOT present the machine as broken

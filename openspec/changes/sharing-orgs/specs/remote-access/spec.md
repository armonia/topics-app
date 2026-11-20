# Delta: remote-access — the subject of a grant becomes a principal

## ADDED Requirements

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

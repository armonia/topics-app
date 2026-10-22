# First run Specification

## Purpose

Orient a new Topics installation with its existing identity, local agents, and
provider setup while keeping remote account access optional.

## Requirements

### Requirement: FIRST-RUN-01 — A skippable first-run screen

Topics SHALL show a four-card first-run screen until it has been seen. It SHALL
be possible to skip it and return to the app's normal home screen. The screen
SHALL be reachable again from Settings.

An installation is on its first opening while its owner still has the name it
was born with, `Proprietario` (migration 084). An owner with any other name
SHALL NOT see the screen on startup, and that installation SHALL record the
first run as done, once.

#### Scenario: Name and finish

- **GIVEN** a new installation has not seen the first-run screen
- **WHEN** its owner saves a name and chooses “Fatto”
- **THEN** the existing owner person SHALL carry that name
- **AND** the normal app SHALL open with the name in the sidebar

#### Scenario: Skip and reload

- **GIVEN** a new installation has not seen the first-run screen
- **WHEN** its owner chooses “Salta”
- **THEN** the normal app SHALL open
- **AND** reloading SHALL NOT show the first-run screen again

#### Scenario: An installation already in use

- **GIVEN** the owner already has a real name and the first run was never recorded
- **WHEN** the app starts
- **THEN** the first-run screen SHALL NOT appear
- **AND** the first run SHALL be recorded as done

#### Scenario: Reopen from Settings

- **GIVEN** the first-run screen has already been dismissed
- **WHEN** its owner opens Settings and chooses “Configurazione iniziale”
- **THEN** the first-run screen SHALL open again

### Requirement: FIRST-RUN-02 — Show the machine without installing agents

The agent card SHALL show each detected agent, its installed path when found,
and the copyable install command when missing. The app SHALL NOT install an
agent from this screen.

#### Scenario: Found and missing agents

- **GIVEN** the system agent check returns a found agent and a missing agent
- **THEN** the card SHALL show the found path and the missing agent's install
  command

### Requirement: FIRST-RUN-03 — Account is optional

The remote account card SHALL start closed, explain that Topics works without
an account, and link to the Account section. The first-run screen SHALL NOT ask
for Google login or a GitHub key, and SHALL preserve the declared provider
model list.

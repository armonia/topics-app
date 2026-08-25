## Purpose

Specifies behavioral scenarios for the in-app "Novità" surface: the version chip in the
sidebar status bar, the popover it anchors, and the changelog modal that reads the
generated `/changelog.json` served by the app.

## Background

Common preconditions shared across scenarios:

- The running version comes from `GET /api/version`
- The history comes from `/changelog.json`, a static file the server allowlists and
  `bun run changelog` generates from commit subjects
- Each version entry carries four sections — `new`, `fixes`, `perf`, `internal` — and each
  entry has an italian text and a scope tag
- Entries whose commit subject does not match `type(scope): text` land in `internal`, so a
  release can legitimately have zero public entries

## Requirements

### Requirement: CHANGELOG-01 — Open from the version chip, land on the running version

The system SHALL expose the changelog behind the version chip: clicking the chip opens a
popover with a "Novità" entry point, which opens a modal that defaults to the running
version and marks it as the one in use.

#### Scenario: The chip opens the modal on the running version
- **GIVEN** the app reports version 9.9.9 and the changelog holds entries for 9.9.9 and 9.9.8
- **WHEN** the user clicks the version chip and then the "Novità" entry
- **THEN** the changelog modal is visible
- **AND** it is labelled "versione in uso"
- **AND** it lists 9.9.9's `new` and `fixes` entries
- **AND** each entry carries its scope tag

### Requirement: CHANGELOG-02 — Navigating to another version swaps the content

The system SHALL let the user pick any version from the modal's version rail, and SHALL
replace the displayed entries with that version's own.

#### Scenario: Selecting the previous version replaces what is shown
- **GIVEN** the changelog modal is open on 9.9.9
- **WHEN** the user clicks 9.9.8 in the version rail
- **THEN** 9.9.8's `new` and `perf` entries are shown
- **AND** 9.9.9's entries are no longer present

### Requirement: CHANGELOG-03 — Internal churn is collapsed behind a disclosure

The system SHALL hide the `internal` section behind a "Sotto il cofano" disclosure that
starts closed, so a release's internal commits never crowd out what a user cares about.

#### Scenario: Internal entries appear only after the disclosure is opened
- **GIVEN** the changelog modal is open on a version that has an `internal` entry
- **THEN** that entry is not present
- **WHEN** the user clicks "Sotto il cofano"
- **THEN** the entry becomes visible

### Requirement: CHANGELOG-04 — The modal renders the real generated file

The system SHALL serve `/changelog.json` and the modal SHALL render exactly the versions
and entries that file contains — one rail button per version, no "non disponibile"
fallback.

#### Scenario: Version rail and entries come from the served file
- **GIVEN** `GET /changelog.json` returns a non-empty history, with no route stubbed
- **WHEN** the user opens the changelog modal
- **THEN** the version rail holds exactly as many buttons as the file has versions
- **AND** no "non disponibile" message is shown
- **WHEN** the user selects a version that has at least one `new`, `fixes` or `perf` entry
- **THEN** that entry's text is rendered inside a public section list item

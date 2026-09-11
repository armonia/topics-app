## ADDED Requirements

### Requirement: ORG-PROJECTS-01 — The organization page scopes its project list to the selected group

The Organization page's project list SHALL show only the projects whose own
`orgId` equals the currently selected group. A project with `orgId: null`
(personal, no group) SHALL NOT appear on any group's page, its own included.
Selecting a different group SHALL update the list without a page reload.

#### Scenario: a personal project never appears on a group page
- **GIVEN** a personal project (`orgId: null`) and a group "Danceroom"
- **WHEN** the Organization page is open on "Danceroom"
- **THEN** the personal project is not in the list

#### Scenario: a second group with no project of its own shows an empty list, not another group's projects
- **GIVEN** two groups on one installation, only one of which owns a project (`PROJECT-13`: an installation names exactly one group as owner)
- **WHEN** the Organization page is open on the group that owns nothing
- **THEN** the list is empty, and the page explains how to grant that group access to work it does not own

### Requirement: ORG-PROJECTS-02 — The organization page names the two kinds of access

The Organization page SHALL state, in plain text next to the project list,
that sharing a project (a grant or a remote link) is a different action from
enabling someone to run agents on it (their own Topics installation with its
own checkout), and SHALL NOT present one as a substitute for the other.

#### Scenario: the guide distinguishes browser access from a second machine
- **GIVEN** the Organization page is open
- **THEN** the guide names both: reading/commenting/editing a project's tasks from a link or a granted device, and installing Topics on a second machine to run agents there

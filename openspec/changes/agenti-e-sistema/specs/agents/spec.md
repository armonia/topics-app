## ADDED Requirements

### Requirement: AGENTS-REG-01 — Agents come from configuration
The server SHALL build the agent list from the channel engine configuration and each agent's IDENTITY.md, with no agent written in code, and SHALL show an empty state when no agent is configured.

#### Scenario: three configured agents
- **WHEN** the configuration lists three agents
- **THEN** the registry returns exactly those three, named from their IDENTITY.md

#### Scenario: creating an agent
- **WHEN** the user creates an agent with a name and a trade
- **THEN** its folder contains only IDENTITY.md and the agent appears in the overview without a server restart

### Requirement: AGENTS-PERSONA-01 — Layered persona
Every agent turn SHALL receive the persona assembled in this order, each layer once: Topics base, the user's rules, the agent's identity and its optional additions.

#### Scenario: a new agent inherits the base
- **WHEN** an agent has only IDENTITY.md
- **THEN** its assembled persona contains the base soul, the user's rules and its own name

### Requirement: AGENTS-NAV-01 — Agent navigation
The Agents page SHALL open on an overview of all agents with their channel brand marks, and an agent's configuration SHALL live on its own page with one address per section.

#### Scenario: configuration is not on the agent page
- **WHEN** the user opens an agent
- **THEN** the default view is Activity, and Configure opens a separate page whose sections survive a reload

### Requirement: AGENTS-TOOLS-01 — Per-agent tool filter
An agent SHALL use every system tool by default, and when limited to a subset its turns SHALL receive only that subset.

#### Scenario: limited agent
- **WHEN** an agent is set to "only these" with one MCP server kept
- **THEN** its next turn receives only that server's tools

### Requirement: SYSTEM-PAGE-01 — System page
The System page SHALL show Health, Harness, Tools and Memories, and every problem listed in Health SHALL link to the place where it is fixed.

#### Scenario: a memory nobody receives
- **WHEN** an agent's memory folder has no index wired to it
- **THEN** Memories marks it in amber and Health lists it with a link to that agent's Memory section

## Purpose

Specifies behavioral scenarios for the context inspector, token budget management, context source toggling, context pills in chat input, and topic-level and global memory CRUD operations.

## Background

Common preconditions shared across scenarios:
- The user is logged into Topics App at http://localhost:3333
- A topic exists and is selected with an active chat session
- The context inspector is accessible from the chat panel
- Memory entries can exist at both topic level and global level

## Requirements

### Requirement: CTX-01 — Inspector, Budget Bar, Source Toggle & Memory CRUD

The system SHALL provide a context inspector that displays context sources with token counts, a budget bar showing total usage, the ability to toggle sources on and off, context pills in chat input, and inline CRUD operations for topic and global memory entries.

#### Scenario: Context inspector displays list of context sources
- **GIVEN** a topic is selected with an active chat session
- **WHEN** the user opens the context inspector
- **THEN** a list of context sources is displayed
- **AND** each source shows its name and category

#### Scenario: Each context source displays token count
- **GIVEN** the context inspector is open
- **WHEN** the user views the source list
- **THEN** each context source row displays its token count in a human-readable format
- **AND** sources include system prompt, topic memory, global memory, and attached files

#### Scenario: Inspector shows at least four default context sources
- **GIVEN** a topic exists with default configuration
- **WHEN** the user opens the context inspector
- **THEN** at least four source rows are visible
- **AND** sources include SOUL.md, Topic Memory, Global Memory, and System Prompt

#### Scenario: Budget bar shows total token usage as a percentage
- **GIVEN** the context inspector is open
- **WHEN** the user views the budget section
- **THEN** a budget bar is visible showing total token usage
- **AND** the usage percentage is displayed as a number

#### Scenario: Budget bar reflects low usage with appropriate visual indicator
- **GIVEN** the total context token usage is below 50% of the budget
- **WHEN** the user views the budget bar
- **THEN** the bar displays with a low-usage visual indicator
- **AND** the percentage text reflects the actual usage

#### Scenario: Budget bar reflects high usage with warning indicator
- **GIVEN** the total context token usage exceeds 80% of the budget
- **WHEN** the user views the budget bar
- **THEN** the bar displays with a high-usage visual indicator
- **AND** the percentage text reflects the elevated usage

#### Scenario: Context warning appears when budget usage is critical
- **GIVEN** the context analysis reports usage above 80% with warnings
- **WHEN** the user opens the context inspector
- **THEN** a warnings section is visible with a warning indicator
- **AND** clicking the warnings section expands to show budget details
- **AND** the warning text references the percentage and budget

#### Scenario: Budget bar handles zero budget without displaying invalid values
- **GIVEN** the context budget is set to zero or is undefined
- **WHEN** the user opens the context inspector
- **THEN** the budget bar does not display NaN or Infinity
- **AND** a sensible fallback value is shown

> Note: Zero budget edge case has limited dedicated test coverage.

#### Scenario: Toggle context source off removes it from active context
- **GIVEN** the context inspector is open with all sources enabled
- **WHEN** the user clicks the disable button on a context source
- **THEN** a request is sent to update the topic's disabled context sources
- **AND** the disabled source is included in the list of disabled sources

#### Scenario: Toggle context source on restores it to active context
- **GIVEN** the context inspector is open with a source previously disabled
- **WHEN** the user clicks the enable button on that context source
- **THEN** a request is sent to update the topic's disabled context sources
- **AND** the source is removed from the list of disabled sources

#### Scenario: Toggled source state persists across inspector reopening
- **GIVEN** the user has disabled a context source
- **WHEN** the user closes and reopens the context inspector
- **THEN** the previously disabled source still shows as disabled

> Note: Persistence is mediated by server PATCH on the topic record.

#### Scenario: Rapid context source toggles apply correctly
- **GIVEN** the context inspector is open with multiple sources visible
- **WHEN** the user rapidly toggles multiple sources on and off
- **THEN** each toggle sends the correct accumulated state to the server
- **AND** no race conditions cause incorrect source states

> Note: Race condition handling has limited explicit test coverage.

#### Scenario: Topic memory list shows existing entries
- **GIVEN** the topic has a memory entry with content
- **WHEN** the user opens the context inspector
- **THEN** the Topic Memory source row is visible
- **AND** the memory content is accessible via the expand or edit action

#### Scenario: Edit topic memory entry inline
- **GIVEN** the context inspector is open with Topic Memory visible
- **WHEN** the user clicks the edit button on the Topic Memory row
- **THEN** a textarea appears with the current memory content
- **AND** the user can modify the text

#### Scenario: Save edited topic memory content
- **GIVEN** the user has edited topic memory content in the textarea
- **WHEN** the user clicks the Save button
- **THEN** a PUT request is sent to the topic memory endpoint
- **AND** the request body contains the updated content

#### Scenario: Global memory list shows shared entries
- **GIVEN** global memory exists with content
- **WHEN** the user opens the context inspector
- **THEN** the Global Memory source row is visible
- **AND** the memory content is accessible via the expand or edit action

#### Scenario: Edit global memory entry inline
- **GIVEN** the context inspector is open with Global Memory visible
- **WHEN** the user clicks the edit button on the Global Memory row
- **THEN** a textarea appears with the current global memory content
- **AND** the user can modify the text

#### Scenario: Save edited global memory content
- **GIVEN** the user has edited global memory content in the textarea
- **WHEN** the user clicks the Save button
- **THEN** a PUT request is sent to the global memory endpoint
- **AND** the request body contains the updated content

#### Scenario: Context pills in chat input show attached context filenames
- **GIVEN** a topic has context files attached
- **WHEN** the user views the chat input area for that topic
- **THEN** context pills are displayed near the input
- **AND** each pill shows the filename of an attached context file

#### Scenario: Context pills reflect all attached files
- **GIVEN** a topic has two context files attached
- **WHEN** the user views the context pills
- **THEN** at least two pills are visible
- **AND** each pill corresponds to one of the attached file names

#### Scenario: Context pills update when context files change
- **GIVEN** a topic is displayed with context pills showing current files
- **WHEN** the attached context files are updated on the topic
- **THEN** the context pills update to reflect the new file set

> Note: Dynamic pill updates have limited test coverage; pills are verified after initial topic load.

#### Scenario: Context inspector closes cleanly
- **GIVEN** the context inspector is open
- **WHEN** the user closes the inspector
- **THEN** the inspector panel is no longer visible
- **AND** the chat interface returns to its normal layout

#### Scenario: Memory edit cancellation discards changes
- **GIVEN** the user has opened the memory editor and modified the text
- **WHEN** the user navigates away or closes the editor without saving
- **THEN** the original memory content is preserved
- **AND** no PUT request is sent to the server

> Note: Explicit cancel/discard behavior has limited test coverage; tests focus on the save path.

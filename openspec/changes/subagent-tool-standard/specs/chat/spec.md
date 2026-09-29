# Chat — the sub-agent report says how the child ended

The exit report of SUBAGENT-04 becomes the per-turn result of SUBAGENT-11
(`openspec/changes/subagent-tool-standard/specs/agents/spec.md`). The report no
longer waits for the process to exit, it names a status instead of a generic
"finished with no output", and it carries no emoji.

## MODIFIED Requirements

### Requirement: SUBAGENT-04 — A sub-agent that exits reports its real result to the chat that delegated

A sub-agent spawned from a topic chat reports the end of each of its turns into
that conversation (SUBAGENT-11), so the chat that promised an update reaches an
end instead of hanging on a promise nobody can keep.

The report SHALL be persisted with a structured `subagent-result` block, which
the client draws as a card with i18n labels. It SHALL also carry a plain-text
content: the provider reads that text when the parent is woken (SUBAGENT-12).

The body SHALL prefer the child's own final text only when the turn
`completed`. For every other status it SHALL name the status and its reason. A
partial text SHALL be labelled as the last line seen, never presented as the
outcome.

The header SHALL name the sub-agent by the name its parent chose, and SHALL NOT
contain an emoji.

#### Scenario: The child's own words are the body
- **GIVEN** a result `completed` carrying the child's final assistant text
- **WHEN** the body is formatted
- **THEN** it SHALL be that text, trimmed

#### Scenario: No output, and the exit code says why
- **GIVEN** a result `failed` with no text, no reason and a non-zero exit code
- **WHEN** the body is formatted
- **THEN** it SHALL be an italic note naming that exit code and saying no output was recovered

#### Scenario: A failure names its reason
- **GIVEN** a result `failed` with a reason, for example an expired login or a spend limit
- **WHEN** the body is formatted
- **THEN** it SHALL be an italic note naming the failure and that reason

#### Scenario: A prompt that never arrived is not called a silent finish
- **GIVEN** a result `undelivered`
- **WHEN** the body is formatted
- **THEN** it SHALL say that the prompt never reached the sub-agent
- **AND** it SHALL NOT read "finished with no output"

#### Scenario: A stop mid-turn is marked partial
- **GIVEN** a result `stopped` or `lost` with `partial: true` and a last line of text
- **WHEN** the body is formatted
- **THEN** it SHALL say that the sub-agent was stopped, or lost, before finishing
- **AND** it SHALL quote the last line as the last line seen, not as the outcome

#### Scenario: A clean but silent finish gets the neutral note
- **GIVEN** a result `completed` whose final message holds no text
- **WHEN** the body is formatted
- **THEN** it SHALL be the neutral "finished with no output" note, not a failure

#### Scenario: The report names the sub-agent above its body
- **GIVEN** a formatted result for a sub-agent spawned with the name "dnd-audit" and later auto-renamed
- **WHEN** the chat message is composed
- **THEN** it SHALL open with a bold header naming "dnd-audit", with the body below it
- **AND** the header SHALL contain no emoji

#### Scenario: The report names the branch when the child had one
- **GIVEN** a result for a sub-agent that ran in a worktree of its own (WORKTREE-14)
- **WHEN** the chat message is composed
- **THEN** a closing line SHALL name that branch and how to read its commits
- **AND** a result with no branch SHALL have no branch line

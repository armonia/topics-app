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

### Requirement: SUBAGENT-07 — A sub-agent's exit report is its own row and does not swallow the live turn

The report SHALL be durable the moment it exists: it is written at once on the
child's `subagents` row (`pending_results`), so a restart while the parent's
turn is still open re-sends it instead of losing it. It reaches the parent chat
when that turn has ended, as the row of the wake (SUBAGENT-12), and the copy on
the child's row is dropped only once the chat holds it. A report that cannot
wake the parent is written as an ordinary assistant row at once, as before.

Whatever its role, the report's row is a NEW row: the open turn writes its own
row by id, so the report never takes over the live bubble. The client SHALL
place it by identity — the id announced when the turn started — and never by
position, so the rest of the answer keeps landing in its own bubble.

> Changed by the implementation: the requirement used to say the report row
> is in the database BEFORE the turn closes. With choice 3 the row is the
> wake's `user` row, which must not cut into an open turn (SUBAGENT-12), so
> what is persisted at once is the result on the child's row, and the chat
> row follows the turn's end.

#### Scenario: The report lands beside the live turn, which keeps filling
- **GIVEN** a turn that announced its id and has already streamed part of its text
- **WHEN** a persisted assistant message with a DIFFERENT id arrives
- **THEN** it SHALL appear as a second bubble, the live one keeping the text it already had
- **AND** the deltas that follow SHALL land in the live bubble, not appended to the report

#### Scenario: The row that CLOSES the turn merges into the live bubble
- **GIVEN** a window that received the turn's start but no content deltas — the case of a window not subscribed to the topic
- **WHEN** a persisted assistant message arrives carrying the turn's OWN id
- **THEN** it SHALL merge into the existing bubble, which SHALL then hold the full text
- **AND** exactly one assistant bubble SHALL exist, bearing that id

#### Scenario: A truncated preview does not shorten what the window already has
- **GIVEN** a bubble filled from the catch-up frame with the whole text of the turn
- **WHEN** a persisted message for that same id arrives carrying a shorter preview
- **THEN** the text already displayed SHALL NOT be shortened

#### Scenario: A report delivered under the parent's open turn is written at once and outlives that turn
- **GIVEN** a parent turn still streaming, from which the parent stops its child
- **WHEN** the child's end is reported
- **THEN** the result SHALL be on the child's `subagents` row before the turn closes
- **AND** no chat row SHALL be written while the turn is open
- **AND** when the turn ends, the wake's row SHALL carry the result, and the turn's row SHALL hold the turn's text

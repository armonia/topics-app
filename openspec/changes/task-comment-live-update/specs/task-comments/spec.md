# Task comments

## ADDED Requirements

### Requirement: An acknowledged reply stays visible
The conversation SHALL show a successful comment POST exactly once without waiting for a detail refresh. A superseded read SHALL NOT replace newer detail state or remove a confirmed reply.

#### Scenario: A slow earlier read completes after a reply
- GIVEN an open task conversation and an older detail request in flight
- WHEN the user sends a reply and the server acknowledges it
- THEN the reply appears in the conversation
- AND completing the older request does not remove it

### Requirement: Delivery feedback reflects the actual route
A saved-only comment SHALL be described as a note. A requested agent continuation SHALL be described as waiting for delivery until the session envelope confirms delivery. Quiet notes SHALL preserve the task's state.

#### Scenario: Review task without an assigned agent
- GIVEN a review task without a bound agent
- WHEN a comment is saved
- THEN it remains visible with a saved-note acknowledgement
- AND the interface does not promise an agent reply

### Requirement: Open conversations receive remote comments
- GIVEN an open task conversation
- WHEN another client saves a comment on that task
- THEN the comment appears without reopening the task

# Design

The detail reader tracks request generation and ignores superseded responses. Confirmed comments enter the same comment collection used by the conversation, keyed by their server identity; revalidation runs independently of the successful send acknowledgement. Existing WebSocket board updates remain the source of remote invalidation.

Use the comments endpoint for free-text replies, including review replies: it already owns note handling, human-question routing, and reject/resume behavior. Return additive acknowledgement metadata describing saved-only versus requested delivery. The UI must never interpret an accepted request as proof that an agent has read it.

Exercise ordering with a held stale GET and delayed revalidation in a browser fixture; use real isolated comment persistence and WebSocket broadcasts. Record the successful interaction as a Playwright video. Unit tests cover state reconciliation boundaries, and route tests preserve quiet and review dispatch behavior.

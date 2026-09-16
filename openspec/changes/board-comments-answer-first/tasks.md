# Tasks — board-comments-answer-first

- [x] `RECOMMENDED_OPTION_RULE` in `shared/board.ts`, used by the kickoff and by the `options` of `comment_task` / `comment_global_task`
- [x] Kickoff test: `kickoff asks for the recommended option first, marked in the label`
- [x] Gates: `task-dispatcher.test.ts` 208 pass, `topics-mcp-server.test.ts` 146 pass, `typecheck:server` 0, `check:deadcode`, `check:emdash`, `check:comment-language`, `check:identifier-language` exit 0
- [x] A/B on the model without user settings (`--setting-sources project`): marked first option 0/4 without the rule, 4/4 with it
- [x] `docs/board-protocol.md` (the canonical human copy of the envelope) names the rule: four constants, not three, plus rule 5-bis
- [ ] After a server restart: share of `question` blocks with a recommended option on the board (was 13/78)

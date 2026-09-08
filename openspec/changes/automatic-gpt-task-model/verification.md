# Verification

- Branch: `codex/automatic-gpt-task-model`, isolated worktree `topics-app-auto-gpt`.
- Base: reviewed provider hold fix `892ff11cf`; readiness patch cherry-picked as `c67f7ec93`. The parent has already integrated equivalent readiness separately.
- No real generations, task mutations, runtime restarts, merge or publish.

## Functional evidence

`test-results/automatic-gpt-task-model/final-general-focused.log`: 381 tests passed, 0 failed, 1341 assertions across 13 files (12.39 seconds). Includes semantic-planner contract mocks, manual/board precedence, provider binding, retry after pending discovery, fixed effort compatibility, fanout, Claude hold, CLI arguments, actual fake wrapper/native process termination, native HTTP cancellation with fake credentials, and retained workspace behavior.

`test-results/automatic-gpt-task-model/all-classifier-deadlines.log` records the earlier CLI deadline proof; the final focused log includes the corrected native cancellation fixture as well. Test executables never invoke a model; the native fixture replaces fetch and uses a disposable home containing fake tokens.

Independent reviewer repeated 43 tests / 169 assertions covering provider identity, fixed effort, process trees and quota eligibility, and separately passed the final six pending/manual/fanout scenarios (38 assertions). All four review findings are closed.

## Static checks

The first quick gate passed types, lint and 18 other checks; only spec coverage was red because AGPT requirements initially existed solely in the change proposal. Canonical requirements now live in `openspec/specs/automatic-gpt-task-model/spec.md`. Final targeted types/static outcomes follow below; the parent runs the integrated main gate once.

## References and limits

- Official CLI reference: https://learn.chatgpt.com/docs/developer-commands?surface=cli
- Official config reference: https://learn.chatgpt.com/docs/config-file/config-reference (per-model reasoning effort, shell-tool and web-search controls).
- Read-only installed `codex exec --help` confirms `--model`, `--ephemeral`, `--ignore-user-config`, `--ignore-rules`, and sandbox flags; saved in `codex-exec-help.txt` under the evidence directory.
- Live available Codex slugs/descriptions/efforts were read from the local CLI catalog, with no inference request. Selection uses relative capability/cost descriptions, not invented prices. Unit mocks verify routing/validation/fallback, not the classifier model's real-world accuracy.
- Automatic candidates currently include Topics native, Claude Code and Codex. API chat transports are excluded. ACP Gemini/jcode currently omit the Topics bridge and do not participate in automatic task selection; existing manual routing/bindings remain supported as before.
- Provider and model are separate fields in the internal plan. Account selection/authentication and multiple-account quota management are outside this change.

## Final static outcomes

- `final-static-types.log`: server type errors 0 (baseline 0).
- `final-static-spec-coverage.log`: green, no uncovered/ambiguous/dangling requirements.
- `final-static-any.log`: green.
- `final-static-comments.log`: green.
- `final-static-deadcode.log`: green.
- `git diff --cached --check`: exit 0.
- No server ESLint target exists in this repository (`scripts/lint.ts` accepts only client/relay); server checks above are its applicable targeted checks. The integrated main quick gate is intentionally left to the parent to avoid duplicating aggregate runs.

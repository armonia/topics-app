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

## Integrated live follow-up, 2026-09-09

The initial author verification above made no live calls. The subsequent integration was loaded through the idle daemon restart on 2026-09-08 at 21:43 UTC. A lightweight board verification started with Codex, `gpt-5.6-luna`, effort `low`; two existing coding tasks started with `gpt-5.6-sol` while the Claude quota hold remained active. Task/topic readback confirmed the bindings, and the agents published comments through the Topics bridge.

The live run exposed an adapter defect: Codex MCP calls were not represented in the stream and process liveness was not implemented, so waiting for review checks was mistaken for a dead turn. The redundant verification was stopped after three attempts. The adapter now represents MCP execution/results, accepts nullable transport errors, preserves final command output, and reports liveness only for its owned process. Codex task bridges also exclude the Claude-only child-spawn tool; this is not multi-provider child execution.

The complete pre-review unit run reported eleven failures in six files. Focused investigation corrected the shared API-provider type, the readable requeue-note assertion, the documentation contract parser, and the woken-turn test's named-provider dependency. The latter still sends the production `provider` field; it does not avoid the registry path under test.

Integrated evidence before the final HTTP spawn guard:

- `/tmp/topics-codex-live-final-tests.log`: 48 tests, 91 assertions, no failures, including process ownership, workspace, deadlines and liveness routing.
- `/tmp/topics-gate-regressions-final.log`: 174 tests, 670 assertions, no failures across the six reported files and provider-selection regression.
- `/tmp/topics-codex-dispatch-bridge-tests.log`: 178 tests, 569 assertions, no failures.
- `/tmp/topics-live-fix-gate.log`: the complete quick gate passed on `dec1f8f90`.

These focused results do not claim a successful rerun of the entire unit shard suite. The final live readback and pre-review outcome must be recorded after the remaining guard is loaded. Product follow-up, persistent Codex runtime and actor attribution remain separate board work.

## Subsequent verification and effort recovery

The guarded runtime was loaded at 22:12 UTC. The actual Topics history now includes successful `get_task` and `comment_task` MCP events, a running `update_task` while review checks execute, and complete command output. The process stayed alive through the review-check wait. The phase-1 recovery task subsequently reached review through Topics with its existing scope and coding model retained.

One review run on `f75c6d29e` still failed in `relay/gate-coverage.test.ts`. The isolated test, its shard prefix and the complete rerun on the same checkout passed. `/tmp/topics-full-unit-final-20260909.log` records all 1,286 files passing in 255.6 seconds. The earlier result is intermittent; this rerun does not establish its cause or claim a dedicated fix. The failed board verification was stopped to prevent repeated agent generations.

A separate live readback disproved the verification agent's effort claim: its concrete Luna model had survived release, but its automatic effort had not. The process used the global `xhigh` despite the prose saying `low`. The additive `tasks.model_effort` field now preserves the concrete automatic choice alongside the model through fresh requeue and fanout. Manual model changes clear that pair. Concrete models bypass classification; legacy unpaired choices use explicit `medium`, while an existing bound topic keeps its own effort.

Evidence for that correction: 392 focused tests and a clean server typecheck before test consolidation; 201 dispatcher tests after consolidating two redundant cases; and `/tmp/topics-final-effort-integration-tests.log` with 41 provider-hold/fanout tests and 180 assertions. The integrated quick gate passed every check except the test-file size threshold; `/tmp/topics-final-bloat.log` covers the documented test-only baseline update after consolidation. No security baseline was relaxed. `/tmp/topics-security-final-after-patch.log` confirms the landing dependency patches leave zero reported advisories.

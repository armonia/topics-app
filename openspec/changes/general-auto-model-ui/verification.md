# Verification

- Focused unit tests cover the shared selector, task catalog, task dispatch/resume, ACP capability, provider snapshots and project focus handoff.
- `bun run typecheck`: exit 0 across client, test client, server, E2E and relay.
- `bun run build:client`: exit 0; output is confined to this worktree.
- Static gates `typecheck`, `lint`, `check:deadcode`, `check:emdash`, `check:migrations`, `check:identifier-language`, `check:comment-language`, `check:untraced-tests`, `check:spec-coverage`, `check:sleeps`, `check:test-skips`, `check:ui-language`, `check:bloat`, `check:e2e-touched` and `git diff --check`: exit 0.
- Isolated Playwright `tests/e2e/task-model-labels.spec.ts`: desktop English and phone Italian pass together on port 14720 (`2 passed`). It checks the shared runtime-first picker in task detail, task composer, normal chat and project settings; keyboard forward/back focus; retained manual selection; API-only catalog exclusion; assigned-session lock; concrete labels and small-viewport containment.
- The final run used `E2E_EVIDENCE=1 E2E_VIDEO=1`; the retained phone interaction video is 6.48 seconds. Only fixture catalogs and isolated test tasks were used; no login or model invocation.

The retained phone evidence is `test-results/artifacts-14720/task-model-labels-Task-mod-49a14-gned-labels-remain-readable-chromium/video.webm`.

The server snapshot now advertises task-coding capability explicitly. Stored task values encode an explicit runtime when one was selected, while legacy model-only values keep their previous interpretation. Dispatch and resume reject unavailable explicit routes instead of silently selecting another runtime. JCode remains manual because the automatic resolver does not execute ACP catalogs. Project navigation writes focus synchronously to avoid a hydrate restoring the previous pane. No publish or runtime restart is part of this change.

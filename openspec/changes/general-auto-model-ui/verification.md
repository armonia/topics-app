# Verification

- `bun test client/src/components/Board/format.test.ts client/src/components/Board/Card.test.ts client/src/components/Board/TaskDetail.test.ts`: 43 passed, 107 assertions.
- `bun run typecheck:client` and `bun run typecheck:e2e`: exit 0.
- `bun run build:client`: exit 0; output is confined to this worktree.
- `bun run check:spec-coverage` and `bun run check:untraced-tests`: exit 0.
- Isolated Playwright `tests/e2e/task-model-labels.spec.ts`: 2 passed in 12.9 s, desktop English and phone Italian. Checks general Auto copy, manual model persistence, API-only catalog exclusion, assigned-session lock, concrete GPT labels and long-label containment.
- The phone scenario was repeated with `E2E_EVIDENCE=1 E2E_VIDEO=1` to retain the video: 1 passed in 11.4 s. Only fixture catalogs and isolated test tasks were used; no login or model invocation.

Logs are in `test-results/general-auto-model-ui/`. The retained phone evidence is in `test-results/artifacts-13427/task-model-labels-Task-mod-49a14-gned-labels-remain-readable-chromium/`: `resolved-task-model.png`, `resolved-card-model.png`, `video.webm` and `trace.zip`.

The UI is independent of account count. The routing change must be integrated alongside this patch before advertising general automatic selection as live behavior. No publish or runtime restart is part of this change.

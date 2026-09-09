# Clear provider-limit notice

## Goal
Replace the tiny truncated plan-limit sentence with a readable, actionable Claude notice that also appears on mobile without covering the composer.

## Scope
Use the existing chrome colors, typography and menu primitive. Keep one compact notice with provider, state and dated reset; expand details on demand and link to Provider AI settings. Preserve current hold/usage expiry and offline precedence. Reserve the mobile notice's actual height in the layout. This change does not alter quotas, credentials, provider selection or dispatch policy.

## Acceptance bar
Isolated desktop/mobile browser tests with screenshots/video cover expansion, dismissal, settings navigation, date visibility and no overlap with the composer/navigation. Existing usage/transport checks remain green, as do typecheck, lint, static gates and the current bundle budget.

## Verification
- 2026-09-08: 7 isolated Chromium E2E tests passed, including both themes on desktop and touch phone, existing usage transitions and mobile offline status. Screenshots, videos and traces are under `test-results/artifacts-13362/provider-limit-notice-*`; run log: `test-results/provider-limit-notice/e2e-final.log`.
- 12 existing provider-hold/plan-usage state tests passed, including expiry notifications.
- `bun run qa:gate --veloce` passed all static checks, typecheck and lint. Log: `test-results/provider-limit-notice/qa-gate.log`.
- Client build and existing bundle budget passed: eager entry 1,416,602 bytes; gzip 440,636 bytes. No budget adjustment or dependency added.
- Independent read-only review found no concrete defect. Keyboard coverage simulates visualViewport resizing; it is not a physical iPhone keyboard test.

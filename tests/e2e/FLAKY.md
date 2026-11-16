# Flaky e2e tests (measured 2026-11-16)

These tests failed in at least 3 of the last 20 CI runs. They cannot be run on a
dev machine, so the cure happens on CI. Tracked by card 173c3266.

- board-settings-dropdown.spec.ts:497 DROP-09 (7/20)
- browser-process.spec.ts:345 BROWSER-05 (4/20)
- dashboard-consumi.spec.ts:130 row with your name opens Consumi (4/20)
- chat-infinite-scroll.spec.ts:547 merge with the rest delayed 1500 ms (3/20)
- chat-transcript-motion.spec.ts:289 F02 live tool body (3/20)
- dictation-hermetic.spec.ts:150 voice note carries the spoken text (3/20)
- topics-archive-boot.spec.ts:50 ARCHIVE-BOOT-01 (3/20)

# Usage hub: five red tests from before 14/11 (card 3c6e9dd8)

The fixes live in the usage-hub repo (excluded from this public one), local commit 4aee0e13.

- Pacing gate: code was broken, "Muse off" was missing from the default providers-off set.
- Workspace resolution: code was broken, the jarvis workspace was swallowed as a plain "jarvis" name.
- Legacy-name test: the test had aged, it scanned build output and binaries.
- Queue entry for an archived card: already green, no change.
- jcode attribution and report tests: green after the fixes above.

Bar: `node --test test/jcode.test.mjs test/no-legacy-name.test.mjs test/pacing-providers-off.test.mjs test/queue-route-card.test.mjs` exits 0 (13/13).
The slow `queue.test` taskpolicy case runs on the PC, not here.

# Tray opening lag: phase tracking fix (card b3e19133)

## Problem

The tray watchdog logged `warmCache` runs inside `prepareMenu` as phase `menu`
because `menuNeedsUpdate`'s `defer` fired `Perf.phase = "menu"` before the
warm loop started. `tray-lag-live.py` counted all non-`riposo` blocks as felt
lag, so a 436 ms `warmCache` between opens appeared as user-visible lag.

Similarly, `buildMenu` called by `prepareMenu` was tagged `costruzione`,
indistinguishable from a synchronous build on the click path; under heavy CPU
load (13-15 cores) these reached 18-31 s and always failed the 250 ms block
threshold.

## Fix (jarvis, no topics-app commit required)

Two changes in `ClaudeUsage.swift`:

1. **`inPrepare` flag** -- `prepareMenu` sets it before calling
   `menuNeedsUpdate` and clears it after. `menuNeedsUpdate` checks the flag:
   when true, it uses phase `preparazione` instead of `costruzione`/`menu`,
   so the watchdog tags background prep work correctly.

2. **Phase reset** -- after `menuNeedsUpdate` returns inside `prepareMenu`,
   the phase is explicitly reset to `preparazione` before the warm loop runs.

One change in `tray-lag-live.py`:

- `felt` now excludes both `riposo` and `preparazione`: background prep work
  between opens is not user-visible lag (same reasoning as `riposo`).

## Outcome

- Bench: median 42 ms at load 15/12, exit 0.
- Live measurement cron reset to `--dal 1793835193183` (install timestamp
  04 Nov 12:33), runs daily at 13:05, self-removes on first clean pass.

# Tray open lag: measurement setup and thresholds

The macOS status-bar tray logs every open and every main-thread block to
`~/.cache/claude-usage-tray/perf.log`. Enable it by touching
`~/.cache/claude-usage-tray/perf` (file must exist; content ignored).

## How it is measured live

```
python3 tools/usage-hub/modules/tray/scripts/tray-lag-live.py \
  --dal <install-epoch-ms>
```

Exits 0 (no lag) when **all** of:
- Median open time < 150 ms
- No main-thread block > 250 ms while the menu is open

The `com.jarvis.tray-lag-measure` LaunchAgent runs the script daily at 13:05
and unloads itself when the tray passes.

## How it is measured in the bench (no mouse required)

```
bash tools/usage-hub/modules/tray/scripts/tray-perf.sh [iterations]
```

Exits 0 when: bench apertura median < 150 ms, hover < 50 ms CPU,
processes submenu fill < 50 ms CPU.

## 2026-11-14 fix: binary-search text truncation

`unitItem()` and `fitLine()` measured string width with a linear loop
(O(n) `NSString.size()` calls per string). With 15 process rows the
`fill()` blocked the main thread for 477 ms.

Fix: `binTrunc()` uses binary search (O(log n) calls). Bench result after
the fix: processes submenu 4 ms, apertura median 18 ms, exit 0.


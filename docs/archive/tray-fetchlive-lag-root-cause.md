# Tray lag root cause: fetchLive JSON decode on main thread

**Date:** 2026-11-09  
**Card:** b3e19133

## Symptom

Apertura mediana 250ms (threshold 150ms), 123 blocks >250ms labeled "menu",
worst 10846ms. One opening measured apertura=3950ms, appkit=3237ms.

## Root cause

`fetchLive` used `group.notify(queue: .main)` to decode 9 endpoint JSON
responses. Because `DispatchQueue.main.async` has higher priority than
`RunLoop.main.perform` in EventTracking mode, the JSON decode ran BEFORE
the apertura measurement could be logged -- delaying it by the full decode
time (1063ms to 10846ms depending on payload size and system load).

The same blocks appeared as "menu" phase watchdog entries while the menu
was open, because the decode ran on the main thread throughout the user's
interaction.

## Fix

`group.notify(queue: .global(qos: .utility))` decodes all 9 responses on a
background thread. Only tiny assignment closures are dispatched to the main
thread -- sub-1ms each, well below the 50ms watchdog threshold.

Secondary fix: `menuWillOpen` rewarm on scale mismatch is deferred via
`RunLoop.main.perform` instead of running synchronously before `Perf.opened`.
Measured rewarm cost on scale change: ~44ms.

The measurement script now excludes the "chiuso" phase (blocks after menu
close, never felt by the user).

## Lesson

A `group.notify(queue: .main)` that decodes non-trivial JSON is a main-thread
block. In EventTracking mode it preempts RunLoop.perform, making apertura
measurements appear larger than the user's actual wait.

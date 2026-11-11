# NSMenu custom views: CA layer backing eliminates Window Server IPC lag

**Problem.** When NSMenu opens after an idle period, Window Server evicts
the backing stores of custom NSView items. The next open forces a full
re-upload: on a 540x422 pt panel at 2x scale this is ~2MB of bitmap
transferred over Window Server IPC, costing 1-3s on the main thread.

**Root cause.** Without `wantsLayer`, AppKit routes draw() output through
the Window Server compositor (IPC round-trip). The backing store is evicted
aggressively after the menu window hides.

**Fix.** Set `wantsLayer = true` on the custom views so CA uses an IOSurface
instead. For views with no hover/highlight, also set
`layer.contents = rep.cgImage` and `layerContentsRedrawPolicy = .never`
after warmCache: CA pre-uploads the texture to the GPU once, reuses it on
every subsequent open with no IPC and no draw() call.

**Measurement.** `--perf-bench` baseline with the fix: apertura 37ms median
vs 250-1100ms live before. The live measurement uses tray-lag-live.py
(median <150ms, no block >250ms as acceptance bar).

**Lesson.** `CATransaction.flush()` after setting `layer.contents` on an
off-screen view encourages CA to upload the texture to the GPU immediately,
so the first on-screen composite is instant.

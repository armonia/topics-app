# wkzprobe — two child WKWebViews in one window: who is on top, and can a drag move one of them live?

The instrument for the two unknowns of `openspec/changes/browser-della-topic`
(card `e0821533`), before a floating browser window gets written. Two arms, one
binary, the same shape the shell has: a host webview filling the window plus
child webviews positioned by `set_bounds`, exactly like a browser pane.

wry is used directly, so the numbers are a **floor**: a `#[tauri::command]`
adds serde and a hop through the event loop on the same path.

## Arm `z` — z order

```
cd tools/wkzprobe && cargo run --release -- z
```

Exit 0 = every expectation met, 1 = at least one missed. Measured 2026-09-13 on
the development Mac (macOS 26, wry 0.55.1):

| question | answer |
|---|---|
| pane created first, floating view second | the **second** takes the hit test |
| `set_bounds` on the lower view | **no reorder** — it stays underneath |
| `removeFromSuperview` + `addSubview:positioned:above:` | the raised view **wins** |
| a third view created afterwards | **covers** the raised one |
| the raised page | **survives** — same token it minted at birth, no reload |

Which is the whole rule: **z order is creation order**, and nothing but a
re-add changes it. In wry every child goes in with `addSubview:`
(`wkwebview/mod.rs:666`), which appends, and `set_bounds` only calls
`setFrame:` (`:1024`), which never reorders. Tauri adds nothing: its
`SetPosition` message lands on the same `set_bounds`.

## Arm `drag` — one `set_bounds` per animation frame

```
cd tools/wkzprobe && cargo run --release -- drag
```

240 frames: the page posts one IPC per `requestAnimationFrame`, the host moves
the child view 8 logical px (≈480 px/s, an ordinary drag speed) and acks back.

Four runs, same machine, nothing else on screen:

| | p50 | p95 | max |
|---|---|---|---|
| round trip page → host → page | 1–2 ms | 6–17 ms | 21–34 ms |
| `set_bounds` itself, host side | 0.10–0.13 ms | 0.24–0.29 ms | |
| interval between frames | 17 ms | 23–33 ms | 38–132 ms |

The median is nowhere near a frame; the **tail is a full frame or two**, on the
floor path, with a page that does nothing else. That is the number the design
decision rests on.

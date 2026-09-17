# wkzprobe — two child webviews in one window: who is on top, and can a drag move one of them live?

The instrument for the two unknowns of `openspec/changes/browser-della-topic`
(card `e0821533`), before a floating browser window gets written. Two arms, one
binary, the same shape the shell has: a host webview filling the window plus
child webviews positioned by `set_bounds`, exactly like a browser pane.

wry is used directly, so the numbers are a **floor**: a `#[tauri::command]`
adds serde and a hop through the event loop on the same path. That Tauri adds
nothing to the z order is read in its source (`SetPosition` lands on the same
`set_bounds`), not run: the shell's own `browser_raise` has not been invoked yet.

## Versions

`Cargo.toml` pins wry, tao and objc2 with `=` to what
`desktop-tauri/src-tauri/Cargo.lock` resolves (wry 0.55.1, tao 0.35.3), and
`Cargo.lock` is committed for everything underneath. Move the pins together with
the shell's.

The runs below were taken before the pin, on wry 0.55.1 and tao "0.34", which
the local cargo cache says was 0.34.8 (the only 0.34 it holds). The
macOS backend of tao 0.34.8 and 0.35.3 is byte-identical
(`diff -rq src/platform_impl/macos` prints nothing), so the pin does not change
the measured path.

## Arm `z` — z order

```
cd tools/wkzprobe && cargo run --release -- z
```

Exit 0 = every expectation met, 1 = at least one missed. Measured 2026-09-13 on
the development Mac (macOS 26):

| question | answer |
|---|---|
| pane created first, floating view second | the **second** takes the hit test |
| `set_bounds` on the lower view | **no reorder** — it stays underneath |
| `addSubview:positioned:above relativeTo:nil` on the lower view | the raised view **wins** |
| the raised view held the keyboard | it **stays first responder** (see below) |
| a third view created afterwards | **covers** the raised one |
| the raised page | **survives** — same token it minted at birth, no reload |

Which is the whole rule: **z order is creation order**, and nothing but an
explicit reorder changes it. In wry every child goes in with `addSubview:`
(`wkwebview/mod.rs:666`), which appends, and `set_bounds` only calls
`setFrame:` (`:1024`), which never reorders.

**The raise is `addSubview:positioned:` alone.** On a view that already sits in
that superview AppKit reorders it in place, with no `willMoveToSuperview:`
callback. The first version of the raise did `removeFromSuperview` first: it
reorders just the same, but it hands the first responder to the NSWindow, so
the page stops receiving keys while `document.activeElement` and the page token
say nothing happened. That was measured during review with AppKit directly
(swiftc, NSTextView and WKWebView), and it is why the arm now gives the pane the
keyboard before the raise and checks `first-responder-survives-the-raise`
after it.

**That verdict has not been run yet**: it was added together with the fix, on a
machine that could not afford the build. Before trusting it, run the arm once
as it is (expect exit 0), then put `view.removeFromSuperview();` back in front
of the `addSubview` in `raise_role` (expect exit 1 on that verdict alone).

On WebKitGTK none of this has been probed (`GtkFixed.put` appends,
`webkitgtk/mod.rs:620`). WebView2 now has its own backend and its own run,
below.

## Arm `z` on Windows — the same six verdicts on WebView2

`src/views_win.rs` is the second backend: same five functions, same meanings,
Win32 instead of AppKit. wry gives every child webview a container window of
class `WRY_WEBVIEW`, a direct child of the tao window, with the WebView2 render
windows (`Chrome_WidgetWin_*`, `Chrome_RenderWidgetHostHWND`) underneath it in
the browser processes. That container is the same handle
`controller().ParentWindow()` gives `browser_win::raise`, so `raise_role` issues
the production call verbatim: `SetWindowPos(hwnd, HWND_TOP, 0,0,0,0,
SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE)`.

Measured 2026-09-15 on the Windows box (10.0.26200, WebView2 Evergreen), all six
true, exit 0. The pile printed at each step shows the reorder directly: before
the raise the order is host, pane, floater; after it, host, floater, pane.

| question | answer |
|---|---|
| pane created first, floating view second | the **second** takes the hit test |
| `set_bounds` on the lower view | **no reorder** — it stays underneath |
| `SetWindowPos(HWND_TOP)` on the lower view's container | the raised view **wins** |
| the raised view held the focus | it **keeps it** (`SWP_NOACTIVATE`) |
| a third view created afterwards | **covers** the raised one |
| the raised page | **survives** — same token it minted at birth |

**Falsified, so the arm is not free.** With the `SetWindowPos` call commented
out and nothing else changed, the same run prints `raise-wins=false` and exits 1,
while the other five stay true and the pile stays host, pane, floater. The
verdict tracks the production call and not the probe's own bookkeeping.

**`first-responder-survives-the-raise` is the weak one here.** The WebView2
render windows belong to other processes, so `SetFocus` across threads is
refused and the only thing this process can focus is the container; the check is
therefore "focus is on the container or under it", before and after. It says
`SWP_NOACTIVATE` does not move focus, which is what the shell claims, but it
does not exercise a page that is actually typing.

### How to run it: a scheduled task, not ssh

```
schtasks /Create /TN "wkzprobez" /TR "C:\...\runz.cmd" /SC ONCE /ST 23:57 /RL LIMITED /F
schtasks /Run /TN "wkzprobez"
```
where `runz.cmd` runs `wkzprobe.exe z` with stdout redirected to a file that is
then read back over ssh.

**A process launched over OpenSSH cannot run this arm at all.** It lands in a
non-interactive window station and WebView2 refuses the window handle:
`CreateCoreWebView2Controller` fails with `0x80070578`
(`ERROR_INVALID_WINDOW_HANDLE`) before any child exists. The window itself is
built fine, which makes the failure look like a wry problem and is not one. The
build is fine over ssh; only the run needs the console session.

**The tick comes from an `EventLoopProxy`, not from `ControlFlow::WaitUntil`.**
Under that scheduled task tao's Windows loop dispatches `NewEvents(Init)` and
the `DeviceEvent::Added` burst and then never calls the handler again, with
`WaitUntil` or with `Poll` alike; `MainEventsCleared` never arrives. A user
event posted from a thread does wake it. The macOS arm was re-run after the
change and still exits 0 with all six true, so the change costs it nothing.

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

**What the round trip is.** A ceiling on the way there, not the way there: it
includes the ack's way back (`evaluate_script` right after `set_bounds`) and the
wait for the main thread of the very page that measures, the one that drops
frames. The way there alone cannot be had by subtraction, because
`performance.now()` in the page and `Instant` in the host are different clocks,
and even with a shared clock it would still be IPC latency, not on-screen drift.
The frame interval is not a delay either: in the app `set_bounds` is driven
from the rAF of the host page, which also paints the frame around the view, so
a dropped frame delays both together.

**What it says, at 480 px/s.** The median is nowhere near a frame. At **p95**
(6–17 ms) the round trip is **3–8 px, within about one frame** (only the worst
run reaches 1.02 frames). It is the **max tail** (21–34 ms, 10–16 px, one to two
frames) that falls outside "within a frame".

**What it does not say.** The task's criterion was the drift between cursor and
view edge in a 60 fps screen recording; this probe replaced that method, it did
not run it. The design's "drag from a still frame" is therefore a prudent
choice resting on the max tail, on a floor that the app can only raise, and on
the stutter already paid for with the sidebar slide. It is inferred, not
demonstrated. Demonstrating it takes the original measurement: record the
screen at 60 fps while the DOM frame and the native view move from the host
page's rAF, and count the pixels of drift frame by frame.

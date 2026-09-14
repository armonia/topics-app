# wvzprobe - two child WebView2 views in one window: who is on top, and what puts the other one back?

The Windows twin of `tools/wkzprobe z`, and the instrument for the `ENGINES-GAP`
that `browser_raise` carried on webview2 (card `e0821533`, probe asked for by
card `99e56f4f`). Same five questions, same shape: a host webview filling the
window plus child webviews positioned by `set_bounds`, exactly like a browser
pane.

wry is used directly, so the answers are about the ENGINE, not about Tauri: a
`#[tauri::command]` only adds serde and a hop through the event loop on the same
path.

## Versions

`Cargo.toml` pins wry, tao and the `windows` crate with `=` to what
`desktop-tauri/src-tauri/Cargo.lock` resolves (wry 0.55.1, tao 0.35.3,
windows 0.61.3), and `Cargo.lock` is committed for everything underneath. Move
the pins together with the shell's.

## Arm `z` - z order

```bash
brew install mingw-w64                       # once
rustup target add x86_64-pc-windows-gnu      # once
cd tools/wvzprobe && cargo build --release --target x86_64-pc-windows-gnu
```

Exit 0 = every expectation met, 1 = at least one missed, 2 = wrong platform,
3 = watchdog at 40 s. Measured 2026-09-14 on the Windows 11 machine
(build 10.0.26200, WebView2 Evergreen), in 3.9 s:

| question | answer |
|---|---|
| pane created first, floating view second | the **second** takes the hit test |
| `set_bounds` on the lower view | **no reorder** - it stays underneath |
| `SetWindowPos(HWND_TOP, SWP_NOMOVE\|SWP_NOSIZE\|SWP_NOACTIVATE\|SWP_NOOWNERZORDER)` | the raised view **wins** |
| the raised view held the keyboard | the focus **stays inside it** |
| a third view created afterwards | **covers** the raised one |
| the raised page | **survives** - same token it minted at birth, no reload |

Which is the same rule AppKit gave: **z order is creation order**, and nothing
but an explicit reorder changes it. It is also visible in the wry source: every
child HWND is born with `SetWindowPos(HWND_TOP)` (`webview2/mod.rs:268`), which
puts it on top, and `set_bounds` passes `SWP_NOZORDER` (`:1456`), which
deliberately leaves the pile alone.

**The raise is one `SetWindowPos` with `HWND_TOP` and nothing else moved.** The
flags matter: without `SWP_NOACTIVATE` the raise would also steal the
activation, and `SWP_NOOWNERZORDER` keeps the parent window out of it. On the
run above the keyboard was inside the pane before the raise and still inside it
after, and the page kept the random token it minted at birth, so a raise is
neither a reload nor a focus change.

**Two independent verdicts, not one.** The pile is read twice: the window tree
(`GetWindow` GW_CHILD/GW_HWNDNEXT plus `ChildWindowFromPointEx` at the overlap)
and the SCREEN pixel at the same point (`GetPixel` on the desktop DC, each page
painted a colour of its own). They agreed at every step but the last, where the
tree says `late` and the pixel says `pane`: the third view had just been created
and had not painted yet when the frame was read. The verdict for that step is
the tree's, and the disagreement is what tells you why.

## Running it on the Windows machine

Three files go next to each other: `wvzprobe.exe`, the matching
`WebView2Loader.dll` (from `webview2-com-sys-*/x64/` in the cargo registry - the
gnu build links it dynamically) and `run.ps1`.

It has to run in the INTERACTIVE session. From an ssh session the window lives
on another window station and the main webview fails with
`0x80070578 ERROR_INVALID_WINDOW_HANDLE` before any step is reached, so drive it
the way `tools/wv2probe` and `tools/win-desktop-check.sh` do:

```
schtasks /create /tn WvzProbe /tr "powershell -NoProfile -ExecutionPolicy Bypass -File <folder>\run.ps1" /sc once /st 23:59 /it /f
schtasks /run /tn WvzProbe
```

`run.ps1` writes `wvzprobe-run.log` next to itself, and the arm itself writes
`wvzprobe-z.log`: everything it prints goes to both the console and the file,
because nobody is watching the console of a scheduled task.

**The step clock is a proxy wake, not `ControlFlow::WaitUntil`.** Two other
shapes were tried first on the real machine and neither ran a single step:
re-arming `WaitUntil(now + d)` inside the closure pushes the deadline forever,
because WebView2 wakes the loop constantly and every wake arrives as
`WaitCancelled`; and a deadline held outside the closure never fired at all. A
thread posting a user event every 600 ms is the one clock both backends owe the
caller. This is worth knowing before writing any other timed probe here.

## What it does not say

Only the z order of sibling child webviews inside ONE window, on one machine,
with the Evergreen runtime that machine had installed. It says nothing about two
separate top-level windows, nothing about the Tauri command wrapping the call
(the shell's `browser_raise` still has to be written and run), and nothing about
WebKitGTK, whose twin is `tools/gtkzprobe`.

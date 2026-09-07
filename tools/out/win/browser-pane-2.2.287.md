# The Windows browser pane on 2.2.287: it was never the pane

`topics-desktop-2.2.287.md` reported (e) as a pane that opens and never shows
anything: the capture taken 13s and two navigations after it appeared was
byte-identical to the one taken the instant it opened, in both runs. That
reading has two possible causes and pixels cannot separate them, so this card
asked the window tree, an HTTP witness and both capture methods instead.

Instrument: `tools/win-browser-probe.sh` (driver) and `tools/win-browser-probe.ps1`
(the probe, run in the interactive session through a scheduled task like the
gate). Machine: the same Windows box, the same installed 2.2.287, nothing
rebuilt. The three captures that carry an answer are kept next to this file; the
probe's raw output (logs, and one capture per step in both methods) lands in
`tools/out/win/probe/`, which is gitignored and is rewritten by the next run.

## What the pane actually does

| question | answer | how it was read |
|---|---|---|
| does the native WebView2 exist? | yes, with its own browser, gpu and renderer processes on its own store | the window's child tree, and the `msedgewebview2.exe` command lines carrying `--user-data-dir=...\browser-stores\<uuid>` |
| is it on screen? | yes: `1342,271 1078x890`, which is the pane's DOM placeholder (`322,40 1078x890`) plus the window origin | `EnumChildWindows` against `getBoundingClientRect()` read in the client |
| does it navigate? | yes, loopback and internet: `http://127.0.0.1:13333/robots.txt` and `https://example.com/` both land, `document.title` reads back through `browser_eval_js` | driven through the client's own tauri bridge |
| does it paint? | yes: a page served solid red fills **73.6%** of the window | two captures at the same instant |
| is `PrintWindow` blind to a second WebView2? | no: `PrintWindow(hwnd, dc, 2)` and a screen grab agree to the decimal (lum 109 / red 73.6% both, and 245/245 before the pane) | the gate's own capture next to `Graphics.CopyFromScreen` |
| did the request really leave? | yes: a TCP witness on a port the app does not use logged `GET /red-page` with `Edg/152.0.0.0`, so it was the native pane and not the server-side headless context | the witness log of the run, `probe/witness-red3.log` |

## What fails, then

The ADDRESS never arrives. Both arms that type it the way the gate does read
nothing: no request at the witness, and the tab stays on the new-tab page.
Driven through a channel that does not depend on the window focus (the client's
own bridge: focus the bar, insert the text, Enter) the same build navigates and
paints.

The reason is one line of geometry away: a WebView2 created as a child takes the
window's keyboard the instant it exists. The client focuses the address bar of a
fresh tab 50ms after mount, the native view is created a moment later, and that
focus becomes void. Measured on a pane opened from scratch, three samples:

```
t+1200ms  document.activeElement = BODY
t+2500ms  document.activeElement = BODY
t+5000ms  document.activeElement = BODY
```

So the user opens a browser pane, types an address and nothing happens. From
outside, that is a pane that never loads, which is exactly what the gate wrote
down.

And nothing gave the keyboard back: `browser_release_focus`, the command the tab
strip calls on pointer-down for precisely this, was written for macOS only and
every other platform fell into a single discard. Forcing it from outside does
not work either: with the probe's input queue attached to the app's thread, a
`SetFocus` on the client's own webview child moved the OS focus and the client
still received nothing, because a WebView2 keeps its focus state inside the
controller and only the app can move it.

## The fix, and what is still unproven

Two halves, both in the commit that carries this file:

- the shell hands the keyboard back to the host window's UI webview when it
  CREATES a pane, and `browser_release_focus` finally has a body outside macOS.
  One portable line: wry maps `Webview::set_focus` to
  `MoveFocus(PROGRAMMATIC)` on WebView2 and to `grab_focus` on WebKitGTK.
- the client re-asks for the caret when the native view becomes ready, because a
  window that has the focus with no focused element still types nowhere.

Compiled for Windows with `scripts/check-cross-shell.sh windows`. Held by
`tests/unit/pane-hands-keyboard-back.test.ts` and by NATIVEOPS-05.

**Not proven end to end.** That needs an installer built from a `tauri-v*` tag
and another run of `tools/win-desktop-check.sh`, which is a release decision.
Until then (e) will keep failing on the shipped build, and now the report says
what it is failing on.

## A note for whoever runs the gate next

The Windows desktop is a SHARED single-user desktop: while this card was
measuring, another session was driving `win-focus-probe.ps1` on the same box,
killing and relaunching the app under the probe. Two GUI measurements at once
produce readings about the machine, not about the build. Check
`Get-ScheduledTask | Where TaskName -match Topics` for a task in `Running`
before starting.

# wv2probe — does a WebView2 child webview built inside the IPC callback ever finish?

The falsification instrument for `NATIVEOPS-04`, and the reason Topics 2.2.281
shipped a browser pane that never left its spinner on Windows.

Two arms, one binary, the same child webview:

| arm | where the child is built | result on the real machine |
|---|---|---|
| `sync` | inside the `ipc_handler`, exactly where a synchronous `#[tauri::command]` runs | **never finishes** — watchdog killed it at 25s |
| `queued` | posted to the event loop, built there | **built in 463 ms**, exit 0 |

Measured 2026-09-07 on the Windows box, both arms in one run:

```
=== arm sync : exit=3 wall=25254ms
     0 ms  arm=sync
   600 ms  event loop: started
   615 ms  ipc handler: entered (inside the WebView2 callback)
 25001 ms  WATCHDOG: no child webview after 25s
=== arm queued : exit=0 wall=1294ms
     0 ms  arm=queued
   590 ms  event loop: started
   606 ms  ipc handler: entered (inside the WebView2 callback)
   607 ms  ipc handler: queued to the event loop
   607 ms  ipc handler: returned
   609 ms  event loop: building the child
  1072 ms  RESULT: built on the event loop
```

Why it hangs: wry waits for `CreateCoreWebView2Environment` and
`CreateCoreWebView2Controller` with `webview2_com::wait_with_pump`, a NESTED
message loop. The pump keeps the window alive, so the app looks healthy and
keyboard shortcuts still answer, but the completion callback cannot be delivered
while the outer COM call is on the stack. Tauri says the same thing on its own
`WebviewBuilder::new`: "on Windows, this function deadlocks when used in a
synchronous command or event handlers".

## Running it

Cross-built from macOS, run on Windows — no MSVC toolchain needed anywhere:

```bash
brew install mingw-w64                       # once
rustup target add x86_64-pc-windows-gnu      # once
cd tools/wv2probe && cargo build --release --target x86_64-pc-windows-gnu
```

Three files go next to each other on the Windows machine: `wv2probe.exe`, the
matching `WebView2Loader.dll` (from `webview2-com-sys-*/x64/` in the cargo
registry — the gnu build links it dynamically, the MSVC one does not), and
`run.ps1`.

It has to run in the INTERACTIVE session. From an ssh session the window lives
on another window station and the MAIN webview already fails with
`0x80070578 ERROR_INVALID_WINDOW_HANDLE` before either arm is reached, so drive
it the way `tools/win-desktop-check.sh` drives everything else:

```
schtasks /create /tn Wv2Probe /tr "powershell -NoProfile -ExecutionPolicy Bypass -File <folder>\run.ps1" /sc once /st 23:59 /it /f
schtasks /run /tn Wv2Probe
```

`run.ps1` writes `wv2probe-run.log` next to itself: both arms, with wall clock
and exit code. `sync` exiting 3 and `queued` exiting 0 is the whole measurement.

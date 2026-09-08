# The Windows browser pane on 2.2.291: the address typed by hand loads

`browser-pane-2.2.287.md` closed on a keyboard that never arrived: on 2.2.287 no
address typed into the pane's bar ever produced a request, in either arm, and
only the client's own bridge could navigate. The fix landed as 71466b7ee (focus
handed to the client when the pane is created, `browser_release_focus` alive on
Windows, the bar re-armed at the native `ready`) and this file is the reading of
that fix ON THE PRODUCT: the published release, installed from its own
installer, driven by keys and a mouse and read by an HTTP witness.

Release `tauri-v2.2.291`, asset `Topics_2.2.291_x64-setup.exe`, digest
`sha256:8065576991d987c4aad28778515f4146ec63d82c1bdc7938b954e1b5bae7fd45`
matching what GitHub declares (the installer is not Authenticode signed, so that
digest is the whole integrity check). Installed over 2.2.290 on the same Windows
machine as the two reports before it.

## The measure

Witness: a TCP listener of ours on 127.0.0.1:13444, a port the app does not use,
serving a solid red page and logging every request with its User-Agent. `Edg/`
is the pane's native WebView2; `HeadlessChrome` would be the server-side
Playwright context; nothing at all is a keyboard that went nowhere. Everything
runs in the console session through a scheduled task registered with `/it`,
like the gate and the probe next to it.

| arm | what is typed | witness | verdict |
|---|---|---|---|
| pane opened, then the address at once | `http://127.0.0.1:13444/fresh-pane` + Enter, no click, no `Ctrl+L` | `GET /fresh-pane  UA=... Edg/152.0.0.0` | **the fix works** |
| the address bar clicked first, then the address | `http://127.0.0.1:13444/typed-mouse` + Enter | `GET /typed-mouse  UA=... Edg/152.0.0.0` | works |
| `Ctrl+L` then the address | same address | nothing | `Ctrl+L` never reaches the client |

The first row is the scenario the card asks about, and it is the one that was
dead on 2.2.287: a pane is opened, the address is typed straight away, the page
loads. `02-typed-address-loaded.png` is the witness page rendered inside the
pane, red end to end, so the request in the log and the pixels agree.

The keyboard focus, sampled through `GetGUIThreadInfo` at every step, says why:
after the relaunch and after the pane opens it sits on a `Chrome_WidgetWin_1` of
`msedgewebview2`, and it STAYS there once the pane's own WebView2 exists. On
2.2.287 the child took the window's keyboard at creation and the client's bar
went void 50ms after mount.

## What still does not work, and it is not this card

`Ctrl+L` (third row) reads a keyboard focus of `Tauri Window`, the top level, and
the keys reach no web content: the shortcut is swallowed. The same shape as
`Ctrl+K` on the bare window, which is card cd040754 and is open. So: typing INTO
the pane works, the client SHORTCUTS around it do not. The pane in these runs was
opened with the mouse for exactly that reason.

## How to run it again

`tools/win-typed-probe.sh [user@host]` restarts the app, opens a browser pane
with the mouse, types the address the instant the pane is up, and brings back the
witness log and the captures. It installs nothing: it measures the version that
is on the machine.

## Files

`01-pane-open.png` the pane the moment it appears, `02-typed-address-loaded.png`
the witness page after the typed address, `03-ctrl-l-reaches-nothing.png` the
same pane after `Ctrl+L` and a full address, unchanged. `run-typed-fresh.txt` and
`run-typed-keyboard-then-mouse.txt` are the two probe logs, witness lines
included.

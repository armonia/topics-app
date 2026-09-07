# Topics 2.2.281 on Windows, on the real desktop

The published installer, on the real machine, driven through an interactive
scheduled task and measured in the pixels of its own window. Not a build, not a
headless run: the asset GitHub serves, installed and looked at.

- release `tauri-v2.2.281`, asset `Topics_2.2.281_x64-setup.exe`
- sha256 `88285f27d4cf153863733ca5ac92277a8fec32965785885ae26874e5ce85637a`,
  equal to the digest the release declares. Authenticode: `NotSigned`, which is
  expected here and is why the digest is the only integrity check there is.
- installed version, read back from the machine after the install:
  `DisplayName Topics / DisplayVersion 2.2.281` in the per-user Uninstall key,
  `app.exe` running.
- window measured: 1416x939 px, dpi 96, scale 1, client offset 8,1.
- reproduce: `./tools/win-desktop-check.sh` from this repo.

Screenshots referenced below are in `topics-desktop-2.2.281/` next to this file.

## The five questions

| | question | verdict | measure |
|---|---|---|---|
| a | boot | PASS | client bundle served at 19.0s, window painted at 4.9s (ink 98.7%), budget 45s. Branch: no `external-server-seen` marker, own sidecar started. |
| b | chrome | PASS | 3 command cells (want 3), all inside 16..61 CSS px of the title inset (want 12..66); wordmark ink starts at 80 CSS px (want 80 +/-4); wordmark baseline 2 CSS px off the cells (want <=4). |
| c | shortcuts | PASS (2 of 3), 1 NOT MEASURED | Ctrl+K opened the search over 55.3% of the window and closed back to 0% with one Escape. Ctrl+N opened the "+" menu over 91.7% and dismissed to 0% with one Escape. Ctrl+W (c3) lives after (e) in the run and the gate stops at the first FAIL, so it was not reached: it has no number here, and saying it passed would be inventing one. |
| d | minimise and restore | PASS | 3 cycles, 3 repainted: ink 100% after every restore, diff 0% against the capture taken before minimising. The shell log says why: `rebuild: window painted (77/77 rows with ink), skipped` (the remedy checks first and does not need to fire). |
| e | browser pane | **FAIL** | The pane opens (10.7% of the window changes) and the URL bar accepts the typed address (`http://127.0.0.1:13333/` is legible in the bar in `05-browser-pane-stuck.png`), but the native view never becomes ready: 13s and two navigations later the pane still shows the `browser.native.initializing` spinner. Page ink 98.7% before and after, navigation moved 0% of the pixels. |

Screenshots: `01-first-launch.png` (a), `02-chrome-strip.png` (b, the measured
strip), `03-shortcut-ctrl-k.png` (c), `04-restore-repainted.png` (d),
`04-restore-not-repainted-noremedy.png` (d falsified),
`05-browser-pane-stuck.png` (e).

## Why (e) is the app and not the probe

A shortcut that reads zero on Windows usually means the keys went to the native
WebView2 child window and the client never saw them. So the probe asks a
question it already knows the answer to: with the pane open and focused, it
sends Ctrl+K, which had just been measured at 55.3% on the bare window.

It read **59%**. The keys reach the client with the pane up. The address is in
the bar. What does not happen is the native view coming alive, and that is the
defect. `NativeBrowserPlaceholder` only draws that spinner while
`!browser.ready`, so the client itself is saying the view never spun up.

## The gate can fail

`tools/win-desktop-check.ps1` exits 1 at the first FAIL. Three arms ran before
the green one, so that a zero cannot be mistaken for a gate that always says yes:

| arm | what it changes | expected | got |
|---|---|---|---|
| `wrongkey` | sends an unbound combination in place of Ctrl+K | 1 | 1 (read 0%, want >3%) |
| `noremedy` | relaunches with `TOPICS_NO_WEBVIEW_REBUILD=1`, turning off the cure for the restore defect | 1 | 1 (restore 0/3 repainted, ink 1.3%) |
| `browser` | nothing: (e) alone, on the shipped build | 0 | **1** (the defect above) |
| `full` | nothing: (a)-(d) on the shipped build | 0 | 0 |

`noremedy` is the honest one: it is a real lever on the subject of (d), and with
it off the old grey-webview-after-restore defect comes straight back on this
machine (ink 1.3% against 100%, `04-restore-not-repainted-noremedy.png`). The
fix that shipped is doing work, and this run is the proof on real hardware.

`wrongkey` is weaker on purpose and is described as what it is: it tests that
the measurement can tell an overlay from nothing, not that the shortcut works.

There is no honest arm for (b) and (e): the geometry and the pane both live
inside the shipped bundle, and moving the expectation to make it fail would be
marking my own homework.

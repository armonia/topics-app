# Topics 2.2.292 on Windows: 5/5, and the pane takes a typed address

`./tools/win-desktop-check.sh <host> tauri-v2.2.292` exits **0**. Every check
passes on the real machine, and both falsification arms still fail the way they
must, so the gate is answering rather than agreeing.

Release `tauri-v2.2.292`, asset `Topics_2.2.292_x64-setup.exe`, digest
`sha256:d3b582940a30058bc839ed6e79cea6d98b32b99398be5458591d03abbda9f233`
matching what GitHub declares (not Authenticode signed, so that digest is the
whole integrity check). Installed over 2.2.292 on the same Windows machine as
the 2.2.281, 2.2.287 and 2.2.291 reports.

## The four arms

| arm | expected | got | reading |
|---|---|---|---|
| full (a b c d) | 0 | **0** | boot 19.7s / paint 4.7s · 3 command cells inside 16..69 (want 12..74), wordmark at 88 (want 88), baseline 2 · Ctrl+K opens 52% and closes to 0% on one Escape · Ctrl+N menu 91.8% · restore 3/3 repainted |
| browser (e) | 0 | **0** | two addresses typed by keyboard, the pane went to `http://127.0.0.1:1/` then `http://127.0.0.1:13333/` · Ctrl+K read 53.3% WITH the pane focused · Ctrl+W closed it and left the layout at 0% |
| wrongkey | 1 | 1 | an unbound combination opens 0% of the window, as it must |
| noremedy | 1 | 1 | with `TOPICS_NO_WEBVIEW_REBUILD=1` the restore defect comes straight back: 0/3 repainted, ink 1.3%. The remedy that ships is doing the work |

## What was actually wrong, and it was three different things

**The keyboard of the browser pane (card 4f4954e1) was half fixed.** 71466b7ee
made the pane hand the focus back when it is created, and `browser-pane-2.2.291.md`
proved on the product that an address typed the instant a pane opens loads. What
stayed broken was `Ctrl+L` later: a native pane holds the operating system's
keyboard, and asking for the address bar only opened the tab's inline editor
without asking for the keyboard back — the tab strip did ask, on pointer-down,
which is why the mouse worked and the keyboard did not. Moved into
`focusAddress`, the one door both gestures pass through (b56b22e7f).

**The chrome reading was yesterday's geometry.** The three commands took 4 px of
air on purpose (085c56f23) and the title inset went 66 → 74; the gate held the
old numbers copied by hand, plus two magic thresholds, and counted the window's
own border as a fourth cell. Now every number is derived from
`client/src/lib/shell/windowControlsGeometry.ts` (a3f9dd94d).

**The pane check was measuring pale pixels.** "Did it open" wanted >5% of the
window to change and read 4.8% on a pane that was open and rendering; the two
addresses wanted >5% between them and read 2%, because an error page and the
whole app are both pale and the diff samples luminance. Worse, the old pair
(`/robots.txt` then `/`) painted the SAME app twice: the app served inside its
own pane, Topics inside Topics. The verdict is now the address the pane
publishes to its own store, read from the app (`/api/ui-state/pane-store-v2`):
a port nobody listens on, then the app (fe859d88f).

## Files

`02-chrome-strip-three-cells.png` the strip that reads 16..69 + 88,
`08-first-url-refused-port.png` the pane on the refused port,
`05-second-url-the-app.png` the pane on the app, `run-gate.txt` the whole run,
four arms.

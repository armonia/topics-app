# Topics 2.2.287 on Windows, on the real desktop

Same protocol as `topics-desktop-2.2.281.md`: the published installer, on the
real machine, driven through an interactive scheduled task and measured in the
pixels of its own window. This run answers one question only: does the browser
pane come alive in the FIRST release that contains the `browser_open` fix
(`1b32b4cd6`, moved out of the WebView2 IPC callback)?

The answer is **no**. And a second reading, green on 2.2.281, is red here.

- release `tauri-v2.2.287` (16:56 UTC), asset `Topics_2.2.287_x64-setup.exe`
- the tag contains the fix: `git merge-base --is-ancestor 1b32b4cd6 tauri-v2.2.287`
  answers 0, so this build is the product with the fix in it.
- sha256 `75b17c7500eeb2285359e82eb3d31f637f9e2e0659c09b2cb727e5eb57fe0f1b`,
  equal to the digest the release declares. Authenticode: `NotSigned`.
- installed version read back from the machine: `2.2.287`, `app.exe` running.
- window measured: 1416x939 px, dpi 96, scale 1, client offset 8,1.
- reproduce: `./tools/win-desktop-check.sh <host> tauri-v2.2.287`.
- **the run was done twice**, 19:03 and 19:11 local, and the two answers are the
  same to the decimal: `run-1.txt` and `run-2.txt` in
  `topics-desktop-2.2.287/`. Nothing here is a one-off reading.

## The five questions

| | question | verdict | measure |
|---|---|---|---|
| a | boot | PASS | client bundle served at 18.9-19.6s, window painted at 4.6-4.8s, budget 45s. Same shape as 2.2.281 (19.0s / 4.9s). |
| b | chrome | PASS | 3 command cells (want 3) inside 16..61 CSS px (want 12..66), wordmark ink at 80 CSS px (want 80 +/-4), baseline offset 2 CSS px (want <=4). Identical to 2.2.281. |
| c | shortcuts | **FAIL** | Ctrl+K on the bare window opened **0%** (want >3%), both runs. On 2.2.281 the same key on the same machine read 55.3%. See the note below: it is not the key that changed, it is what happens before it. |
| d | minimise and restore | NOT MEASURED | the gate stops at the first FAIL and (c) is now before (d). The falsification arm still works: with `TOPICS_NO_WEBVIEW_REBUILD=1` the restore defect comes straight back (0/3 repainted, ink 1.3%, `04-restore-not-repainted-noremedy.png`), so the remedy that ships is still doing work. |
| e | browser pane | **FAIL** | The pane opens (11% of the window changes) but nothing ever renders in it: 13s, two `^L` + URL + Enter, and the capture after the second URL is **byte-identical** to the capture taken the moment the pane appeared (md5 equal in both runs). Navigation moved 0% of the pixels (want >5%), page ink 23.4% (want >=30%). |

Captures in `topics-desktop-2.2.287/`: `01-first-launch.png` (a),
`02-chrome-strip.png` (b), `03-shortcut-ctrl-k-nothing.png` (c, the window with
nothing opened on it), `04-restore-not-repainted-noremedy.png` (d falsified),
`05-browser-pane-blank.png` (e).

## What changed on (e) between 2.2.281 and 2.2.287

| | 2.2.281 | 2.2.287 |
|---|---|---|
| pane opens | yes, 10.7% | yes, 11% |
| what the pane shows | the `browser.native.initializing` spinner | a blank area, no spinner |
| window ink with the pane up | 98.7% | 23.4% |
| typed URL visible in the bar | yes (`http://127.0.0.1:13333/`) | no, the bar still reads the new-tab label |
| navigation moves pixels | 0% | 0% |
| Ctrl+K with the pane focused | 59% | 58.9% |

So the symptom moved: the spinner is gone and the window ink collapses from 100%
to 23.4% when the pane opens, which is what a native child window that paints
nothing looks like over the client. The keyboard still reaches the client with
the pane up (58.9%), exactly as on 2.2.281, so this is not the probe typing into
a child window nobody wired. **The pane still does not load a page**, and that is
the product verdict this card was asked for.

Why (e) is not chased further here: the card's scope was the measure on the
product, not the diagnosis. The reading goes to its own card with the logs.

## The (c) regression, and where the keyboard went

In the arm that fails, the run closes the panes the app restored from the last
session first (`Ctrl+W x3: 10.7%, 0%, 0%` - one pane was there) and only then
sends Ctrl+K, which reads 0%. In the `browser` arm, where the three Ctrl+W read
`0%, 0%, 0%` because there was nothing to close, Ctrl+K read 58.9% on the same
build minutes apart. The key works; something about closing a restored pane
leaves the window unable to answer it. Both runs agree.

**The something is the keyboard focus, and the gate now says so.** A third run
of the `full` arm on the same installed 2.2.287, with the focus reading added to
`win-desktop-check.ps1` (card cd040754, `topics-desktop-2.2.287/run-3-focus.txt`):

```
-- Ctrl+W x3 to clear restored panes: 10.7%, 0%, 0.5%
-- keyboard after the closes: NO window (hwndFocus 0x0)
FAIL c1  Ctrl+K: opened 0% (want >3%), ..., keyboard on NO window (hwndFocus 0x0)
```

`GetGUIThreadInfo().hwndFocus` on the foreground window's thread reads `0x0`:
the keyboard belongs to no window at all. On Windows a browser pane is a native
WebView2 child that holds the focus while it lives, and when it dies nothing
hands the focus back, so the client's `window` keydown listeners never fire
again and every shortcut is inert until someone clicks the window. That is why
the reading is 0% on the arm that had a restored pane to close and 55-59% on the
arm that had none: same build, same window, minutes apart.

The shell now hands it back on the explicit close, the twin of what the pane
creation already did (`browser_close_inner`, spec `NATIVEOPS-06`). The two lines
above are the readings this gate will print green: `keyboard after the closes`
should name the client's own child window, not `NO window`. That verification
needs a build with the fix in it, which is the next release; on 2.2.287 the
reading is the diagnosis, not the cure.

## The gate can fail

`tools/win-desktop-check.ps1` exits 1 at the first FAIL, and the arms are run for
that reason:

| arm | what it changes | expected | run 1 | run 2 |
|---|---|---|---|---|
| `wrongkey` | sends an unbound combination in place of Ctrl+K | 1 | 1 | 1 |
| `noremedy` | relaunches with `TOPICS_NO_WEBVIEW_REBUILD=1` | 1 | 1 | 1 |
| `browser` | nothing: (e) alone, on the shipped build | 0 | **1** | **1** |
| `full` | nothing: (a)-(d) on the shipped build | 0 | **1** | **1** |

`./tools/win-desktop-check.sh <host> tauri-v2.2.287` exits non-zero. The bar of
this card (5/5, exit 0) is **not** met on 2.2.287.

# Browser-engine spike — "lightweight Chromium + CDP" measurement

**Goal:** real numbers to validate a lightweight Chromium + Chrome DevTools Protocol (CDP)
substrate for the browser pane (host / follower / server-render modes).

**Env:** macOS 26.2 (25C56), Apple Silicon (arm64), Node v25.9.0, Bun 1.3.8.
Browsers from the Playwright cache (`~/Library/Caches/ms-playwright`, build **1223 = Chrome
for Testing 148.0.7778.96**): full `chromium-1223` and `chromium_headless_shell-1223`.
All scripts are pure CDP; no app/server on :3333 was touched. Reproduce with `./run-all.sh`.

## Engines measured

| key | binary | how it renders |
|---|---|---|
| `headless-shell` | `chrome-headless-shell` (150 MB single binary) | headless-native, the "lightweight Chromium" |
| `chromium-headless` | full `Chrome for Testing.app` + `--headless=new` | full browser, no window |
| `chromium-headful` | full `Chrome for Testing.app` (window on screen) | full browser, real WindowServer window |

## Results

Numbers are **min–max over 2–3 trials** (raw rows in `results.jsonl`). RSS is summed over
the **entire process tree** (`ps rss`, browser + GPU/renderer/network/utility helpers).
Screencast = `Page.startScreencast` jpeg q70 everyNthFrame:1 on a 1280×720 canvas animating
every frame, over 5 s. Input RTT = dispatch → confirmed landed (poll DOM via `Runtime.evaluate`).

| engine / mode | disk | startup→CDP (ms) | RSS blank (MB) | RSS example.com (MB) | RSS wikipedia (MB) | procs | screencast fps | frame KB | screenshot-loop fps | mouse RTT p50/avg (ms) | key RTT p50/avg (ms) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **headless-shell** | **190 MB** (bin 150) | **936–1275** (raw port: **957**) | **245–247** | 258–269 | 353–376 | 4 | 99 | 11.6 | 42–60 | 1.3 / 2.4–4.1 | 0.7–0.8 / 1.4–1.5 |
| chromium-headless (`--headless=new`) | 341 MB | 1077–2378 | 650–710 | 628–727 | 733–838 | 6 | 99 | 11.7 | 32–33 | 1.2–1.4 / 1.8–2.1 | 0.8 / 1.2 |
| chromium-headful | 341 MB | 1047–1172 | 708 | 726 | 832–837 | 6 | 100 | 11.6 | 34 | 1.4 / 1.5 | 0.8 / 1.0 |

Notes:
- **Screencast fps is uniform (~99–100) across all three engines** — it is capped by the
  page's animation/compositor rate, not the engine or CDP. At q70/1280×720 each frame is
  **~11.6 KB**, i.e. **~1.1 MB/s at full 99 fps**. Screencast is *change-driven*: on a static
  page it drops to ~0 fps/0 bytes, so live-mirror bandwidth scales with actual visual change.
- **`Page.startScreencast` beats a `Page.captureScreenshot` loop by ~2–3×** (99 fps push vs
  32–60 fps serial pull) and is far lighter on CPU — it is the right primitive for live panes.
- **Input RTT is sub-5 ms average, ~1 ms p50** on every engine. The measured time is
  dominated by the CDP round-trip + the JS read-back poll, not the input path; real input
  latency is effectively free.
- RSS is not perfectly monotonic (GC + warm start-page allocations make `example.com`
  occasionally read below `blank` on the full build) — read the columns as steady-state bands.

## Transport finding (important for architecture)

The **full Chrome-for-Testing build never binds a TCP `--remote-debugging-port`** in this env.
Launched directly with `--remote-debugging-port=<n> --user-data-dir=…` it spins up its helper
processes (~100 MB) but **never writes `DevToolsActivePort` and never answers `/json/version`** —
verified across `--headless=new`, `--headless=old`, headful, and `--no-sandbox` (all time out,
empty stderr). **`chrome-headless-shell` binds the TCP port in <1 s** every time.

Consequently the full/headful engines here were driven over Playwright's **pipe transport**
(`launchServer` + `newCDPSession`); `headless-shell` was additionally driven over a plain
`--remote-debugging-port` WebSocket (`footprint.mjs`/`screencast.mjs`/`input.mjs`) to prove the
no-dependency path. **Takeaway:** if you want dependency-free `--remote-debugging-port` + raw WS
CDP, `headless-shell` is the reliable target; driving the full/headful build wants a
pipe-transport CDP client (or Playwright).

## Conclusions

- **Lightweight-Chromium + CDP is a solid substrate.** `chrome-headless-shell` cold-starts to
  CDP-ready in **~1 s**, idles at **~250 MB** RAM, and drives screencast at the **full ~99 fps /
  ~1 MB/s** compositor ceiling with **~1 ms input round-trips** — all over a plain
  `--remote-debugging-port` WebSocket, no framework required.
- **headless-shell is ~2.6–2.9× lighter in RAM than the full build** (~250 MB vs ~670–710 MB
  blank; ~365 vs ~780–835 MB on Wikipedia) and **~1.8× smaller on disk** (190 vs 341 MB), with
  **identical** screencast throughput/latency and input latency. For pure render/mirror work you
  pay a large RAM/disk premium for the full build and get nothing back on these metrics.
- **Mode fit:**
  - **server / follower render nodes → `headless-shell`.** Cheapest RAM, fastest port-CDP,
    same fps/latency; you can pack ~4× as many instances per host as the full build. It has no
    window and no extension support, which is exactly right for a headless render/mirror farm.
  - **host (the human's own window) → full `chromium-headful`.** You need a real on-screen
    window (and, if ever required, extensions/DRM/widevine) — headless-shell can't provide it.
    Cost is ~700 MB and it must be driven over the pipe transport, not a TCP port, in this env.
  - **`chromium-headless=new` is the awkward middle:** essentially full-browser RAM (~670 MB,
    ~= headful) but no window — only worth it when you specifically need a full-Chromium feature
    (extensions, certain codecs) without a visible window. For plain mirroring it's strictly
    worse than headless-shell.
- **Live-pane transport:** prefer `Page.startScreencast` (push, change-driven, ~2–3× a
  screenshot loop, ~1.1 MB/s worst-case at 1280×720 q70) over a `captureScreenshot` poll.
- **One caveat to design around:** the full build's refusal to open a TCP debug port on
  macOS 26. Standardize the CDP client on **pipe transport** (works for shell *and* full) if the
  substrate must drive both, or keep raw-port CDP scoped to `headless-shell`.

## Files

- `lib/cdp.mjs` — minimal CDP-over-WebSocket client, launch helper, process-tree RSS.
- `footprint.mjs` / `screencast.mjs` / `input.mjs` — raw `--remote-debugging-port` measurements (headless-shell).
- `pw-bench.mjs` — unified per-engine benchmark via Playwright launcher + CDP session (all engines).
- `assets/anim.html` — full-frame per-frame animation used for screencast.
- `run-all.sh` — reproduce everything. `results.jsonl` — raw output rows.

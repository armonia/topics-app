# The performance map: what has a number and what does not

Updated **2026-08-19**. It serves one purpose: to know WHERE a performance
regression would be seen and where it would pass in silence. It is not a list of
good intentions. Every row names the command that exits non-zero, or says that
there is none.

> **Status note, 2026-08-14.** Shard 1/4 of the E2E suite has 7 reds on `main`
> that have nothing to do with performance: `board-diff-review`,
> `board-land-conflict`, `board-preview-cap`, `board-recapture-preview` (x2),
> `board-reopened-chip`, `chat-fast-mode`. Verified on a clean worktree at
> `71c52934`, same list, same failures, so they were already there. Three are
> copy text that no longer matches, one is geometric, three wait for an element
> that never appears. Re-run after every change on this page: the same 234
> passed and the same 7 failed, so nothing here added a red.

The rule that governs everything else: **an adjective cannot fail.** "Fluid",
"fast", "light" never finish, because there is nothing that can say no to them.
A number with a threshold can. That is why this page counts gates, not
intentions.

## What is measured, and by whom

| Surface | What it measures | Command | In CI |
|---|---|---|---|
| Transcript scrolling | dropped frames, worst gap, long tasks | `bun run check:scroll-fluidity` | yes (`\|\| test $? -eq 2`) |
| Latency of 4 hot routes | median ms on a fixed corpus, ratchet | `bun run check:route-latency` | yes (`\|\| test $? -eq 2`) |
| Bundle weight | bytes of entry / critical path / total assets | `bun run check:bundle` | yes |
| Click to ink | ms from the gesture to the first painted frame | `bun run check:ink` | yes (since 2026-08-14) |
| Weight of a chat payload | anti-duplication invariant plus bytes per message | `bun test tests/integration/history-payload-weight.test.ts` | yes (`bun test:unit`) |
| Idle frames | how many frames are requested when nothing happens | `tests/e2e/idle-frame-budget.spec.ts` | yes (E2E shard) |
| Shift on refresh (CLS) | layout shift after a reload | `tests/e2e/refresh-cls.spec.ts` | yes (E2E shard) |
| Pane residency cap | how many panes stay mounted | `tests/e2e/pane-residency-cap.spec.ts` | yes (E2E shard) |
| Transcript eviction | how many chats stay hydrated | `tests/e2e/chat-transcript-residency.spec.ts` | yes (E2E shard) |
| Browser pane streaming | fps, p95 input latency, bandwidth, first frame | `tests/e2e/browser-ws-streaming.spec.ts` plus `perf-baseline.json` | yes (E2E shard) |
| Writes at rest | API writes an IDLE window sends in 30s | `node scripts/check-idle-writes.mjs` | not yet |
| Dropped frames under gesture | % of frames dropped while scrolling, median of 5 runs | `node scripts/check-frames.mjs` | not yet |
| Compositor layer growth | `owned unmapped (graphics)` regions per minute on the REAL window | `bun run scripts/layer-growth.ts` | no (needs a live window) |
| Cost of a window | footprint of a freshly-opened window vs one that has lived | `node scripts/window-cost.mjs` | no (diagnostic) |

## 2026-08-19: what "1.8 GB and 57 fps" actually was

A day of measurements against the user's own window, kept because the three
answers were each different from the complaint that produced them.

**"57 fps" was the panel.** `lib/fpsMonitor` counts delivered
`requestAnimationFrame`s, which on a still page measures itself: the browser has
nothing to compose and delivers when it likes, correctly. The measured frame
interval here is 17-21 ms, i.e. **48-59 Hz** — so 57 was the ceiling, not a
loss. The question that pays is how many frames DROP during a gesture:
median **1.7%** over five runs (min 1.1, max 4.7) while scrolling.

That number took three attempts to become trustworthy, which is the part worth
keeping. The first version measured even when it found no scroll container — a
still page judged by a gesture's threshold — and gave 0.6% then 13.2% with the
app unchanged. The second still swung 13.9 / 1.7 / 7.1 / 1.7 / 2.9 across three
minutes on a machine carrying 8.6 GB of swap and other agents. One run would
have licensed both "fine" and "severe regression". Five runs and the MEDIAN
decide; the spread stays printed, because when it is wide this machine is not a
place to judge smoothness, and knowing that beats a coin-flip verdict.

**A still window was writing 75 KB per second, forever.** No gesture, no agent:
16 PUTs of `pane-store-v2` in 25 seconds, one every 1.15 s, the only difference
between one body and the next being `lastSeq` (+2). Three reasonable links
closing into a loop: `UPDATE_PANE` merged `{...pane, ...updates}` without
comparing, so it produced a fresh object at identical values; the dispatcher
bumps `lastSeq` on every dispatch; the sync middleware watches `lastSeq`.

It was not bandwidth. This server is Bun with SYNCHRONOUS `bun:sqlite`, so every
PUT is a stalled event loop for everyone, and on **HTTP/1.1** it occupies one of
the SIX connections a browser grants per host — i.e. it queues ahead of the
reads that draw the board. Measured with `scripts/hol-probe.mjs`: with 12 heavy
requests in flight, a **212-byte** request waited **19.3 seconds**. That queue,
not any single slow route, is what made a refresh feel slow.

| | before | after |
|---|---|---|
| first board card after reload | 7,176 ms | **464 ms** |
| API requests at boot | 97 | 92 |
| bytes downloaded at boot | 9.35 MB | 6.61 MB |
| reads of the 1.2 MB feed | 4 | 2 |
| PUTs while idle (25s) | 16 | 1 |
| writes at rest (45s) | — | **0** |

**The memory is not a leak, and it is not in the heap.** A freshly-opened window
costs **164-187 MB**; the user's was at **1,633 MB**. But `devHeapProbe`, armed
on the real window, measured a perfectly FLAT DOM (1,864 nodes, 209 `<svg>`,
unchanged sample after sample) under a megabyte declared, and `mem-growth.ts`
measured a FLAT curve (1,412 → 1,446 MB over nine idle minutes). The bytes are
in **`owned unmapped (graphics)`** — the IOSurface backing of CoreAnimation
layers, invisible to any probe written in JavaScript: 3,127 regions at 13:41,
5,585 at 14:49, 6,120 at 15:17, with **1.2 GB of it swapped out**.

Two honest caveats, both of which change what to do next. Watched for eight
minutes the count does NOT climb monotonically — 6,120 → 5,518 → 5,666, so
WebKit does recycle backings and "unstoppable leak" would have been the wrong
conclusion to draw from two data points. And the machine itself was at 12.6 GB
of swap with Dia holding 1,075 MB and Spotify 921: part of the number the status
bar reports is system pressure, not live Topics memory. What stays true is that
the footprint never comes back down (1,638 → 1,741 MB in that same window), and
that a window nobody touches should not cost ten times a fresh one.

**And a fresh window, watched properly, does not leak.** Once the probe stopped
lying — the first version wrapped `window.WebSocket`, which broke the app's boot
and reported 27 nodes and a flat 0 MB, a FALSE green that would have closed the
investigation on nothing — five minutes of a live, idle window read:

| | t+1m | t+2m | t+3m | t+4m | t+5m |
|---|---|---|---|---|---|
| footprint | 205 MB | 213 MB | 221 MB | 200 MB | 205 MB |
| DOM nodes | 1,844 | 1,858 | 1,858 | 1,858 | 1,858 |
| listeners | 1,477 | 1,471 | 1,471 | 1,471 | 1,471 |
| intervals | 14 | 14 | 14 | 14 | 14 |

Nodes, listeners and timers all FLAT; the footprint oscillates within 21 MB and
comes back down. **+2 MB over five minutes.** So there is no runaway in a fresh
window: what separates 205 MB from the user's 1.5 GB is sixteen hours of real
use — panes opened and closed, chats hydrated, browser panes navigated — and
memory the allocator never returns to the OS.

That reframes the remaining work, and it is worth being precise about it,
because "find the leak" would now be chasing something these measurements say
is not there. The open questions are (a) which surfaces allocate proportionally
to a session's HISTORY rather than to what is on screen, and (b) whether the
shell should ever recycle a content process that has lived a working day. Both
are answered by measuring a window through real use — not by staring at an idle
one, which is now known to be quiet.

## What is NOT measured

Uncovered ground as of 2026-08-14. None of these rows has a command that exits
non-zero when it gets worse.

1. **Cold start.** How many milliseconds pass between launch and the first
   usable screen. No probe, no threshold.
2. **Memory.** Neither the server nor the shell has an RSS ceiling. Still a
   number, not a budget, because nobody compares it against anything — but the
   number moved, so here it is again, measured 2026-08-18 on a 12-core Mac:

   | state | server RSS | shell |
   |---|---|---|
   | idle, 1014 topics, 2262 tasks | 466 MB | 54 MB |
   | **5 board agents working at once** | 510-716 MB (six samples, 12s apart) | 54 MB |

   The marginal cost of a concurrent agent is therefore roughly **50-100 MB**,
   because they share one process and one runtime. A single Claude Code CLI on
   the same machine, measured at the same moment: **263 MB and 297 MB**. Five of
   those would be 1.3-1.5 GB *plus* a server, against 0.5-0.7 GB total here.

   That is the "light without a CLI" claim with numbers on it, and it is also
   why the claim needs a gate: nothing fails when the marginal cost doubles. The
   idle 466 MB is itself worth a threshold one day — it is mostly the 675 MB
   SQLite file's page cache and 1014 topics of bookkeeping.
3. **The WebSocket bootstrap.** Compressed toward remote peers as of
   2026-08-14, but still ungated: nothing fails when it grows. 176.7 KB on
   connect before the fix, of which `ui-state:init` 84.5 KB (the `pane-store-v2`
   key alone is 65.8 KB) and `unread:init` 79.8 KB across 843 topics, 517 of
   them just to say "zero unread". Those 517 rows and the `lastReadAt` field
   that no client ever reads are still on the wire; compression now hides most
   of their cost, it does not remove them.
4. **The terminals.** No measurement of what a line arriving from the PTY costs,
   nor of how much redraw an idle pane burns.
5. **Search and dashboard.** No latency declared.
6. **The weight of the database.** 651 MB today, 634 of them in the `messages`
   table: `blocks` 353 MB and `tool_calls` 220 MB against 13 MB of message text.
   No gate watches how much it grows, nor what reading one row costs.
7. **The number of refetches per event.** The board feed was fixed on
   2026-08-14 (see below), but nothing stops the next surface from reading N
   times for N events: the rule lives in a module, not in a gate.

## Today's measurements (2026-08-14)

Taken against this machine's production server, real database, TLS over
loopback. They serve as the reference: a number without a date and without a
bench is not a measurement.

### Opening a chat, topic 6b99e9cf, 118 messages, 1,167 tool calls

| | bytes on the wire | |
|---|---|---|
| before | 8,207,127 | |
| after dropping the duplicate | 5,419,622 | -34% |
| after, toward the LAN (gzip) | 1,425,963 | -83% overall |

The duplicate was `toolCall.result`, byte-identical to
`detail.output` / `detail.content` on 1,015 of the 1,167 tool calls. A
`JSON.parse` of that payload costs 16.5 ms before and 10.5 ms after: **the
bottleneck is not the parse, it is the transfer**, which is why compression is
what counts and the rest is margin.

### The route that serves the agents, `/api/topics/:id/messages`

| | bytes |
|---|---|
| `?limit=200` before | 12,544,630 |
| `?limit=200` after | 5,416,000 |
| `?limit=30` (what `read_chat` calls) before | 1,540,794 |
| `?limit=30` after | 715,570 |

The client does not call it: the MCP server does, and then keeps 4,000
characters per message and throws the rest away.

### The board feed, `/api/all-boards/tasks`

467 tasks, 1,435,735 bytes, 175 ms. Toward the LAN, compressed: 347,328 bytes
(4.1x). 449 of the 467 tasks are `done`; `description` alone weighs 486 KB, and
the card shows two lines of it with `line-clamp-2`.

Until 2026-08-14 it was re-read on EVERY `task:*` event: the busiest minute of
the last three days holds 24 of them, that is 34.6 MB and 24 repaints to arrive
at one state. A burst now costs two reads
(`client/src/lib/burstCoalescer.ts`).

### Other routes, for comparison

| route | bytes | ms | toward the LAN (gzip) |
|---|---|---|---|
| `/api/topics` | 693,182 | 16 | 103,947 (6.7x) |
| `/api/notifications` | 22,289 | 4 | |
| `/api/projects` | 3,666 | 4 | |
| `/api/system/dispatch-capacity` | 212 | 4 | |

### Startup, as it stands today

None of these numbers is a defect: they are the starting point for whoever wants
to touch startup, and they exist so that nobody has to do it by feel.

**`/api/topics` carries 977 topics, 967 of them ARCHIVED.** "Open" means not
archived, so the sidebar draws ten of them and receives nine hundred and seventy
more. Two things were checked before writing this down, and both raise the price
of the obvious fix:

· The route takes **no filter at all**: `GET /api/topics` returns the whole map
  (server/routes/topics.ts:913). And the archived ones are not dead weight to
  the client either, because the sidebar has a `showArchived` toggle that renders
  them (`TopicTree.tsx:297`). Dropping them from the boot response means
  building the on-demand fetch that toggle would then need.
· The heaviest field is `systemPrompt`: **150 KB out of 712**, populated on 663
  topics, and only two surfaces read it, the chat's empty state
  (`ChatEmptyState.tsx:73`) and the settings window (`TopicSettingsModal.tsx`),
  always and only for the OPEN topic. But there is **no `GET /api/topics/:id`**
  to fall back on: the only per-topic verb is PATCH
  (server/routes/topics.ts:1309). So that fix is not "stop sending a field", it
  is "add a route and two call sites".

Which is why this page carries the numbers and not the patch.

**The WebSocket bootstrap carried 176.7 KB uncompressed** until 2026-08-14.
`Bun.serve` has `perMessageDeflate` off by default, and turning it on is not
enough on its own: measured with a byte counting proxy on Bun 1.3.8,
`ws.send(x)` still went out at 44,667 B for a 44,395 B payload, and only
`ws.send(x, true)` brought it to 5,423 B. The option negotiates the extension,
the per send flag decides one frame at a time.

Now the flag comes from `shouldCompressFrame`
(`server/lib/ws-compression.ts`), which answers the same question as the HTTP
side, "is there a network in between", plus two rules that keep the other two
sockets safe: nothing under one MTU is compressed, which is what keeps every
keystroke of a terminal off the compressor (a keystroke echo is 1 B, a cursor
move 7 B, a line of output 73 B), and a screencast frame is never compressed at
any size, because it is base64 of an already compressed JPEG (measured: 1.41x for
1.49 ms per frame per viewer, which at 20 fps is 30 ms of CPU per second).

Proven on the wire with a throwaway server wired exactly like `server.ts`: a
36,503 B bootstrap frame goes out as **2,620 B toward a LAN peer** and stays at
36,507 B toward loopback.

The terminal socket is wired too, and it is where the biggest single ratio on
this server lives: 1,927 B of full screen redraw gzip to 41 B (47x). Its two
sends that matter are the live PTY stream and the scrollback flush on focus; the
size rule is what keeps every keystroke off the compressor, with no per socket
exception.

Still not wired: the browser socket. Its screencast frames must stay raw
whatever happens (the rule already says so), and its other messages
(`dom_event`, `console`, `nav`) are JSON that would follow the size rule. Left
alone for now because the live view path is the one place where a wrong call
costs frames rather than bytes.

## The route ratchet measures the disk, and its baseline knows only one disk

Measured on the GitHub runner, 2026-08-14, with the pipe healthy (so the numbers
are comparable by the gate's own rule):

| route | measured | ceiling | verdict | bound by |
|---|---|---|---|---|
| `topics` | 0.85 ms | 1.86 | inside | CPU |
| `dispatch_capacity` | 0.86 ms | 1.68 | inside | CPU |
| `topic_messages` | 7.92 ms | 5.41 | **outside** | SQLite, 3,000 messages |
| `all_boards_tasks` | 11.24 ms | 2.25 | **outside** | SQLite, 150 tasks |

The two CPU-bound routes are inside, the two disk-bound ones are out by 1.5x and
5x. That is the signature of slower storage, not of a regression: nothing in
`server/routes/tasks.ts`, `server/services/tasks.ts` or `shared/board.ts` changed
in the 40 commits since the baseline was recorded, and the same overrun
reproduces on a tree from BEFORE any of that day's work.

`scripts/route-latency-baseline.json` was recorded on an Apple Silicon SSD, and it is the
only baseline there is. So the ratchet currently answers "is this machine as fast
as the one that recorded the baseline", which on any other machine is not the
question anyone wanted asked.

The calibration guard added the same day catches a slow machine only when the
CPU is the slow part: its witness is `dispatch_capacity`, which does no I/O. A
fast CPU with a slow disk walks straight past it. Two honest ways out, neither
taken yet:

1. a second baseline recorded on the runner, chosen by environment;
2. an I/O witness next to the CPU one, so the gate can say "this disk is N times
   slower than the baseline's" and exit 2 instead of blaming a route.

## The gate that existed but never ran, and the red that was not a defect

`bun run check:ink` was invoked by no workflow. The spec ran inside the E2E
shards and **measured**, but the comparison against `tests/e2e/ink-budget.json`
is done only by `scripts/check-ink-latency.ts`, which did not appear in CI. A
budget nobody executes is not a gate.

Run by hand on 2026-08-14 it came out red, and the red held across four
independent runs: "switch tab" with one sample at **353.6 / 355.4 / 356.8 /
359.7 ms** against a 250 ms ceiling, while the other four samples of the same run
sat between 6 and 15 ms. Six milliseconds of spread across four runs is not
scheduling noise: it is a constant.

Probed rather than assumed. The message is **in the DOM at +39 ms** and
**painted at +357 ms**, with **zero long tasks** and every network request
answered within 8 ms. Nothing computes in between: it is `MessageList.tsx`
holding the list at `visibility: hidden` behind a skeleton for at least
`LIST_REVEAL_FLOOR_MS` (320 ms), so that nobody watches react-virtuoso measure
heights and re-anchor, a reflow worth a CLS of 0.296 on its own
(`refresh-cls.spec.ts`).

So it was not a defect: it was **a different gesture inside the measurement of
another one**. "Opening a chat never opened before" costs 355 ms by declared
choice; "switching between two open chats" costs 13. The spec now warms up BOTH
panes before measuring, the same decision this file had already taken for `send`,
and the excluded cost is written in `ink-budget.json` under `excluded`, with the
reason and with the constant that governs it.

After the fix: `switch tab` median 13 ms, max 14.3. The gate did not go blind:
with `bun run check:ink --stall 300` all three gestures fail. It is now in CI.

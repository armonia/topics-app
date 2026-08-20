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
| Writes at rest | API writes an IDLE window sends in 30s (after a 20s settle) | `node scripts/check-idle-writes.mjs` | not yet — **`pane-store-v2` cycle CLOSED (27→0); a SECOND channel still spikes, see below** |
| Dropped frames under gesture | % of frames dropped while scrolling, median of 5 runs | `node scripts/check-frames.mjs` | not yet |
| Compositor layer growth | `owned unmapped (graphics)` regions per minute on the REAL window | `bun run scripts/layer-growth.ts` | no (needs a live window) |
| Cost of a window | footprint of a freshly-opened window vs one that has lived | `node scripts/window-cost.mjs` | no (diagnostic) |
| **Boot memory peak** | `phys_footprint (peak)` of a FRESH server booted on a copy of the real DB | `bun run probe:boot-memory` | not yet — new 2026-08-19 |
| **What the memory panel SAYS** | that the headline number is explained when most of it is swapped, and that the advice matches the case | `tests/e2e/perf-panel.spec.ts` | yes — its 4 cases land in shard 3 of the real planner (verified, not assumed) |

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

**The fix is one line in the reducer, and the second half was withdrawn.** The
first attempt paired the reducer guard with a gate in the sync middleware:
"don't PUT a snapshot identical to the last one the server accepted". It passed
its unit tests and broke tab closing — `pane-undo.spec.ts` went red on
"closedStack must have at least one entry after CLOSE_PANE". Built at the
previous commit in a throwaway worktree, the same test passes: so the red was
mine, and without that check it would have been filed as noise.

The reason is worth keeping. This middleware is NOT the only writer of the row:
`flushPaneStoreNow` (closing a browser pane), the teardown flushes, and every
hydrate from the server touch the same state on their own schedule. A memory of
"what the server has", kept by one of those paths, ends up speaking for all of
them, and the next PUT gets skipped for resembling a body that was not its own.
Three patches moved the defect without removing it, at which point the question
stopped being "how do I fix this" and became "is it needed": measured without
it, **0-2 writes at rest in 30s** against 26 with the defect. At that moment the
answer was no — the cause looked upstream and already fixed.

That reading was right about the FIRST cause and wrong about the channel being
clean. Hours later the same gate read 12-17 writes again, from a second cause
(peer hydrates bumping `lastSeq`) that the first fix had been masking. So the
withdrawal above still stands on its own merits — that gate broke a tab close,
and a gate that trades a working write for saved bandwidth is a bad trade
whatever else is true — but "nothing to filter" was too strong. There was
something to filter; it just could not be filtered from there without cost.

| | before | after | holds? |
|---|---|---|---|
| first board card after reload | 7,176 ms | **402-473 ms** | yes, when the machine is idle |
| API requests at boot | 97 | 82-96 | roughly |
| bytes downloaded at boot | 9.35 MB | 5.4-8.0 MB | roughly |
| reads of the 1.2 MB feed | 4 | 2-4 | load-sensitive |
| writes at rest (30s) | 26 | 0, then **12-17 again** | **NO — see below** |

**The writes row went back up, and leaving it at "0" would have been the worst
kind of stale.** Fixing `UPDATE_PANE` really did take a still window from 26
writes to 0, measured repeatedly over an hour. Hours later the same gate reads
12-17 again: a SECOND cause, in the same channel, that the first fix had been
masking. Both are real; only the first is fixed. The row now says so, because
this table is what the next person reads before deciding where to look.

**The bottom three rows are load-sensitive, and that is worth stating.** The
464 ms was measured on a quiet machine; re-measured hours later at load 114-221
the same probe read 6,200-8,400 ms with no relevant code change, and the feed
read 3-4 times instead of 2. Checked rather than assumed: `event-loop-lag.ts`
found the SERVER healthy at that same moment (median 3.3 ms, no stall over half
a second) and the feed's bytes reached the client at 1,809 ms while the card
appeared at 8,375 — so the time went into the renderer's main thread, which on
a contended CPU cannot keep up.

Once the machine came back down (load 10-18), four consecutive runs read
**402 / 417 / 453 / 473 ms**. The improvement was real all along; the 6-8 s
readings were the artefact, which is exactly what `boot-audit.mjs` now says out
loud — it prints the load beside the number and warns when it is describing the
machine rather than the app.

The multiple feed reads are likewise independent coalescers firing at boot
(there are seven `createCoalescedReader` call sites), not a loop: each has a
400 ms window, and a slow machine spreads their triggers further apart than the
window.

**The rows that hold at any load are the first two**, which is why they are the
ones with a gate.

**The idle-write cycle is NOT fully closed, and the gate says so.** Fixing
`UPDATE_PANE` took a still window from 26 writes per 30s to 0, measured
repeatedly. Hours later the same gate reads **12-17 writes in 25s** again, same
signature: `pane-store-v2`, one every ~1.5s, only `lastSeq` differing between
one body and the next.

What is already ruled out, measured rather than reasoned: it is not
`UPDATE_PANE` (guard added, cycle stayed), not `FOCUS_PANE` (guard added, cycle
stayed), and **not any action at all** — instrumenting the dispatcher to count
actions by type recorded **zero** in the same window that saw fifteen PUTs. The
PUTs do leave this window (counted on its own `fetch`), so they are not someone
else's writes seen in passing.

Half the cause is known; the other half is not, and the wrong answer is worth
recording too. Instrumenting the dispatcher — with the probe placed BEFORE the
`return` that skips server-authoritative actions, which is why the first attempt
reported "zero actions" and sent me down two wrong paths — recorded **16
`HYDRATE_FROM_SNAPSHOT` for 15 PUTs**. The mechanism follows: a hydrate sets
`lastSeq` to `max(currentSeq, server_seq)` (`reducers/panes.ts:760`), the sync
middleware watches `lastSeq`, and half a second later it PUTs 75 KB identical to
what it just received.

**It is the peers — and the detour to get there is the lesson.** The hypothesis
("21 open sessions, every write raising everyone's `server_seq`") makes a
checkable prediction: each PUT should follow an inbound `ui-state:*` frame.
Measured from Playwright's `page.on('websocket')`: **zero** frames in 25 seconds
against fifteen PUTs. That looked like a clean refutation, and the diagnosis was
rewritten as "cause unknown".

The probe was blind. Re-measured INSIDE the page, wrapping `WebSocket` in a
Proxy: **29 frames in 20 seconds, 24 of them `ui-state:updated` on
`pane-store-v2`**, carrying TWO distinct `sourceClientId`s, twelve each — two
clients writing at each other. Reading the minified bundle at the exact
stack offset confirmed the dispatcher: the `ui-state:updated` branch of
`syncWS.ts`.

A probe that reads zero proves nothing until it has been asked whether it can
see anything at all. This one counted zero frames TOTAL, which should have been
the tell: an app that talks to its server over a WebSocket does not receive
none.

**It takes TWO windows.** The correlation is exact: 12 PUTs sent, 24
`ui-state:updated` frames received, 2 distinct writer ids — each of our writes
comes back as a frame, and the peer's does too. The second client here was the
user's own Topics app, open alongside the probe window. So a single window does
not spin; the cycle is a property of two clients sharing one `server_seq`
counter, which is also why it hid for so long: every measurement that found "0
writes at rest" was taken with one window open.

That reframes the fix, too. The gate that was withdrawn tried to stop the SEND;
the cheaper question is why a peer's write has to advance *our* local dispatch
counter at all (`reducers/panes.ts:760`). Answering that is where the next
attempt should start.

**A remedy that works was written and withdrawn.** Comparing the outbound
snapshot against the identity of the last HYDRATED state takes the gate to
**0 writes, three runs in a row**. It also breaks `cross-window-topic-sync`:
open a chat, reload, and it is no longer open. Verified the red was mine by
disabling that single line — the test goes green.

It stays withdrawn because the trade is bad in the direction that matters: the
gain is bandwidth and some event loop, the cost is state that does not
synchronise, i.e. work lost on screen. The same lesson was already paid today by
a different gate that made a tab close vanish before reaching the server.

Where to resume: not in the middleware but at `syncWS.ts`, on the line that
folds a peer's `server_seq` into our local dispatch counter. That is what turns
someone else's write into our own, and until it changes every downstream gate is
patching a symptom. The hooks (`alreadyOnServer`, `noteLocalWrite`) stay
published with their reasoning for whoever picks it up.

**The SERVER half of "1.8 GB" is closed, and it was two defects, not one.**
Measured the same evening on the production server after five hours of uptime:
`phys_footprint` **936 MB**, historic peak **2.4 GB** — against a declared JS
heap of **52 MB** and an RSS of **110 MB**. So the number never described live
memory, which is why "find the leak" would have been the wrong hunt.

| | before | after | how it was measured |
|---|---|---|---|
| server at rest | 936 MB | **119-135 MB** | `vmmap -summary`, three minutes |
| server boot peak | 2.6 GB | **353-362 MB** | fresh server, copy of the real DB |

*The pages of past peaks, never given back.* Swapped out by the system and
still charged to the app by `phys_footprint` — i.e. by the exact column the
status bar and Activity Monitor show. `Bun.gc(true)` does dissolve them, which
is the non-obvious part and is why it was measured rather than assumed:

    allocated 960 MB   → footprint 968.8 MB   RSS 985 MB
    25s idle           → footprint 969.0 MB   RSS  22 MB   ← swapped
    after Bun.gc(true) → footprint   8.7 MB   RSS  22 MB   ← returned

The middle row is the one that matters: the footprint does NOT come down on its
own once the system has swapped. It only comes down when something collects.
Wired at rest only (`server/lib/idle-gc.ts`), behind the same three-source
predicate as the planned restart: `Bun.gc(true)` is synchronous and this server
has synchronous `bun:sqlite`, so the pause is everyone's.

*The peak itself, all of it inside the first eighteen seconds of boot.*
`finalizeOrphanedRunningTools()` looked for tools left "running" with an
`.all()` over thirty days of `messages`: **8,354 rows for 706 MB** of content +
tool_calls + blocks, all materialised before one was inspected, and `decodeCol`
doubles that by decompressing each zstd blob into a string. The rows it needed
were **four**. With `iterate()` the peak is proportional to what is FOUND, not
to the database. Verified against the real DB before touching the code: both
paths return the same 4 ids.

`bun run probe:boot-memory` now guards it, and the guard was proven able to say
no: **353 MB green** with the fix, **801 MB red (exit 1)** with the `.all()`
put back. That check is the reason this row will not silently regress — every
functional test passes either way, because the defect never got an answer
wrong, it just paid too much for it.

*The database, 888 MB of which 778 in `blocks` + `tool_calls` against 19 MB of
message text.* Not old rot to prune — 648 of those MB are from THIS month. The
waste is elsewhere and simpler: `shared/message-blob.ts` compresses those two
columns with zstd, every reader already goes through `decodeCol` (checked: all
five files that SELECT them), but the codec acts on WRITE, so it only ever
touched rows written after it existed:

    blocks      273 rows compressed (4 MB)  ·  4,131 plaintext (481 MB)
    tool_calls  291 rows compressed (4 MB)  ·  8,762 plaintext (288 MB)

`bun run db:compress` backfills them, and on 2026-08-20 it was **run on the
production database**, not just measured: **849 MB → 213 MB on disk**, WAL
reabsorbed. 776.9 MB of plaintext became 151.9 (5.11x); the `VACUUM` took 4
seconds.

Every row is read back before it is replaced, and the result was verified
against an atomic `.backup` taken first: **18,902 rows × 8 columns = 151,216
comparisons, zero differences**, `PRAGMA integrity_check` = ok, and the row
counts of `topics` / `tasks` / `ui_state` / `messages` unchanged. Then the part
that actually matters — the app still works: `/api/topics`, `/api/all-boards/tasks`
and `/api/system/presence` all 200, and a chat whose `tool_calls` are now zstd
blobs still delivers **250 decoded tool blocks** through the API. The codec is
transparent to every reader, which is what made the backfill safe in the first
place.

That verification is also where a lesson sits. The first run compared a `cp` of
a live database and found TWO differences — real ones: a row the server was
rewriting mid-copy. A `cp` of a SQLite file in use is not a snapshot, and
treating it as one would have filed that noise as data loss, or (worse) real
loss as noise. The rerun used `.backup`.

The script does NOT touch production on its own and says so: it is a `db:*`
command, not a migration, because a `server/db/migrations/*.sql` file gets
applied to the LIVE database by the watcher within seconds — which is not where
a 13,000-row rewrite belongs.

Still open on the server side: the steady state has no budget (only the boot
peak does).

**The idle-write cycle is CLOSED — and it took closing a second defect first.**
`check:idle-writes` on main: **27 writes in 30s → 0**. Two commits, and the
order is the whole story.

*The cycle itself.* `lastSeq` rises on `HYDRATE_FROM_SNAPSHOT` too (the reducer
takes it to `max(lastSeq, clean.lastSeq)` so later PUTs stay fresh), and the
sync middleware used it as its wake-up. So a PEER's frame woke us, and half a
second later we re-sent 75 KB identical to what we had just received; that PUT
bumped `server_seq`, the server rebroadcast, and the peer did the same. A third
counter — `localSeq`, raised ONLY by a local change — moves the question from
"did the counter move" to "did WE move". It filters nothing outbound, which is
what separates it from the two gates withdrawn before it.

*Why it could not land alone.* With the cycle removed, `pane-undo.spec.ts` went
red — and the red was real, not collateral. Probed on both sides: the PUT
carrying the close returns **200** and is the LAST write to reach the server, yet
the row reads back `closed=0`. A direct PUT (no browser in the loop) proved the
server keeps `closedStack` fine, so the loss was downstream of it:

    the user closes a chat tab
      → the reducer creates the undo record and PUTs it
      → the retirement cascade archives that topic ("tab-close")
      → `archiveTopicFully` calls `purgeTopicFromUiState`
      → the freshly-created record is FILTERED OUT

And the tombstone did not replace it: that block reads `removedPaneIds`, i.e.
panes removed from `panes`, and an already-closed pane is no longer there. So a
close left **no trace at all** — neither record nor marker.

`pane-undo` had been seeing this all along and stayed green, because the write
cycle re-sent the state a moment later and put the record back. One defect was
propping up another: removing the cycle exposed it. That is why the remedy sat
on a branch overnight instead of being forced through.

*The fix, and why deleting was never needed.* The defect that purge protects is
the GHOST TAB — an archived chat reappearing OPEN on another device — and that
lives in `panes`, still cleaned. On the client `closedStack` feeds `bumpClosed`
(`reducers/panes.ts`), the same CLOSURE signal the tombstones feed: it reopens
nothing. So the record now stays and its id is stamped instead — the peer that
still holds the tab drops it, and the user's undo survives.

Measured on main, not on a branch:

| check | result |
|---|---|
| `check:idle-writes` | 27 → **0** in 30s (ceiling 3) |
| `pane-undo` + `cross-window-topic-sync` | 8 green |
| `perf-panel` + `idle-frame-budget` | 5 green |
| pane-store unit tests | 450 green |

The second row is the one that matters: those two E2E are what failed the two
previous attempts, and a gate that reaches zero writes by no longer
synchronising has not fixed anything — it has moved the damage somewhere more
visible.

**But re-measuring eleven times found a SECOND channel, and one run is not a
measurement.** The same command, same evening, same machine:

    0, 3, 0 · 0, 1, 0 · 5, 9, 15, 0 · 0, 0, 0, 0, 0

Declaring "0" off the first run would have been exactly the kind of stale this
page exists to prevent. The spike is real and it is NOT the cycle coming back:
every write in it is on `topics-project-panes-<hash>`, a different key from
`pane-store-v2`, written by `useProjectPersistenceSave` — which only runs inside
a ProjectWindow. Eleven of the fifteen arrived ~2.3s apart with an IDENTICAL
body (`{"nonChatPanes":[],"openChatTopicIds":[]}`), i.e. the same signature as
the first cycle on a different channel.

Ruled out already, measured rather than reasoned:

· **not the dedupe guard being wrong** — `projectLayoutSync.dedupe.test.ts`
  covers it and passes; the writes go *around* it, not through a hole in it.
· **not `subscribeLifecycle('open')` clearing the guard** — instrumented the
  page: **zero** socket opens in 30 idle seconds.
· **not always present** — a dedicated probe watching 120 seconds saw ZERO, and
  the server log (which sees every client) counted zero in 45 seconds.

So it is conditional on state the ceiling-3 gate happens to catch sometimes.
Opening a project window on purpose did NOT reproduce it (0 writes in 30s), so
that guess was wrong too.

**What the evidence points at is the FIRST of the two hypotheses the dedupe test
left open: an oscillating value.** The row on the server reads
`{"nonChatPanes":[],"openChatTopicIds":["b23b5ede-…"]}` — but every PUT in the
burst carried `openChatTopicIds: []`. Two sources chasing each other: one
publishes the empty set, something union-adds the chat back (the receive side is
deliberately ADDITIVE — see the comment above `flushSync`), and the next save
sees a change again. The dedupe guard compares against the LAST WRITTEN value,
not the history, which is correct and is exactly why it cannot stop this.

That is a concrete, checkable lead and it is written here rather than acted on,
because the reproduction is not in hand. Five hypotheses were tried and each one
was refuted by a measurement, which is worth listing so nobody spends the same
hour twice:

| tried | result |
|---|---|
| a hole in the dedupe guard | its unit test passes; the writes go *around* it |
| `subscribeLifecycle('open')` clearing the guard | **zero** socket opens in 30 idle seconds |
| a project window being open | opened one deliberately: **0 writes** in 30s |
| the specific chat the server lists for that key | opened it: **0 writes** in 30s |
| two windows (what the FIRST cycle needed) | ran two: **0 writes** in 35s |
| the dev-reload storm after a client build | ran the gate right after `bun run build`: **0** |

And then the sixth measurement explained the other five: `wsClients: 0`. **The
user's own window was closed for all of them**, and the server saw zero writes
from ANY client in 60 seconds. The bursts happened earlier in the evening, while
that window was open — the same shape as the first cycle, which also needed a
second live client and hid for weeks because every measurement was taken with
one.

So the reproduction needs the user's window open, and that is the first line of
the next attempt: watch the PUT body and the inbound `ui-state:updated` for that
key WITH a second real client connected. Not by patching the guard.

**The route ratchet is red too, on ONE route, and it took a quiet machine to
know it.** Re-run four times at load 20-26 with `--samples=80`:

    all_boards_tasks   2.53 · 2.72 · 2.90 · 2.64 ms   ceiling 2.25, baseline 0.75

The two passes agree every time, so the gate itself calls the number true rather
than noise — which is exactly what it refused to do earlier the same evening: at
load 238 (an unrelated `ffmpeg` at 490% CPU) it printed **NON MISURABILE** and
named the witness route instead of inventing a verdict. That refusal is the
feature; the number only became readable once the machine came back down.

Not from this work, verified by stashing everything and re-running: **2.64 ms**
with the changes gone. It is drift accumulated in the **58 commits** that touched
`server/routes/tasks.ts`, `server/services/tasks.ts` and `shared/board.ts` since
the baseline was recorded on 2026-08-15. The other three routes are inside:
`topic_messages` 4.13 (ceiling 5.41), `dispatch_capacity` 0.23-0.32 (1.68),
`topics` inside.

**The bundle ratchet is red, and it is not from this work.** `check:bundle`,
2026-08-19: entry_eager 1,207,328 raw against a 1,169,907 baseline (+2% tolerance
exhausted), critical_path likewise. Measured against the 2026-08-13 baseline:
+22,629 net lines in `client/src` for +11,918 gz, i.e. **0.53 gz bytes per net
line** — BELOW both previous rounds (1.3 and 3.7), no dependency entered the
entry chunk, no `lazy(` went static. Healthy growth, not a bad import. The
baseline's own rule says the number is raised in the commit that grew it, so it
is left alone here and noted instead.

**Where the user's own window ended up, measured at the close of the work.**
This is the acceptance number — the same `mem-report` that produced the "1.8 GB"
complaint, run again on the same live app:

| | footprint | **resident** |
|---|---|---|
| device (app + 4 WebViews) | 1,768 MB | **352 MB** |
| ├ WebContent, 7h39 old | 1,137 MB | 104-217 MB |
| └ three younger WebContents | 412 MB | 13 MB |
| server (bun + sidecars) | 260 MB | ~110 MB |
| **Topics, resident total** | | **~612 MB** |

**80% of the headline is already ceded to the system.** And the machine was
genuinely under pressure at that moment (22.5 GB of swap, 208 MB unused) — but
not because of us: `ollama` alone held **5,054 MB resident**, eight times
Topics.

So the honest close is split. What was ours and could be fixed, was: the server
went 936 → 260 MB, the DB 849 → 213, the idle write cycle 27 → 0. What remains
is a 7-hour-old renderer holding 1.1 GB of footprint against ~150 MB resident,
flat across samples — pages the system already took back and still charges to
the app. **No public API returns them**: `malloc_zone_pressure_relief` acts only
within its own process, and `memorystatus_control` on another pid returns -1
(privileged). The only lever the shell has is `-[WKWebView _close]`, i.e.
recreating the renderer — which costs the user their scroll position and pane
state to reclaim memory nobody is short of.

That is why the panel line exists, and on these exact numbers it fires: *"the
80% is already compressed or swapped: 352 MB in RAM right now"*. It does not
shrink the number; it stops the number from meaning something it does not mean.

**And the client turns out to have the SAME defect as the server, not the one
this page spent a day on.** Measured at 00:23 on the user's own window, two
WebContent processes side by side:

| pid | age | footprint | **RSS** | graphics regions |
|---|---|---|---|---|
| 15517 | 55 min | 726 MB | **24 MB** | 380 |
| 96520 | 4h 11m | 755 MB | **152 MB** | 2,961 |

Two things fall out, and both contradict the reading below. First, the young
process costs the SAME as the old one with **eight times fewer** graphics
regions — so the layer count is not what the megabytes track. Second, and
decisive: the resident set is **24 MB against a 726 MB footprint**, with
`WebKit Malloc` showing **602 MB swapped**. The system has already taken those
pages back; they are still charged to the app by `phys_footprint`, which is the
number the status bar reports.

That is the same fault the server had — memory of past peaks, swapped out and
never handed back — and on the server it took `Bun.gc(true)` to release it,
because the footprint never comes down on its own.

**The client lever does not exist, and that was checked rather than assumed.**
A probe compiled against WebKit on this machine (macOS 26.2) asks the CLASS which
selectors it answers, the same way the shell already does for `_close`. Of the
memory-releasing SPI worth having, WKWebView answers **none**: no `_purgeMemory`,
no `releaseMemory`, no `_didReceiveMemoryWarning`. What exists is
`_killWebContentProcess` / `_killWebContentProcessAndResetState` (blow the render
process away and reload — visible to the user, loses in-page state) and, on
`_WKProcessPoolConfiguration`, `memoryFootprintNotificationThresholds`, which
notifies rather than frees. So the server's remedy has no client twin to port.

**And before building one, the size of the prize was measured — it is smaller
than the status bar suggests.** Resident set of every Topics process at 00:29,
against the machine's own pressure at that moment (17.3 GB swap used, 859 MB
unused):

| process | RSS |
|---|---|
| shell (`app`) | 78 MB |
| server (`bun`) | 173 MB |
| WebContent, 55 min old | **25 MB** (footprint 726 MB) |
| WebContent, 4 h old | 414 MB (footprint 755 MB) |
| **Topics total, resident** | **690 MB** |

On the same machine at the same instant: Dia 2,414 MB, Spotify 972 MB, ffmpeg
835 MB — none of which are Topics. So the RAM Topics is actually holding is
690 MB, and the 55-minute renderer is holding **25 MB** while being charged 726.
The gap is pages the system has already reclaimed and still attributes to the
app, which is exactly what `phys_footprint` means and exactly what the status bar
(correctly, deliberately) reports.

That reframes the remaining work honestly: the number on screen is real as a
metric and misleading as a claim about pressure. The useful step was NOT to hunt
a purge SPI that WebKit does not expose — it was to make the panel SAY what the
number contains.

**And that is done.** When the compressed share passes half the footprint (with
a 300 MB floor, so small windows stay quiet), the panel now reads *"the 78% is
already compressed or swapped: 234 MB in RAM right now"* — a ratio, not an
absolute threshold, because 300 MB of 400 says the same thing as 1.2 GB of 1.8
while 1 GB of 6 explains nothing. It deliberately does NOT say "close
something": that advice belongs to the real-pressure line above it, and here it
would send someone to do something useless. Verified against the live window's
own numbers: 1,041 MB footprint / 234 resident = 78% ceded, and the line fires.

The proof runs through the real path, and it took two attempts to become one.
The first E2E only opened the panel and hoped — and could not work, because
outside Tauri `usePerfMetrics` has no source at all, so the verdict never
appeared and the file stayed green even with an i18n key broken on purpose. The
second simulates the shell at the boundary Tauri itself injects
(`__TAURI_INTERNALS__`), so the hook, the footprint math, the decision, the
strings and the JSX all run for real. It was then proven able to fail: raising
`MIN_COMPRESSI_MB` from 300 to 5000 turns it red, putting it back turns it
green. Four cases cover every branch that reaches the screen — the user's own
numbers, real pressure (which must say the opposite), a partial measurement
(which must stay quiet), and the chain from the status-bar button.

**What follows was measured earlier and is kept for its method, but read it in
that light.**

**The CLIENT half of the number is a different animal** — what follows was
measured before the server work and still stands.

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
1b. **The weight of the shipped app**, which nothing on this page had ever
   looked at. Measured 2026-08-20 on the installed `Topics.app`: **179 MB**, of
   which **134 are the server sidecar**. The sidecar in the repo is 59 MB
   (arm64), so the extra 75 are not code — every binary is UNIVERSAL, and half
   of those bytes will never execute on the machine they land on:

   | binary | universal | arm64 only |
   |---|---|---|
   | topics-server | 134 MB | **64** |
   | app (Tauri shell) | 28 MB | **13** |
   | webrtc-bridge | 16 MB | **8** |
   | pty-bridge | 1 MB | 1 |
   | **total** | **179 MB** | **86 MB** |

   **93 MB, 52%, for shipping two `.dmg` instead of one** — on disk. The
   DOWNLOAD is a different number and the distinction matters, because it is
   what a user actually waits for: a `.dmg` compresses, and compressed the two
   sides shrink unevenly. Measured with gzip on the real binaries:

       universal   134 + 28 + 16 →  50 + 15 + 7 MB compressed  (~73 MB)
       arm64 only   64 + 13 +  8 →  24 +  8 + 3 MB compressed  (~36 MB)

   So the ratio holds (~51%) but the absolute saving is **~37 MB on the wire**,
   not 93. Both numbers are real; they just answer different questions, and
   quoting the disk figure for a download decision would overstate it by 2.5x.

   For scale on the other axis: our own compiled code inside that sidecar is
   ~2 MB (59 MB arm64 minus the 57 MB of the bare `bun` binary), so rewriting
   the server in Rust would save ~57 MB on disk — *less* than splitting the
   architectures.

   What holds the universal build is real and documented in
   `tauri-release.yml`: one universal `.dmg` means one `latest.json`, because
   two per-arch jobs would race to clobber the updater manifest. Surmountable
   (Tauri's manifest keys `darwin-aarch64` and `darwin-x86_64` separately) but
   it is the update channel, so it deserves care rather than a quick patch.
   No gate watches this number today.

   **And a single-arch sidecar does serve requests** — checked rather than
   assumed, because that is what turns the arithmetic into a result.
   `./scripts/build-server-sidecar.sh smoke` compiles for the HOST target only
   (`bun-darwin-arm64`, no `universal`) and exercises it in isolation:
   **`/api/topics` → 200**, the 123 embedded migrations load, the PTY bridge
   stays untouched. So the shipping path is not the obstacle; the updater
   manifest is.

   Worth recording because it cost a detour: launching the `lipo`-thinned
   binary BY HAND exits immediately with an empty log — but so does the
   UNIVERSAL original in the same environment, so `lipo` broke nothing. Both
   exit for their own reason (the singleton lock, or arguments the shell
   passes). A by-hand launch was simply the wrong probe; the repo already had
   the right one.
2. **Memory.** The shell still has no ceiling; the SERVER's boot peak got one
   on 2026-08-19 (`probe:boot-memory`, above). Its steady state is still a
   number without a budget. Still a
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

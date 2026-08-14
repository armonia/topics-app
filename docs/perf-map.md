# The performance map: what has a number and what does not

Updated **2026-08-14**. It serves one purpose: to know WHERE a performance
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
| Transcript scrolling | dropped frames, worst gap, long tasks | `bun run check:fluido` | yes (`\|\| test $? -eq 2`) |
| Latency of 4 hot routes | median ms on a fixed corpus, ratchet | `bun run check:rotte` | yes (`\|\| test $? -eq 2`) |
| Bundle weight | bytes of entry / critical path / total assets | `bun run check:bundle` | yes |
| Click to ink | ms from the gesture to the first painted frame | `bun run check:ink` | yes (since 2026-08-14) |
| Weight of a chat payload | anti-duplication invariant plus bytes per message | `bun test tests/integration/history-payload-weight.test.ts` | yes (`bun test:unit`) |
| Idle frames | how many frames are requested when nothing happens | `tests/e2e/idle-frame-budget.spec.ts` | yes (E2E shard) |
| Shift on refresh (CLS) | layout shift after a reload | `tests/e2e/refresh-cls.spec.ts` | yes (E2E shard) |
| Pane residency cap | how many panes stay mounted | `tests/e2e/pane-residency-cap.spec.ts` | yes (E2E shard) |
| Transcript eviction | how many chats stay hydrated | `tests/e2e/chat-transcript-residency.spec.ts` | yes (E2E shard) |
| Browser pane streaming | fps, p95 input latency, bandwidth, first frame | `tests/e2e/browser-ws-streaming.spec.ts` plus `perf-baseline.json` | yes (E2E shard) |

## What is NOT measured

Uncovered ground as of 2026-08-14. None of these rows has a command that exits
non-zero when it gets worse.

1. **Cold start.** How many milliseconds pass between launch and the first
   usable screen. No probe, no threshold.
2. **Memory.** Neither the server nor the shell has an RSS ceiling. The server
   measured today sat at roughly 200 MB; that is a number, not a budget, because
   nobody compares it against anything.
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

**`/api/topics` carries 977 topics, 967 of them ARCHIVED.** "Open" means
not archived, so the sidebar draws ten of them and receives nine hundred and
seventy more. Inside, the heaviest field is `systemPrompt`: **150 KB out of
712**, populated on 663 topics, and only two surfaces read it, the chat's empty
state and the settings window, always and only for the OPEN topic. Removing it
from the list means giving those two a per-topic read: that is a behaviour
change, not a slimming, which is why this page carries the number and not the
patch.

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

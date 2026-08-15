# The Topics bench

One command, `bun run bench`, that prints one table a human can read and writes
one JSON a machine can diff.

Topics is the workspace that drives `claude` and `codex`. It is not one of those
CLIs, so a table of TUI startup times would compare a Rust binary to a WebView
and answer a question nobody asked. What this suite borrows from
[jcode](https://github.com/1jehuang/jcode), whose README publishes a memory table
anyone can re-run, is the SHAPE: a harness in the repo, units named out loud,
numbers published with the machine they came from, and a knob that injects the
very defect each measurement exists to catch. Its unit is a session; ours are the
three this product is made of, a TOPIC, a TASK, and a DISPATCHED AGENT.

**The claim worth measuring is the cost of the Nth unit.** A workspace pays for
its shell once and then per topic; N terminal tabs pay for everything N times.
That is a graph that gets better with N, and it is the first section of the
table.

## Run it

```bash
bun run bench                       # collect, print the table, write bench/results/summary-latest.json
bun run bench --markdown            # the same rows as the table below
bun run bench --update-readme       # refresh the generated block in this file
bun run bench --max-age-days 30     # exit 1 if any published number is older than that
bun run bench --require-all         # exit 1 if a declared harness never ran on this machine
```

`bun run bench` **collects**. It re-measures nothing: it reads the artefacts the
four harnesses wrote plus the six baselines the gates already hold, checks that
every number still carries its machine and its day, and prints them. Measuring
here as well would give one axis two numbers taken two ways, which is exactly the
mistake the memory harness exists to avoid.

Three exits: `0` report produced, `1` the report cannot be trusted (an artefact
is unreadable, a number lost its machine or its day, a row is staler than asked
for), `2` nothing measurable at all.

## The numbers

<!-- BENCH:TABLE -->

_Collected 2026-08-15 by `bun run bench`, which reads the artefacts below and re-measures nothing._

### THE COST OF THE Nth UNIT

The claim: a workspace pays for its shell once and then per unit, where N terminal tabs pay for everything N times. The slope is the architecture; the total flatters whoever ships the smaller shell.

| what | value | machine | measured | source |
| --- | --- | --- | --- | --- |
| the shell, before any topic<br>phys_footprint summed over server + pty bridge + the renderer, at their idle prompt. | `208.6 MB` | Mac14,6, 12 cores, 32 GB | 2026-08-15 | `memory` |
| the FIRST topic<br>the chat machinery, paid once. | `39.8 MB` | Mac14,6, 12 cores, 32 GB | 2026-08-15 | `memory` |
| the Nth topic after that<br>r2 0.091: not resolvable above this box's own jitter. Steps 1-&gt;5: 5.1 MB, 5-&gt;10: -5 MB, 10-&gt;25: 1.3 MB. The lever that makes it resolvable: --ballast-mb 20 moved it to 20.4 MB at r2 0.999. | `0.3 MB` | Mac14,6, 12 cores, 32 GB | 2026-08-15 | `memory` |
| the Nth agent, inside Topics<br>a `claude` at its prompt plus the server-side session that owns it. | `219.2 MB` | Mac14,6, 12 cores, 32 GB | 2026-08-15 | `memory` |
| the same agent, bare CLI, no Topics<br>the control arm: the same binary in a bare PTY, same metric, same tree walk. | `204.2 MB` | Mac14,6, 12 cores, 32 GB | 2026-08-15 | `memory` |
| what Topics adds per agent<br>the difference of the two rows above, and it sits inside the CLI's own run-to-run spread. | `15 MB` | Mac14,6, 12 cores, 32 GB | 2026-08-15 | `memory` |
| the Nth board card, painted _(derived)_<br>from the 50-card and 500-card board paints below: 450 more cards cost 51.6 ms on top of a fixed ~435 ms. | `0.11 ms` | Apple M2 Max, 12 cores, 32 GB | 2026-08-15 | `latency` |
| a text chunk, long thread over short<br>1.0 would mean the cost of a chunk does not know how long the conversation is. 2000 messages against 6. | `1.11 x` | Apple M2 Max, 12 cores | 2026-08-15 | `streaming` |
| a tool chunk, long thread over short<br>same burst, cumulative tool output instead of text deltas. | `1.09 x` | Apple M2 Max, 12 cores | 2026-08-15 | `streaming` |

### MEMORY, resident (MB of phys_footprint (macOS), summed over the whole process tree)

Never RSS: shared pages would be counted once per process. On Linux the same harness reads Pss from smaps_rollup, which is what jcode sums.

| what | value | machine | measured | source |
| --- | --- | --- | --- | --- |
| Topics idle (server + shell, zero topics)<br>8 processes in the tree | `208.6 MB` | Mac14,6, 12 cores, 32 GB | 2026-08-15 | `memory` |
| Topics with 1 topic open<br>8 processes in the tree | `248.4 MB` | Mac14,6, 12 cores, 32 GB | 2026-08-15 | `memory` |
| Topics with 5 topics open<br>8 processes in the tree | `268.6 MB` | Mac14,6, 12 cores, 32 GB | 2026-08-15 | `memory` |
| Topics with 10 topics open<br>8 processes in the tree | `243.8 MB` | Mac14,6, 12 cores, 32 GB | 2026-08-15 | `memory` |
| Topics with 25 topics open<br>8 processes in the tree | `263.1 MB` | Mac14,6, 12 cores, 32 GB | 2026-08-15 | `memory` |
| Topics with 1 agent at their prompt<br>11 processes in the tree | `494.6 MB` | Mac14,6, 12 cores, 32 GB | 2026-08-15 | `memory` |
| Topics with 4 agents at their prompt<br>17 processes in the tree | `1152.3 MB` | Mac14,6, 12 cores, 32 GB | 2026-08-15 | `memory` |
| 1 bare `claude` at their prompt, no Topics<br>1 process in the tree | `215.4 MB` | Mac14,6, 12 cores, 32 GB | 2026-08-15 | `memory` |
| 4 bare `claude` at their prompt, no Topics<br>4 processes in the tree | `828.1 MB` | Mac14,6, 12 cores, 32 GB | 2026-08-15 | `memory` |

### LATENCY, gesture to ink (ms, median of the samples in the artefact)

The milliseconds between the gesture and the frame that PAINTED the answer, not the frame that received the data. Shell: chromium 147.0.7727.15, 1600x900, headless.

| what | value | machine | measured | source |
| --- | --- | --- | --- | --- |
| app boot, first frame<br>range 88-96 ms · first-contentful-paint from navigation start | `92 ms` | Apple M2 Max, 12 cores, 32 GB | 2026-08-15 | `latency` |
| app boot, sidebar usable<br>range 119.1-131.9 ms | `126.3 ms` | Apple M2 Max, 12 cores, 32 GB | 2026-08-15 | `latency` |
| open a topic, COLD<br>320 ms of it is LIST_REVEAL_FLOOR_MS, a CONSTANT in MessageList.tsx: the list is held hidden so nobody watches the virtualiser re-anchor. The app's own work is 78.6 ms. Reported, never gated. | `398.6 ms` | Apple M2 Max, 12 cores, 32 GB | 2026-08-15 | `latency` |
| open a topic, WARM<br>the same click as switching between two open topics: one measurement, printed once. | `14.6 ms` | Apple Silicon, model not recorded | 2026-08-14 | `ink` |
| open a task card, drawer readable<br>23.3-23.9 | `23.5 ms` | Apple Silicon, model not recorded | 2026-08-14 | `ink` |
| send a message, readable in the list<br>10.2-15.7 | `12.4 ms` | Apple Silicon, model not recorded | 2026-08-14 | `ink` |
| board painted, 50 cards<br>from navigation start, so the shell boot above is inside this number. | `435.5 ms` | Apple M2 Max, 12 cores, 32 GB | 2026-08-15 | `latency` |
| board painted, 200 cards | `453.9 ms` | Apple M2 Max, 12 cores, 32 GB | 2026-08-15 | `latency` |
| board painted, 500 cards<br>500 cards really in the DOM: the todo column is never paged, and the spec asserts the count. | `487.1 ms` | Apple M2 Max, 12 cores, 32 GB | 2026-08-15 | `latency` |

### STREAMING, what one chunk costs (us per chunk, page clock, median of 3 bursts of 1500 chunks)

Frames are injected into a real WebSocket route; progress is counted off the PAINTED page, not off the driver.

| what | value | machine | measured | source |
| --- | --- | --- | --- | --- |
| text delta, 6-message thread | `373.4 us` | Apple M2 Max, 12 cores | 2026-08-15 | `streaming` |
| text delta, 2000-message thread | `416 us` | Apple M2 Max, 12 cores | 2026-08-15 | `streaming` |
| tool output, 6-message thread | `666.6 us` | Apple M2 Max, 12 cores | 2026-08-15 | `streaming` |
| tool output, 2000-message thread | `724.5 us` | Apple M2 Max, 12 cores | 2026-08-15 | `streaming` |
| text chunks absorbed, long thread<br>a FLOOR, not a ceiling: the client was caught up milliseconds after the driver stopped handing off. | `2404 chunks/s` | Apple M2 Max, 12 cores | 2026-08-15 | `streaming` |
| long tasks during a burst<br>0 in every scenario. A long task is 50 ms of blocked main thread. | `0 count` | Apple M2 Max, 12 cores | 2026-08-15 | `streaming` |
| layout shift outside the message list<br>the product invariant: a streaming answer must not move the rest of the app. | `0 CLS` | Apple M2 Max, 12 cores | 2026-08-15 | `streaming` |

### THE TURN, the legs this repo owns (ms, median)

Never summed: two of these overlap in wall clock, because the client is already painting its bubble while the server is still writing the row.

| what | value | machine | measured | source |
| --- | --- | --- | --- | --- |
| Enter, to the request leaving the client | `0.3 ms` | Apple M2 Max, 12 cores, darwin 25.2.0 | 2026-08-15 | `turn` |
| request, to the turn existing<br>in-flight gate, the SQLite write of the user row, the broadcast and one WebSocket hop back. | `10.6 ms` | Apple M2 Max, 12 cores, darwin 25.2.0 | 2026-08-15 | `turn` |
| first provider event, to first token readable | `17.2 ms` | Apple M2 Max, 12 cores, darwin 25.2.0 | 2026-08-15 | `turn` |
| mid-stream event, to that token readable<br>the one that runs hundreds of times a turn. | `23.1 ms` | Apple M2 Max, 12 cores, darwin 25.2.0 | 2026-08-15 | `turn` |
| accepted, to the first provider event<br>not measured by construction: the default mode never calls a model, so this leg is absent rather than fast. Re-run with BENCH_AI_REAL=1 against a logged-in provider to measure it. It belongs to the provider and the network and moves for reasons this repo does not control. | **not measured** | - | - | `turn` |

### FRAMES AND BYTES, from the gates that already measure them

These are baselines a check compares against. This command reads them; it never re-measures them, and it never re-judges them.

| what | value | machine | measured | source |
| --- | --- | --- | --- | --- |
| board drag, 95th percentile frame<br>budget 16.7 ms, which is 60 FPS. Long tasks during the drag: 0. | `9.5 ms` | not recorded | 2026-08-15 | `drag` |
| chat scroll, frames delivered late<br>worst gap 18 ms against a machine cadence of 8.3 ms. | `20 %` | macOS arm64, model not recorded | 2026-08-14 | `scroll` |
| GET a topic's messages<br>on a seeded corpus of 150 topics / 3000 messages / 150 tasks. | `3.38 ms` | not recorded | 2026-08-14 | `route` |
| GET every board's tasks | `0.75 ms` | not recorded | 2026-08-14 | `route` |
| entry bundle, gzipped<br>raw 1169907 bytes. What the browser must have before the app can paint. | `363223 bytes` | not recorded | 2026-08-13 | `bundle` |
| critical path, gzipped<br>6 eager assets in index.html. | `533227 bytes` | not recorded | 2026-08-13 | `bundle` |

### DECLARED, NOT MEASURED HERE

Axes this suite names on purpose and does not have a number for. A gap that is written down can be closed; a gap nobody printed cannot.

| what | value | machine | measured | source |
| --- | --- | --- | --- | --- |
| memory on Linux (Pss) and on Windows<br>the Linux path reads Pss from /proc/&lt;pid&gt;/smaps_rollup and is unit-tested, but it has never run: this box is macOS. A Pss number and a phys_footprint number are not the same measurement and are never printed in one column. | **not measured** | - | - | `memory` |
| memory of the shipped Tauri shell<br>the memory rows are taken with Chromium (Playwright) as the renderer, because the WKWebView shell's children are XPC services reparented to pid 1 and the window cannot be driven from a script on a private port. The totals are Chromium totals; the slope is the product's. | **not measured** | - | - | `memory` |
| the board feed, bytes per task<br>measured, but as a GATE with no artefact: tests/integration/board-payload-weight.test.ts asserts the invariants and a per-task ceiling on a 300-task fixture and never writes a number out. Its header records the live-database figures (467 real roots) and this suite cannot re-run those, so it does not republish them. | **not measured** | - | - | `board-feed` |
| other vendors' CLIs, side by side<br>the only control arm is `claude`, because it is the binary this machine has. A row for a CLI this repo cannot launch would be a number copied from someone else's README. | **not measured** | - | - | `memory` |

### Where these come from

| source | file | kind | re-run |
| --- | --- | --- | --- |
| `memory` | `bench/results/memory-latest.json` | report | `bun run scripts/bench/memory.ts --port 13500 --bundle <bundle> --topics 1,5,10,25 --agents 1,4` |
| `latency` | `test-results/bench-latency.json` | report | `E2E_PORT=13510 TOPICS_E2E_BUNDLE_DIR=<bundle> bun run scripts/bench/latency.ts` |
| `streaming` | `test-results/bench-streaming.json` | report | `E2E_PORT=13520 TOPICS_E2E_BUNDLE_DIR=<bundle> bun run scripts/bench/streaming.ts` |
| `turn` | `bench/results/ai-latency-latest.json` | report | `E2E_PORT=13540 TOPICS_E2E_BUNDLE_DIR=<bundle> bun run scripts/bench/ai-latency.ts` |
| `ink` | `tests/e2e/ink-budget.json` | gate | `bun run check:ink` |
| `drag` | `scripts/drag-frames-baseline.json` | gate | `bun run check:drag` |
| `scroll` | `scripts/scroll-fluidity-baseline.json` | gate | `bun run check:scroll-fluidity` |
| `route` | `scripts/route-latency-baseline.json` | gate | `bun run check:route-latency` |
| `bundle` | `scripts/bundle-baseline.json` | gate | `bun run check:bundle` |
| `board-feed` | `tests/integration/board-payload-weight.test.ts` | gate | `bun test tests/integration/board-payload-weight.test.ts` |

<!-- /BENCH:TABLE -->

## Where each number comes from

Four harnesses measure, and each one has a lever that makes it go visibly wrong.
A bench nobody can watch fail is decoration.

| harness | measures | the lever |
| --- | --- | --- |
| `scripts/bench/memory.ts` | resident memory of the whole tree, per topic and per agent, against a control arm of bare `claude` processes | `--ballast-mb 20` retains 20 MB per topic in the page: the slope moved from 0.3 MB (r2 0.091) to 20.4 MB (r2 0.999) |
| `scripts/bench/latency.ts` | boot, cold topic open, board paint at 50 / 200 / 500 cards | `--stall 120` burns 120 ms per boot frame and per pointerdown: every gesture noticed it, the smallest by +588 ms |
| `scripts/bench/streaming.ts` | what one streamed chunk costs, in a 6-message thread and in a 2000-message one | `--on2 0.3` makes frame parsing cost time proportional to transcript length: the ratio went from 1.11x to 2.77x and the run exited 1 |
| `scripts/bench/ai-latency.ts` | the legs of a turn this repo owns, from Enter to the token being readable | `--stall-send`, `--stall-deliver`, `--stall-accept` |

The six baselines in the last two sections belong to gates that already run in
CI (`check:ink`, `check:drag`, `check:scroll-fluidity`, `check:route-latency`,
`check:bundle`). This command reads them, never re-judges them: a gate that goes
red is that gate's business.

## What this suite does not measure, and why

- **Agent quality.** Topics drives Claude Code and Codex. A task-completion
  benchmark run through this app would measure THEM, and would move when a model
  ships, not when this repo changes. There is no honest way to put it in a table
  whose other rows are milliseconds of our own paint path.
- **Anything needing another vendor's binary.** The only control arm is `claude`,
  because that is the CLI this machine has. Rows for CLIs this repo cannot launch
  would be numbers copied from someone else's README, and copying those is how a
  benchmark turns into an advert.
- **The shipped Tauri shell.** The memory and latency rows use Chromium
  (Playwright) as the renderer: the WKWebView shell's children are XPC services
  reparented to pid 1, and its window cannot be driven from a script on a private
  port. The totals are Chromium totals; the slope is the product's, and the JSON
  says so on every row.
- **Linux and Windows.** The Linux path reads `Pss` from
  `/proc/<pid>/smaps_rollup`, the same field jcode sums, and it is unit-tested,
  but it has never run: this box is macOS. A `Pss` number and a `phys_footprint`
  number are two different measurements and never share a column.
- **The board feed in bytes.** `tests/integration/board-payload-weight.test.ts`
  measures it, but as a gate: it asserts the invariants and a per-task ceiling on
  a 300-task fixture and never writes a number out. Its header records the
  figures from the live database (467 real roots); this suite cannot re-run those
  and does not republish them.

## The rules of the table

1. A number nobody has measured prints as **not measured**, with the reason next
   to it. Never a blank, never a zero. A measured `0` is a different thing and
   says so.
2. Every number carries the machine and the day it was taken on. Four of the
   older baselines never wrote a machine down: those rows say `not recorded`,
   which is a gap the footer counts, not a machine.
3. Units are named per row, and a section names its metric once
   (`phys_footprint` summed over the tree, ms, us per chunk, bytes). Two metrics
   never share a column.
4. A value that is a CONSTANT by construction is marked `const`. The 320 ms on
   the first open of a chat is `LIST_REVEAL_FLOOR_MS` in `MessageList.tsx`, a
   curtain held on purpose so nobody watches the virtualiser re-anchor. The
   runner reads it out of the source at collection time so the two cannot drift.
5. No comparison against another product unless this repo can re-run that
   measurement itself.

## Watching the collector refuse

The table has to be able to say no, or its green means nothing.

```
$ bun run bench --max-age-days 0
! THIS REPORT CANNOT BE TRUSTED:
  - open a topic, WARM: measured 1 day(s) ago (2026-08-14), older than the 0 day(s) asked for. Re-run: bun run check:ink
  - entry bundle, gzipped: measured 2 day(s) ago (2026-08-13), older than the 0 day(s) asked for. Re-run: bun run check:bundle
  ...
exit 1

$ bun run bench --root /tmp/fresh-checkout
0 numbers, of which 0 were taken on a machine nobody wrote down. 41 axes declared and not measured.
! NOTHING MEASURABLE:
  Not one harness left an artefact under /tmp/fresh-checkout. Exit 2, not 1: a table of gaps is not a
  benchmark, and printing it green would say the opposite of what happened.
exit 2

$ bun run bench --require-all      # on a checkout where only the memory harness has run
! THIS REPORT CANNOT BE TRUSTED:
  - latency: test-results/bench-latency.json is absent, and --require-all was asked for. Re-run: ...
exit 1
```

Two of the four harnesses write into `test-results/`, which is gitignored, so on
a fresh clone their rows print as **not measured** until you run them. That is
the honest state and not a bug: nobody else's laptop has taken those numbers.

The rules themselves are under test in `scripts/bench/report.test.ts`
(`bun test scripts/bench/report.test.ts`), including the ones that are easiest to
lose by accident: a gap that starts printing as `0`, a number that loses its
machine, a stale row that keeps being republished.

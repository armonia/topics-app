# `public/` is rebuilt by hand: the `build:watch` agent stays off

**Decision, 2026-08-27.** The launchd job that rebuilt the client bundle on
every save (`com.armonia.topics-build-watch`, disabled since 2026-08-04) is
**not** coming back, with or without a debounce. `public/` moves when somebody
runs `bun run build:client`, and nothing else moves it.

This file exists because "it is off" and "it is off on purpose" are different
states, and only the second one survives the next person who finds the disabled
plist and wonders why.

**The dates, since they have already been read wrong once.** The plist was
created on 2026-07-19 (birth time) and moved into `disabled/` on 2026-08-04
(change time): it ran for sixteen days, it was not switched on and off in a
single afternoon. `stat -f '%SB %Sc'` on the file says both, and a report on
2026-08-29 that read only the modification time concluded the opposite.

**What the decision costs, and it was paid on 2026-08-29.** The bundle on disk
was frozen at 2.2.211 while the repo was at 2.2.215: four versions of client
fixes were committed, landed and released, and none of them was on screen. Every
symptom of it was a question about the app ("I should be in dev mode and I don't
see the marker", "the token counter is gone from the chat") and not one of them
pointed at the build. This is the bill for a hand-rebuilt artefact, so it gets
paid with a signal rather than with a watcher: see "What covers the risk"
below.

## What a rebuild costs, measured

Measured on the machine that actually runs the agents, in an isolated worktree,
while the box was at load average 7.6 to 9.6 (its normal working state).

| | wall | CPU | peak RSS |
|---|---|---|---|
| `bun run build:client` (tsc -b + vite, tsc warm) | 14.3 s | 23.2 s | 1.9 GB |
| `vite build --watch`, first build | 25.4 s | | |
| `vite build --watch`, **one file saved** | 23.7 s / 28.7 s | | |

The third row is the whole argument. `vite build --watch` is not an incremental
compiler: every save reruns the full production rollup, so a one-character edit
costs the same 25 seconds as a cold build. The resident watcher process was at
1.17 GB RSS after its first build and 3.2 GB (9.6% of this machine's memory)
after three; it never gave any of it back.

**How often it would fire.** The job watched the main checkout, where agent work
arrives as lands: up to 39 lands a day in the last two weeks, and `client/src`
changed on 13 to 44 first-parent commits a day. At 25 seconds and ~23 CPU
seconds each, that is a quarter of an hour a day of one core fully busy, on a
box that is already the machine somebody is working on.

## Why not turn it back on with a guard

A debounce changes how many rebuilds happen. It changes nothing about what a
rebuild does, and the objections are all about the latter.

1. **It is not the fast path anyway.** A client change shows up in under a
   second with `bun run dev:client` (Vite HMR, see CONTRIBUTING). Paying 25
   seconds of production rollup to see a fix is the slow way to get the thing
   the dev server already gives away.
2. **It builds from a tree that is never clean.** The main checkout takes lands
   from several agents and edits from live sessions. `scripts/start-prod.sh`
   treats `public/` as a deploy artefact and refuses to rebuild it on boot for
   exactly this reason: a watcher would publish whatever work in progress
   happened to be on disk at second zero.
3. **It publishes a bundle that never passed the typechecker.**
   `build:client:watch` is `vite build --watch` alone. `tsc -b` runs only in the
   one-shot `build:client`.
4. **It breaks E2E runs from that checkout.** The suite refuses a bundle older
   than its sources, and a rebuild that lands mid-run rewrites `public/` under
   the tests, which then fail somewhere unrelated. CONTRIBUTING already warns
   about this exact interaction.
5. **Every rebuild reloads every open window.** `topics-dev.json` is present in
   the repo root, so `startDevBundleReload` broadcasts `ui:bundle-updated` on
   each bundle revision change. A few dozen forced reloads a day, almost all of
   them for a land nobody was watching.

Point 5 is also the answer to "run it next to the server watcher and see": the
two do not deadlock, they compound. The server watcher already had to grow a
birth grace window so it would stop killing a server that was still starting.
Adding a second automaton that rewrites the bundle the same server is serving
buys a class of interaction we would be debugging, not a feature.

## Why not "rebuild before the gates" either

The only gate that needs a fresh `public/` is `check:bundle`, and it is out of
`scripts/qa-gate.sh` on purpose (the exclusion is documented there and asserted
by a unit test). In CI it already runs right after `verify:phase30-strip`, which
builds. Bolting a 25 second build onto the local bar would tax every run to
re-measure something CI measures correctly on a fresh bundle.

## Why not a scheduled rebuild either (once an hour, or on wake)

The third road, and the one this file did not answer until 2026-08-29: rebuild
on a timer instead of on every save, so the bundle is never days behind and the
windows are not reloaded in bursts.

It changes the FREQUENCY and nothing else, and only one of the five objections
above was about frequency. A timer still builds from a checkout that is never
clean (2), still publishes a bundle that never saw `tsc -b` (3), still rewrites
`public/` under a running E2E suite (4), and still reloads every open window
when it lands (5). The hour is one anybody can predict and nobody is watching.
It buys back the invisibility of the drift, which is the only thing that hurt,
and it pays for it with an automaton that publishes unreviewed work while the
person is looking elsewhere.

The drift is covered directly instead, by the signal below. A build that has to
be asked for is a build somebody is looking at.

## What covers the risk instead

* **A stale bundle is no longer invisible.** Since `96f9659ef`
  (GATE-BUNDLE-FRESH-01) `check:bundle` compares mtimes and exits 2 without
  measuring, naming both instants and the file that moved. It can no longer
  deliver a verdict on yesterday's build.
* **The drift is visible where the version is read.** The status-bar chip shows
  the version the SERVER reports (it re-reads `package.json` fresh, so a bump is
  never stale), while `__APP_VERSION__` is baked into the bundle at `vite build`.
  When the two disagree the bundle on screen is not the repo, and since
  STATUSLINE-03 the chip carries a mark and the version popover says both
  numbers plus the command that closes the gap. The comparison is one function,
  `client/src/components/Sidebar/bundleDrift.ts`. This is the answer to the
  2026-08-29 incident above: the build stays manual, but it can no longer be
  four versions behind without saying so.
* **Live client work has a live tool**: `bun run dev:client`.
* **The production bundle has a deliberate moment**: `bun run build:client`,
  before you exercise `:3333`, and before `check:bundle`.
* **CI always measures a fresh build**, so the budgets never drift on a stale
  artefact.

## What would reopen this

A client build measured under a few seconds (a genuinely incremental one), or a
machine that is not the one running the agents. Neither is true today, and both
are measurements, not opinions.

The disabled plist itself lives outside the repo, at
`~/Library/LaunchAgents/disabled/com.armonia.topics-build-watch.plist`. It is
inert where it is; deleting it is one `rm` for whoever owns the machine.

/**
 * `/exit` IN A CLAUDE TAB MUST NOT DELETE THE TAB.
 *
 * The exact moment: the session exits, the server drops it from the in-memory
 * map, marks the row `dormant` (resumable with `--resume`) and rebroadcasts
 * `terminal:sessions` built from that map alone. The prune saw an id "seen and
 * then gone", dropped the pane in `prev.filter`, and `useProjectPersistenceSave`
 * (no debounce) immediately saved the pruned layout: on reload the tab was not
 * back, and with it went the only surface that prints the uuid for
 * `claude --resume`.
 *
 * Two parts, because either alone would prove too little:
 *   1. THE SCENARIO - the two real units (`decideRestoredTerminalPane` +
 *      `createDormantTerminalGuard`) chained the way the hook chains them.
 *   2. THE WIRING - that the hook really does chain them that way. Without it
 *      part 1 would only prove that two functions compose; mounting the hook
 *      would take a React renderer this repo does not have (same call as
 *      `terminalRosterFetch.test.ts`).
 *
 * @covers TERM-01
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { decideRestoredTerminalPane } from './terminalReconcile';
import { createDormantTerminalGuard } from '../../../lib/dormantTerminalGuard';

const settle = () => new Promise<void>(r => setTimeout(r, 0));

/**
 * The prune as the hook runs it: one verdict per terminal pane, the ids to
 * verify handed to the guard, and panes dropped ONLY on 'prune'.
 */
function prune(paneSessionIds: string[], ctx: {
  roster: Set<string>;
  seen: Set<string>;
  guard: ReturnType<typeof createDormantTerminalGuard>;
}): string[] {
  if (!ctx.guard.loaded) return paneSessionIds;
  const toVerify: string[] = [];
  const kept = paneSessionIds.filter(id => {
    const verdict = decideRestoredTerminalPane(
      id, ctx.roster, ctx.seen, ctx.roster.size > 0, ctx.guard.dormantIds, ctx.guard.confirmedGoneIds,
    );
    if (verdict === 'verify') toVerify.push(id);
    return verdict !== 'prune';
  });
  if (toVerify.length > 0) ctx.guard.recheck(toVerify);
  return kept;
}

describe('una sessione parcheggiata dopo il mount non perde la sua tab', () => {
  test('roster [A] → broadcast senza A mentre le dormienti rispondono [A]: la tab resta', async () => {
    const roster = new Set(['A']);
    const seen = new Set<string>();
    let panes = ['A'];
    // The server answers: A is parked (the `dormant` row the exit wrote).
    const guard = createDormantTerminalGuard({
      onUpdate: () => { panes = prune(panes, { roster, seen, guard }); },
      fetcher: async () => ['A'],
    });

    // 1. Mount: the roster lists A, the dormant list comes back empty.
    for (const id of roster) seen.add(id);
    guard.load();
    await settle();
    panes = prune(panes, { roster, seen, guard });
    expect(panes).toEqual(['A']);

    // 2. `/exit`: A leaves the roster. The broadcast lands BEFORE any re-read,
    //    and this is the case that used to delete the tab.
    roster.delete('A');
    roster.add('altra-viva');
    seen.add('altra-viva');
    panes = prune(panes, { roster, seen, guard });
    expect(panes).toContain('A'); // kept while the verdict is pending

    // 3. The re-read answers: parked. The tab stays, and so does the "session
    //    ended / resume" overlay, which lives inside the mounted pane.
    await settle();
    expect(panes).toContain('A');
    expect(guard.dormantIds.has('A')).toBe(true);
  });

  test('una chiusa davvero (riga cancellata) sparisce comunque, in una passata in più', async () => {
    const roster = new Set(['B']);
    const seen = new Set(['B']);
    let panes = ['B'];
    const guard = createDormantTerminalGuard({
      onUpdate: () => { panes = prune(panes, { roster, seen, guard }); },
      fetcher: async () => [], // no dormant row: B is really gone
    });
    guard.load();
    await settle();

    roster.delete('B');
    roster.add('altra-viva');
    seen.add('altra-viva');
    panes = prune(panes, { roster, seen, guard });
    expect(panes).toEqual(['B']); // still being verified

    await settle();
    expect(panes).toEqual([]); // confirmed gone, so pruned
  });
});

// ── The wiring: that the hook really does it this way ──────────────────────

const SYNC = readFileSync(resolve(import.meta.dir, 'useProjectTerminalSync.ts'), 'utf8');
const LIFECYCLE = readFileSync(
  resolve(import.meta.dir, '../../../hooks/useTerminalLifecycle.ts'), 'utf8',
);

describe('cablaggio del prune nelle due superfici', () => {
  test('la finestra progetto passa al verdetto entrambi gli insiemi del guard', () => {
    expect(SYNC).toContain('decideRestoredTerminalPane(');
    expect(SYNC).toContain('guard.dormantIds');
    expect(SYNC).toContain('guard.confirmedGoneIds');
  });

  test("la finestra progetto ri-chiede alla sparizione, e non pota su 'verify'", () => {
    expect(SYNC).toContain("if (verdict === 'verify') toVerify.add(sid);");
    expect(SYNC).toContain("return verdict !== 'prune';");
    expect(SYNC).toContain('guard.recheck(toVerify)');
  });

  test('la lista delle dormienti non si legge più una volta sola, per cwd', () => {
    // The cwd filter missed, by construction, the sessions parked in a
    // SUBDIRECTORY of the project, which the window adopts by prefix.
    expect(SYNC).not.toContain('sessions/dormant?cwd=');
  });

  test('anche lo standalone conosce le parcheggiate', () => {
    expect(LIFECYCLE).toContain('parked.dormantIds');
    expect(LIFECYCLE).toContain('parked.confirmedGoneIds');
    expect(LIFECYCLE).toContain('dormantGuard.recheck(toVerify)');
  });

  test('lo standalone ripassa la potatura quando la risposta arriva', () => {
    // The answer is async: with no re-render the cleanup effect would never run
    // again, and a pane confirmed dead would sit there forever.
    expect(LIFECYCLE).toContain('onUpdate: setParked');
    expect(LIFECYCLE).toMatch(/\}, \[sessionsRef, dormantGuard, parked\]\);/);
  });
});

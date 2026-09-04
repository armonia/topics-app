/**
 * NOTHING GETS PRUNED THAT WAS NOT JUST ASKED ABOUT.
 *
 * The guard exists for one reason: the parked-sessions list is only true in the
 * instant it answers. Reading it at mount and then using it to rule on a
 * disappearance that happened later is using expired evidence - which is exactly
 * how a claude tab left the layout one second after `/exit`.
 *
 * What is tested here is the behaviour, not the shape: the re-read fires, the
 * verdict lands after it, and a parked session NEVER ends up among the confirmed
 * dead.
 *
 * @covers TERM-01
 */
import { describe, test, expect } from 'bun:test';
import { createDormantTerminalGuard } from './dormantTerminalGuard';

/** A controlled fetcher: answers what it is told to, and counts the calls. */
function fetcherOf(...answers: string[][]) {
  const calls: number[] = [];
  let i = 0;
  return {
    calls,
    fetcher: async () => {
      calls.push(++i);
      return answers[Math.min(i - 1, answers.length - 1)] ?? [];
    },
  };
}

/** Let pending promises run (the guard uses no timers). */
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));

describe('dormantTerminalGuard', () => {
  test('prima della risposta non sa niente: né dormienti né sparite', () => {
    const { fetcher } = fetcherOf(['A']);
    const guard = createDormantTerminalGuard({ onUpdate: () => {}, fetcher });
    guard.recheck(['A']);
    expect(guard.loaded).toBe(false);
    expect(guard.dormantIds.has('A')).toBe(false);
    expect(guard.confirmedGoneIds.has('A')).toBe(false);
  });

  test('una sparita che la rilettura elenca è PARCHEGGIATA, e la sua tab si tiene', async () => {
    let updates = 0;
    const { fetcher } = fetcherOf(['A']);
    const guard = createDormantTerminalGuard({ onUpdate: () => { updates++; }, fetcher });
    guard.recheck(['A']);
    await settle();
    expect(guard.loaded).toBe(true);
    expect(guard.dormantIds.has('A')).toBe(true);
    expect(guard.confirmedGoneIds.has('A')).toBe(false);
    // The update is what re-runs the prune: without it the answer would sit in
    // the guard and the decision would never change.
    expect(updates).toBe(1);
  });

  test('una sparita che la rilettura NON elenca è morta, e si pota', async () => {
    const { fetcher } = fetcherOf([]);
    const guard = createDormantTerminalGuard({ onUpdate: () => {}, fetcher });
    guard.recheck(['B']);
    await settle();
    expect(guard.confirmedGoneIds.has('B')).toBe(true);
  });

  test('non si richiede due volte per lo stesso id: il verdetto è definitivo', async () => {
    const { calls, fetcher } = fetcherOf(['A'], [], []);
    const guard = createDormantTerminalGuard({ onUpdate: () => {}, fetcher });
    guard.recheck(['A']);
    await settle();
    guard.recheck(['A']);
    guard.recheck(['A']);
    await settle();
    expect(calls.length).toBe(1);
    // And the verdict does not flip: it stays parked even if a later read (for
    // other ids) stopped listing it.
    expect(guard.dormantIds.has('A')).toBe(true);
  });

  test('gli id spariti mentre una lettura era in volo hanno la loro lettura', async () => {
    const { calls, fetcher } = fetcherOf(['A'], ['A', 'C']);
    const guard = createDormantTerminalGuard({ onUpdate: () => {}, fetcher });
    guard.recheck(['A']);
    guard.recheck(['C']); // C vanishes while the first read is still in flight
    await settle();
    await settle();
    expect(calls.length).toBe(2);
    // C was not declared dead by a read that was not about it.
    expect(guard.confirmedGoneIds.has('C')).toBe(false);
    expect(guard.dormantIds.has('C')).toBe(true);
  });

  test('una lettura fallita non diventa «non potare mai più»', async () => {
    const guard = createDormantTerminalGuard({
      onUpdate: () => {},
      fetcher: async () => { throw new Error('rete giù'); },
    });
    guard.recheck(['D']);
    await settle();
    // No answer: back to the behaviour that preceded the guard, which is to
    // prune. Not knowing must not turn into an immortal tab.
    expect(guard.loaded).toBe(true);
    expect(guard.confirmedGoneIds.has('D')).toBe(true);
  });

  test('load() alza la bandiera senza dichiarare morto nessuno', async () => {
    const { fetcher } = fetcherOf(['A', 'B']);
    const guard = createDormantTerminalGuard({ onUpdate: () => {}, fetcher });
    guard.load();
    await settle();
    expect(guard.loaded).toBe(true);
    expect([...guard.dormantIds].sort()).toEqual(['A', 'B']);
    expect(guard.confirmedGoneIds.size).toBe(0);
  });

  test('il ciclo termina: dopo la rilettura ogni id ha un verdetto', async () => {
    // If an id stayed "to verify" after the answer, the prune would keep it,
    // call recheck again, and the guard would refetch: an endless request loop.
    // This is the condition that rules it out.
    const { calls, fetcher } = fetcherOf(['A'], ['A']);
    const guard = createDormantTerminalGuard({ onUpdate: () => {}, fetcher });
    for (const id of ['A', 'Z']) guard.recheck([id]);
    await settle();
    await settle();
    for (const id of ['A', 'Z']) {
      expect(guard.dormantIds.has(id) || guard.confirmedGoneIds.has(id)).toBe(true);
    }
    // A later pass generates no further requests.
    const before = calls.length;
    guard.recheck(['A', 'Z']);
    await settle();
    expect(calls.length).toBe(before);
  });
});

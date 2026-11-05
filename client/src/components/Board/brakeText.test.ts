/**
 * The words of the board's «Frenato» chip, read without React.
 *
 * @covers HUBBR-20
 */
import { describe, expect, test } from 'bun:test';
import { brakeChipView, brakeDetail, columnNoteView, heldCount, holdingBrakes, waitingClause, whenLabel, workingClause } from './brakeText';
import { liveBrakes, readBrakeAnswer } from '../../state/dispatchBrakes';
import BRAKES_IT from '../../lib/i18n-brakes-it';
import BRAKES_EN from '../../lib/i18n-brakes-en';
import type { DispatchBrake } from '../../../../shared/provider-hold';

const tr = (key: string, vars: Record<string, string | number> = {}) =>
  (BRAKES_IT[key] ?? key).replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? `{${k}}`));

const NOW = new Date(2026, 10, 5, 12, 0).getTime();
const AT_1420 = new Date(2026, 10, 5, 14, 20).getTime();
const TOMORROW_0930 = new Date(2026, 10, 6, 9, 30).getTime();

const claude: DispatchBrake = { provider: 'claude', window: 'five_hour', utilization: 94, untilMs: AT_1420 };
const codex: DispatchBrake = { provider: 'codex', window: 'usage_limit', utilization: null, untilMs: TOMORROW_0930 };

describe('brakeChipView', () => {
  test('nothing held: no chip', () => {
    expect(brakeChipView([], NOW, tr, 'it')).toBeNull();
  });

  test('one provider: its name, the window and its share, the time', () => {
    expect(brakeChipView([claude], NOW, tr, 'it')).toEqual({ who: 'Claude', why: 'quota 5h al 94%, riparte alle 14:20' });
  });

  test('a Codex plan limit says so, and a day ahead says «domani»', () => {
    expect(brakeChipView([codex], NOW, tr, 'it')).toEqual({ who: 'Codex', why: 'limite del piano raggiunto, riparte domani alle 09:30' });
  });

  test('both: both names and the first start again', () => {
    expect(brakeChipView([claude, codex], NOW, tr, 'it')).toEqual({ who: 'Claude e Codex', why: 'riparte alle 14:20' });
  });

  test('a spent week without a share, and an outage without an end', () => {
    expect(brakeChipView([{ provider: 'claude', window: 'seven_day', utilization: null, untilMs: AT_1420 }], NOW, tr, 'it')?.why)
      .toBe('quota della settimana esaurita, riparte alle 14:20');
    expect(brakeChipView([{ provider: 'claude', window: 'api-down', utilization: null, untilMs: null }], NOW, tr, 'it')?.why)
      .toBe("l'API non risponde, riparte appena torna");
  });
});

describe('brakeDetail and whenLabel', () => {
  test('the early stop names its threshold, a spent window does not', () => {
    expect(brakeDetail(claude, NOW, tr, 'it')).toBe('Quota 5h al 94%, riparte alle 14:20 (soglia 90%)');
    expect(brakeDetail({ ...claude, utilization: 100 }, NOW, tr, 'it')).toBe('Quota 5h al 100%, riparte alle 14:20');
  });

  test('a day further than tomorrow names the day', () => {
    expect(whenLabel(new Date(2026, 10, 8, 8, 5).getTime(), NOW, tr, 'it')).toMatch(/^\S+ 0?8\/11 alle 08:05$/);
  });
});

describe('liveBrakes', () => {
  test('a brake past its end is dropped, an outage stays', () => {
    const outage: DispatchBrake = { provider: 'codex', window: 'api-down', utilization: null, untilMs: null };
    expect(liveBrakes([claude, outage], AT_1420 + 1)).toEqual([outage]);
    expect(liveBrakes([claude, outage], NOW)).toEqual([claude, outage]);
  });
});

describe('the cards behind the walls', () => {
  const answer = {
    brakes: [claude, codex],
    held: [
      { taskId: 'a', projectId: 'p', provider: 'claude' },
      { taskId: 'b', projectId: 'p', provider: 'claude' },
      { taskId: 'c', projectId: 'q', provider: 'claude' },
    ],
    working: { codex: 1, muse: 2, claude: 0 },
    claudeFiveHour: 94,
  };

  test('a wall that holds no card is not named: Codex at its limit with every card elsewhere', () => {
    const state = readBrakeAnswer(answer, NOW);
    expect(holdingBrakes(state).map((b) => b.provider)).toEqual(['claude']);
    expect(heldCount(state, 'claude')).toBe(3);
    expect(heldCount(state, 'codex')).toBe(0);
    expect(state.working).toEqual({ codex: 1, muse: 2 });
  });

  test('a held card of a wall past its end is dropped with the wall', () => {
    const state = readBrakeAnswer(answer, AT_1420 + 1);
    expect(state.brakes.map((b) => b.provider)).toEqual(['codex']);
    expect(state.held.size).toBe(0);
  });

  test('the Todo strip counts only the cards of this board', () => {
    const state = readBrakeAnswer(answer, NOW);
    expect(columnNoteView(state, new Set(['a', 'b', 'x']), NOW, tr, 'it')).toEqual({ head: '2 aspettano il freno di Claude', tail: 'Partono da sole alle 14:20.' });
    expect(columnNoteView(state, new Set(['c']), NOW, tr, 'it')).toEqual({ head: '1 aspetta il freno di Claude', tail: 'Parte da sola alle 14:20.' });
    expect(columnNoteView(state, new Set(['x']), NOW, tr, 'it')).toBeNull();
  });

  test('the counts read as Italian clauses', () => {
    expect(waitingClause(1, tr)).toBe('1 card aspetta');
    expect(waitingClause(2, tr)).toBe('2 card aspettano');
    expect(workingClause(0, tr)).toBe('nessuna card al lavoro');
    expect(workingClause(1, tr)).toBe('1 card al lavoro');
  });
});

test('the two catalogues have the same keys', () => {
  expect(Object.keys(BRAKES_EN).sort()).toEqual(Object.keys(BRAKES_IT).sort());
});

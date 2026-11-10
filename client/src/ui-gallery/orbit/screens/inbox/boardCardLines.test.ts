/**
 * @covers ORGPREV-02
 */
import { describe, expect, test } from 'bun:test';
import { ORBIT_CARDS } from '../../../../ui/fixtures/orbit-org/cards';
import { ORBIT_OPS_FLOWS } from '../../../../ui/fixtures/orbit-org/flows';
import { NOCERA_CARDS } from '../../../../ui/fixtures/nocera-org/cards';
import { NOCERA_OPS_FLOWS } from '../../../../ui/fixtures/nocera-org/flows';
import type { OpsFlow, OrbitCard } from '../../../../ui/fixtures/orbit-org/types';
import { boardCardLines, shareOfWords, type BoardCardFacts } from './boardCardLines';

/** The facts of a real card of the fixtures, read the way `boardCard` reads them (the checker never the worker here). */
function factsOf(cards: OrbitCard[], flows: OpsFlow[], id: string): BoardCardFacts {
  const card = cards.find((c) => c.id === id);
  if (!card) throw new Error(`no card ${id}`);
  const flow = flows.find((f) => f.id === card.flow);
  const step = flow?.steps.find((s) => s.id === card.step);
  const actor = step?.actor;
  return {
    stage: step?.stage ?? '',
    step: step?.title ?? '',
    stepIsWorkers: (actor?.kind === 'agent' || actor?.kind === 'person') && actor.id === card.worker.id,
    blockedReason: card.blocked?.reason,
    doing: card.worker.doing,
    reviewerIsWorker: card.reviewer === card.worker.id,
  };
}

describe('boardCardLines', () => {
  test('SG-4131 (ORBIT): the agent reads the report, the step is the same job, no checker yet', () => {
    expect(boardCardLines(factsOf(ORBIT_CARDS, ORBIT_OPS_FLOWS, 'SG-4131'))).toEqual({ step: false, doing: true, reviewer: false });
  });

  test('CT-S02 (ORBIT): the agent found the expired contract, step and checker add nothing now', () => {
    expect(boardCardLines(factsOf(ORBIT_CARDS, ORBIT_OPS_FLOWS, 'CT-S02'))).toEqual({ step: false, doing: true, reviewer: false });
  });

  test('FT-2406 (Consorzio): blocked, only the red reason stays', () => {
    const f = factsOf(NOCERA_CARDS, NOCERA_OPS_FLOWS, 'FT-2406');
    expect(f.blockedReason).toBeTruthy();
    expect(boardCardLines(f)).toEqual({ step: false, doing: false, reviewer: false });
  });

  test('PEC-2410 (Consorzio): blocked, the resend request is said once, in the reason', () => {
    const lines = boardCardLines(factsOf(NOCERA_CARDS, NOCERA_OPS_FLOWS, 'PEC-2410'));
    expect(lines.doing).toBe(false);
    expect(lines.step).toBe(false);
  });

  test('a step done by someone else, with other words, is kept', () => {
    const lines = boardCardLines({ stage: 'lavorazione', step: 'Il Legale scrive o corregge l\'atto', stepIsWorkers: false, doing: 'prepara la bozza in Word', reviewerIsWorker: false });
    expect(lines).toEqual({ step: true, doing: true, reviewer: false });
  });

  test('a step whose words the activity already has goes', () => {
    const lines = boardCardLines({ stage: 'lavorazione', step: 'Verifica IVA, split payment, CIG e fornitore', stepIsWorkers: false, doing: 'verifica IVA e split payment della fattura', reviewerIsWorker: false });
    expect(lines.step).toBe(false);
  });

  test('the checker shows at the check, unless it is the worker', () => {
    const base = { step: '', stepIsWorkers: false, doing: 'controlla', stage: 'verifica' };
    expect(boardCardLines({ ...base, reviewerIsWorker: false }).reviewer).toBe(true);
    expect(boardCardLines({ ...base, reviewerIsWorker: true }).reviewer).toBe(false);
  });

  test('words meet across endings', () => {
    expect(shareOfWords('contratti scaduti', 'il contratto scaduto')).toBe(1);
  });
});

/**
 * The three sentences of the queue chip, from the key the server chose.
 *
 * It lives in `shared/` and takes the translator as an argument, so it depends
 * on no catalogue: the client passes `useT()`, a test passes a lookup into the
 * Italian dictionary, and neither side has to know how the other resolves a
 * key. That is the whole reason the reason travels as `key` + `params` now
 * (see `QueueReason`): the branch is still decided on the server, the words
 * are written wherever they are read.
 */
import type { QueueReason } from './board';

export interface QueueReasonText {
  /** First word of the chip. */
  head: string;
  /** What follows it: a count, a clock, an id. */
  detail: string;
  /** The tooltip: what happens next, and what you have to do. */
  title: string;
}

/**
 * The translator, as an argument. It is declared HERE and re-exported by the
 * client (`components/Board/taskActionWords.ts`) rather than written twice:
 * two identical function types on the two sides of the wire is exactly the
 * mirror `tests/unit/no-type-mirrors.test.ts` refuses, and it refuses it for a
 * reason nobody remembers until the two drift.
 */
export type Translate = (key: string, vars?: Record<string, string | number>) => string;

export function queueReasonText(reason: QueueReason, translate: Translate): QueueReasonText {
  const params = reason.params && withDecimals(reason.params, translate);
  const say = (part: keyof QueueReasonText): string => translate(`${reason.key}.${part}`, params);
  return { head: say('head'), detail: say('detail'), title: say('title') };
}

/**
 * A fractional number in the reader's language: «liberi 1,4» in Italian, "1.4
 * free" in English. The server sends numbers and not strings precisely so the
 * separator is chosen here, by the catalogue that chose the words.
 */
function withDecimals(params: Record<string, string | number>, translate: Translate): Record<string, string | number> {
  const sep = translate('board.queue.decimalSeparator');
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(params)) {
    out[k] = typeof v === 'number' && !Number.isInteger(v) && sep.length === 1 ? String(v).replace('.', sep) : v;
  }
  return out;
}

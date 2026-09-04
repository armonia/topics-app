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
  const say = (part: keyof QueueReasonText): string => translate(`${reason.key}.${part}`, reason.params);
  return { head: say('head'), detail: say('detail'), title: say('title') };
}

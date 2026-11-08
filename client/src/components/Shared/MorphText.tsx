/**
 * MorphText: a sentence that gets REWRITTEN instead of being replaced.
 *
 * The plan (what changed, how long it takes) is worked out by `lib/textMorph`;
 * all that lives here is how to draw it, plus the three choices that make it
 * usable on a board holding fifty cards.
 *
 * 1. AT REST IT DOES NOT EXIST. As long as the text does not change this
 *    component renders a plain string and nothing else: zero extra nodes, zero
 *    classes, nothing for React to diff. The per letter `span`s only appear for
 *    the ~300ms of the animation, and then the DOM goes back to what it was. A
 *    card already carries twenty nodes; twenty-five titles broken into letters
 *    and kept that way would be thousands of live nodes for an effect that
 *    lasts an instant.
 *
 * 2. WORDS DO NOT BREAK. Every letter is an `inline-block`, and a browser is
 *    free to wrap between two `inline-block`s: with no precaution a narrow card
 *    would have wrapped half a word for the length of the animation, pushing
 *    the whole body around it. The letters of a word sit inside a `.morph-word`
 *    (`white-space: nowrap`), so the points where the sentence wraps stay the
 *    spaces, as they always were.
 *
 * 3. WHOEVER ASKED FOR LESS MOTION SEES NONE. The plan is not even computed:
 *    the new text simply appears, which is exactly the earlier behaviour.
 *
 * The `seq` key on the wrapper is not decoration: a second rewrite while the
 * first is still in flight has to START OVER, and a CSS animation only restarts
 * when the node is new. Without a fresh key React would reuse the same spans
 * and the second change would be mute.
 */
import { useEffect, useRef, useState } from 'react';

import { morphPlan, morphWordChunks, type MorphPlan } from '../../lib/textMorph';
import { prefersReducedMotion } from '../../lib/reducedMotion';

interface Volo {
  plan: MorphPlan;
  seq: number;
}

/**
 * The running order, computed BEFORE drawing rather than while drawing.
 *
 * For every chunk it returns the index the running order had reached just
 * before that chunk: letter k of the chunk comes in at `start + 1 + k`. Spaces
 * advance the index just like letters (so the rhythm stays the rhythm of the
 * sentence) even though they are never animated.
 */
function startsChunk(chunks: string[]): number[] {
  const out: number[] = [];
  let indice = -1;
  for (const chunk of chunks) {
    out.push(indice);
    indice += Array.from(chunk).length;
  }
  return out;
}

export function MorphText({ text }: { text: string }) {
  const precedente = useRef(text);
  const seq = useRef(0);
  const [volo, setVolo] = useState<Volo | null>(null);

  useEffect(() => {
    if (precedente.current === text) return;
    const plan = prefersReducedMotion() ? null : morphPlan(precedente.current, text);
    precedente.current = text;
    if (!plan) return;
    seq.current += 1;
    setVolo({ plan, seq: seq.current });
    // +60ms: the timer must not land BEFORE the last letter. The last one
    // starts at `(n-1) * step` and runs for `MOTION.base`, which is already
    // inside `durationMs`; the margin covers the frame the animation settles in.
    const t = setTimeout(() => setVolo(null), plan.durationMs + 60);
    return () => clearTimeout(t);
  }, [text]);

  if (!volo) return <>{text}</>;

  if (volo.plan.kind === 'block') {
    return <span key={volo.seq} className="morph-block">{text}</span>;
  }

  const { prefix, changed, suffix, stepMs } = volo.plan;
  const chunks = morphWordChunks(changed);
  const partenze = startsChunk(chunks);
  return (
    <span key={volo.seq}>
      {prefix}
      {chunks.map((chunk, ci) => {
        if (/^\s+$/u.test(chunk)) {
          // A space takes up its slot in the running order (the rhythm stays
          // that of the sentence) but it is not a letter to bring in.
          return <span key={`s${ci}`}>{chunk}</span>;
        }
        return (
          <span key={`w${ci}`} className="morph-word">
            {Array.from(chunk).map((ch, k) => (
              <span
                key={k}
                className="morph-char"
                style={{ animationDelay: `${Math.round((partenze[ci] + 1 + k) * stepMs)}ms` }}
              >
                {ch}
              </span>
            ))}
          </span>
        );
      })}
      {suffix}
    </span>
  );
}

// Playful, ever-rotating "the model is working" phrases — the whimsical
// gerund line Claude Code shows while it thinks, in Italian and turned up a
// notch. Rendered by <TurnActivityIndicator> (MessageParts.tsx) next to the
// live turn timer. Kept as a pure module so `phraseAt` is unit-testable and
// deterministic: the phrase is a pure function of elapsed time, so it never
// flickers or reshuffles across React re-renders — a single 1s tick advances
// both the timer and (every ROTATE_MS) the phrase.

/** How long each phrase stays on screen before the next one rotates in. */
export const ROTATE_MS = 2800;

/**
 * The rotation set. Intentionally strange and playful (per design). Keep them
 * short — they sit inline before a "· 3.2s" timer. First entry doubles as the
 * reduced-motion / static fallback, so keep it the most self-explanatory one.
 */
export const PHRASES: readonly string[] = [
  'Sto ragionando',
  'Frullo le idee',
  'Scomodo i neuroni',
  'Interrogo l’oracolo',
  'Lucido gli ingranaggi',
  'Impasto i bit',
  'Consulto le stelle',
  'Mi scervello',
  'Rovescio il cassetto delle idee',
  'Aguzzo l’ingegno',
  'Annodo i pensieri',
  'Scaldo i motori',
  'Sfoglio l’infinito',
  'Coccolo un’intuizione',
  'Rincorro il filo',
];

/**
 * Which phrase to show at a given elapsed time. Deterministic and pure:
 * `PHRASES[floor(elapsed / ROTATE_MS) % len]`. Non-finite or negative elapsed
 * collapses to the first (static) phrase — the same value reduced-motion uses.
 */
export function phraseAt(elapsedMs: number): string {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return PHRASES[0];
  const idx = Math.floor(elapsedMs / ROTATE_MS) % PHRASES.length;
  return PHRASES[idx];
}

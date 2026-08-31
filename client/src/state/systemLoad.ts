/**
 * HOW LOADED THE MACHINE IS, PUBLISHED ONCE AND READ ANYWHERE.
 *
 * Two surfaces ask the same question now: the dot next to "Topics", which is
 * always on screen, and the "Topics" menu, which spells the numbers out when
 * you open it. Letting each one mount the metric hooks would be the obvious
 * thing and it is the wrong thing, for a reason that is not "one fetch too
 * many": `computeTopicsFootprint` carries an EMA across calls, keyed on the
 * sample timestamp. A second caller in the same frame consumes the same sample
 * a second time and the smoothing stops being smoothing.
 *
 * So there is ONE owner. The dot polls, because it is the surface that is
 * always mounted, and publishes here; everybody else subscribes. A reader that
 * mounts before the first sample gets `null`, which is the honest answer and
 * not a zero.
 */
import { useSyncExternalStore } from 'react';

export interface CaricoSistema {
  /** 0 to 1, as `livelloCarico` computes it. */
  livello: number;
  /** False when nothing at all could be measured: the dot is drawn anyway, and
   *  says so in words rather than pretending to be calm. */
  misurato: boolean;
  /** Megabytes Topics holds in total, or null where they cannot be measured. */
  totalMB: number | null;
  /** Percent of the machine, or null where it cannot be measured. */
  totalCpu: number | null;
  /** Frames per second in this window. Not part of the level, see `loadTint`. */
  fps: number;
  /** True when one of the two halves of the figure is missing, which is what
   *  the leading "~" says on screen. */
  parziale: boolean;
}

let corrente: CaricoSistema | null = null;
const iscritti = new Set<() => void>();

/** Called by the single owner on every new sample. */
export function pubblicaCarico(c: CaricoSistema): void {
  // Identical samples are not republished: the perf poll fires every five
  // seconds and an idle machine produces the same numbers, which would be one
  // re-render per subscriber per tick for no change on screen.
  if (corrente
    && corrente.livello === c.livello
    && corrente.totalMB === c.totalMB
    && corrente.totalCpu === c.totalCpu
    && corrente.fps === c.fps
    && corrente.parziale === c.parziale
    && corrente.misurato === c.misurato) return;
  corrente = c;
  for (const fn of iscritti) fn();
}

function subscribe(fn: () => void): () => void {
  iscritti.add(fn);
  return () => { iscritti.delete(fn); };
}

function snapshot(): CaricoSistema | null {
  return corrente;
}

/** The last published load, or null until the first sample lands. */
export function useCarico(): CaricoSistema | null {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

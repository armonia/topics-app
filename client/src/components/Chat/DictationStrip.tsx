import { useEffect, useState } from 'react';
import { useT } from '../../hooks/useT';
import { CHAT_STRIP } from '../../lib/chatStripStyles';

/**
 * The strip above the composer while the microphone is open or the audio is
 * being transcribed. Three things it did not say before, measured on
 * 2026-09-03 while every note took 9-24 s:
 *
 *  · TIME. A recording with no clock feels stuck at the second pause, and a
 *    transcription with no clock is indistinguishable from a hang. Both get
 *    a counter.
 *  · SIGNAL. A meter that moves with the voice is the only proof, while you
 *    speak, that the microphone is the one you think and that it hears you.
 *    The probe already measured the level to diagnose empty notes; now it is
 *    drawn.
 *  · THE ENGINE THAT WILL ANSWER. The label comes from capabilities that are
 *    verified, not guessed from the presence of a key: a dead cloud key names
 *    the local model here, and the seconds it costs are attributed to it.
 *
 * And, since the live engine landed, THE WORDS THEMSELVES: `partial` is the
 * text Scribe is still revising, drawn in grey where the hint would be. Grey is
 * the whole point of the distinction: a committed segment is already in the
 * composer, black, editable; what is here is a guess the next packet may
 * rewrite, and pasting it would make the field flicker under the cursor.
 */
export function DictationStrip({
  state,
  since,
  level,
  engine,
  hint,
  partial = '',
  live = false,
  onStop,
}: {
  state: 'listening' | 'transcribing';
  /** `performance.now()` at the start of this state. */
  since: number;
  /** The current input level, 0-1. Read every frame while listening. */
  level: () => number;
  /** Who transcribes, e.g. «ElevenLabs scribe_v2»; null while unverified. */
  engine: string | null;
  hint: string;
  /** The words the live engine has not settled yet. Empty on the batch flow. */
  partial?: string;
  /** The engine streams: the strip says so before a single word arrives. */
  live?: boolean;
  onStop: () => void;
}) {
  const tr = useT();
  const listening = state === 'listening';
  return (
    <div
      data-testid="dictation-banner"
      data-state={state}
      className={`${CHAT_STRIP} bg-app-hover border border-app-border-light px-3 py-2 flex items-center gap-2.5 flex-shrink-0`}
    >
      <span className={`w-2 h-2 rounded-full flex-shrink-0 ${listening ? 'bg-green-500' : 'bg-amber-500'} animate-pulse`} />
      <span className="text-[12px] font-medium text-app-text">
        {listening
          ? tr(live ? 'chat.dictation.live' : 'chat.dictation.listening')
          : tr('chat.dictation.transcribing')}
      </span>
      <Elapsed since={since} />
      {listening && <LevelMeter level={level} />}
      {/* The live text takes the place of the hint, not a line of its own: a
          strip that grows while you speak pushes the composer down mid-sentence. */}
      {listening && partial ? (
        <span data-testid="dictation-partial" className="text-[11px] italic text-app-text-tertiary truncate min-w-0">
          {partial}
        </span>
      ) : (
        <span className="text-[11px] text-app-text-secondary truncate min-w-0">
          {listening ? `${hint} · ` : ''}{engine ?? tr('chat.dictation.engineUnknown')}
        </span>
      )}
      {listening && (
        <button
          type="button"
          onClick={onStop}
          data-testid="dictation-stop"
          className="ml-auto px-3 py-1 text-[11px] rounded-md bg-app-surface border border-app-border-light hover:bg-app-hover transition-colors flex-shrink-0"
        >
          {tr('chat.dictation.stop')}
        </button>
      )}
    </div>
  );
}

/** m:ss since `since`, refreshed four times a second: fine enough to read as
 *  a clock, coarse enough to cost nothing. */
function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    const id = setInterval(() => setNow(performance.now()), 250);
    return () => clearInterval(id);
  }, []);
  const s = Math.max(0, Math.floor((now - since) / 1000));
  const text = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  return <span data-testid="dictation-elapsed" className="text-[11px] tabular-nums text-app-text-secondary">{text}</span>;
}

const BARS = 12;

/** Twelve bars that follow the level. Sampled on the animation frame and
 *  painted with `style`, so a whole recording never re-renders the strip. */
function LevelMeter({ level }: { level: () => number }) {
  const [lit, setLit] = useState(0);
  useEffect(() => {
    let frame = 0;
    const tick = () => {
      // Speech peaks sit around 0.2-0.6 of full scale: a square root spreads
      // the quiet end so a normal voice lights more than two bars.
      const v = Math.sqrt(Math.max(0, Math.min(1, level())));
      setLit((prev) => {
        const next = Math.round(v * BARS);
        return next === prev ? prev : next;
      });
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [level]);
  return (
    <span data-testid="dictation-level" data-lit={lit} className="flex items-end gap-[2px] h-3 flex-shrink-0" aria-hidden="true">
      {Array.from({ length: BARS }, (_, i) => (
        <span
          key={i}
          className={`w-[3px] rounded-sm ${i < lit ? 'bg-green-500' : 'bg-app-border'}`}
          style={{ height: `${4 + (i % 4) * 2 + (i >= 8 ? 2 : 0)}px` }}
        />
      ))}
    </span>
  );
}

/**
 * The «Verifica di Topics» row: the three voices of the server's self-check allow-italian: the quoted UI label is the subject
 * round, each with what was measured and its most likely cause. Read from
 * `/api/topics-check` when the view opens and every minute after (the round
 * itself runs every 5 minutes, so a faster read shows nothing new).
 */
import { useEffect, useState } from 'react';
import { ChevronRight, HeartPulse } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { apiFetch } from '../../lib/shell/net';
import { DANGER_TEXT, SUCCESS_TEXT } from '../../lib/popoverStyles';
import { SECTION, SECTION_COUNT, SECTION_REST } from './automationsUi';

interface Voice { id: 'cards' | 'seats' | 'proofs'; red: boolean; hoursLost: number; detail: string; cause: string | null }

interface Cures { investigated: string[]; capped: string[] }

type RoundState = 'waiting' | 'stale' | 'live';

/** The daily reading as the server stores it: colour and reason codes, the words are ours (`auto.check.daily.*`). */
interface Daily {
  day: string; old: boolean; color: 'green' | 'red' | 'unread';
  reason: 'reading' | 'interrupted' | 'unreachable' | 'unreadable' | null;
  line: string; cardId: string | null; cardNote: 'capped' | 'failed' | null;
}

const READ_EVERY_MS = 60_000;

export function TopicsCheckRow() {
  const tr = useT();
  const [voices, setVoices] = useState<Voice[] | null>(null);
  const [round, setRound] = useState<{ state: RoundState; ageMin: number | null }>({ state: 'waiting', ageMin: null });
  const [daily, setDaily] = useState<Daily | null>(null);
  const [cures, setCures] = useState<Cures>({ investigated: [], capped: [] });
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    const read = async () => {
      try {
        const r = await apiFetch('/api/topics-check');
        const body = (await r.json()) as { voices?: Voice[]; state?: RoundState; ageMin?: number | null; cures?: Partial<Cures>; daily?: Daily | null };
        if (alive && r.ok && Array.isArray(body.voices)) {
          setVoices(body.voices);
          setDaily(body.daily ?? null);
          setCures({ investigated: body.cures?.investigated ?? [], capped: body.cures?.capped ?? [] });
          setRound({ state: body.state ?? 'live', ageMin: body.ageMin ?? null });
        }
      } catch { /* the row keeps what it last read */ }
    };
    void read();
    const id = setInterval(() => void read(), READ_EVERY_MS);
    return () => { alive = false; clearInterval(id); };
  }, []);

  if (!voices) return null;
  const red = voices.filter((v) => v.red).length;
  // A check that has not run, or has stopped, is never shown green.
  const state = round.state !== 'live' ? round.state : red > 0 ? 'red' : 'green';
  const label = state === 'waiting' ? tr('auto.check.waiting') : state === 'stale' ? tr('auto.check.stale', { n: round.ageMin ?? 0 }) : red > 0 ? tr('auto.check.red', { n: red }) : tr('auto.check.green');
  const dailyState = !daily ? null : daily.old ? 'old' : daily.color === 'unread' ? 'unread' : daily.color;
  const dailyText = !daily ? '' : daily.color === 'unread'
    ? [tr(`auto.check.daily.${daily.reason ?? 'reading'}`), daily.reason === 'unreachable' ? daily.line : ''].filter(Boolean).join(': ')
    : daily.line || tr(`auto.check.daily.${daily.color}`);
  return (
    <div data-testid="topics-check" data-state={state}>
      <h2 className={SECTION}>
        <HeartPulse size={13} aria-hidden="true" />{tr('auto.check.title')}
        <span className={`${SECTION_COUNT} ${state === 'green' ? SUCCESS_TEXT : DANGER_TEXT}`} data-testid="topics-check-state">
          {label}
        </span>
        <span className={SECTION_REST}>{tr('auto.check.note')}</span>
      </h2>
      <button
        type="button"
        className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-compact text-app-text-secondary hover:bg-app-hover"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        data-testid="topics-check-toggle"
      >
        <ChevronRight size={12} className={open ? 'rotate-90' : ''} aria-hidden="true" />
        {voices.map((v) => v.detail).join(' · ')}
      </button>
      {daily && (
        <p className={`px-2 pl-6 text-compact ${dailyState === 'red' ? DANGER_TEXT : dailyState === 'green' ? SUCCESS_TEXT : 'text-app-text-tertiary'}`} data-testid="topics-check-daily" data-state={dailyState}>
          {tr('auto.check.daily.day', { day: daily.day })}{daily.old ? ` (${tr('auto.check.daily.old')})` : ''}: {dailyText}
          {daily.cardNote && ` · ${tr(daily.cardNote === 'capped' ? 'auto.check.daily.capped' : 'auto.check.daily.cardFailed')}`}
        </p>
      )}
      {(cures.capped.length > 0 || cures.investigated.length > 0) && (
        <p className="px-2 pl-6 text-compact text-app-text-tertiary" data-testid="topics-check-cures">
          {[cures.capped.length > 0 && tr('auto.check.capped', { n: cures.capped.length }), cures.investigated.length > 0 && tr('auto.check.investigated', { n: cures.investigated.length })].filter(Boolean).join(' · ')}
        </p>
      )}
      {open && (
        <ul className="mt-1 space-y-1 px-2 pl-6 text-compact" data-testid="topics-check-voices">
          {voices.map((v) => (
            <li key={v.id} data-testid="topics-check-voice" data-id={v.id} data-red={v.red}>
              <span className={v.red ? DANGER_TEXT : SUCCESS_TEXT}>{tr(`auto.check.${v.id}`)}</span>
              {': '}{v.detail}
              {v.cause && <span className="block text-app-text-tertiary">{v.cause}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

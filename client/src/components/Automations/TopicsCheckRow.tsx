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

const READ_EVERY_MS = 60_000;

export function TopicsCheckRow() {
  const tr = useT();
  const [voices, setVoices] = useState<Voice[] | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    const read = async () => {
      try {
        const r = await apiFetch('/api/topics-check');
        const body = (await r.json()) as { voices?: Voice[] };
        if (alive && r.ok && Array.isArray(body.voices)) setVoices(body.voices);
      } catch { /* the row keeps what it last read */ }
    };
    void read();
    const id = setInterval(() => void read(), READ_EVERY_MS);
    return () => { alive = false; clearInterval(id); };
  }, []);

  if (!voices) return null;
  const red = voices.filter((v) => v.red).length;
  return (
    <div data-testid="topics-check" data-state={red > 0 ? 'red' : 'green'}>
      <h2 className={SECTION}>
        <HeartPulse size={13} aria-hidden="true" />{tr('auto.check.title')}
        <span className={`${SECTION_COUNT} ${red > 0 ? DANGER_TEXT : SUCCESS_TEXT}`} data-testid="topics-check-state">
          {red > 0 ? tr('auto.check.red', { n: red }) : tr('auto.check.green')}
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

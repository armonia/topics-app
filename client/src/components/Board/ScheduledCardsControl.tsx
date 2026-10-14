import { useCallback, useEffect, useRef, useState } from 'react';
import { CalendarClock, Pencil, Plus, Trash2 } from 'lucide-react';
import { useLocale, useT } from '../../hooks/useT';
import { boardApi, CLOSER_LABELS, KIND_LABELS, STATUS_LABEL, type ScheduledCard, type ScheduledCardInput, type TaskLabel } from '../../lib/board';
import { Menu } from '../Shared/Menu';
import { TOOLBAR_CONTROL_H, TOOLBAR_ICON_W } from './constants';

const LABELS: TaskLabel[] = [...CLOSER_LABELS, ...KIND_LABELS];
const COLUMNS: ScheduledCardInput['status'][] = ['backlog', 'todo', 'in_progress', 'review'];
// Una ricorrenza nuova parte nel fuso di chi la scrive; Europe/Rome solo se il browser non lo dice.
const defaultTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Rome';

export function ScheduledCardsControl({ projectId }: { projectId: string }) {
  const tr = useT();
  const locale = useLocale();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [cards, setCards] = useState<ScheduledCard[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [preset, setPreset] = useState('weekly');
  const [presetTime, setPresetTime] = useState('09:00');
  const [labelDraft, setLabelDraft] = useState('');
  const [form, setForm] = useState<ScheduledCardInput>({ text: '', status: 'backlog', labels: [], cron: '0 9 * * 1', timeZone: defaultTimeZone() });

  const refresh = useCallback(async () => {
    try { setCards(await boardApi.scheduledCards.list(projectId)); }
    catch (cause) { setError((cause as Error).message); }
  }, [projectId]);
  useEffect(() => { if (open) void refresh(); }, [open, refresh]);
  useEffect(() => {
    if (!open) return;
    const timer = window.setInterval(() => { void refresh(); }, 5000);
    return () => window.clearInterval(timer);
  }, [open, refresh]);

  const reset = () => {
    setEditing(null); setPreset('weekly'); setPresetTime('09:00');
    setLabelDraft('');
    setForm({ text: '', status: 'backlog', labels: [], cron: '0 9 * * 1', timeZone: defaultTimeZone() });
  };
  const edit = (card: ScheduledCard) => {
    const match = /^(\d{1,2}) (\d{1,2}) \* \* (\*|1)$/.exec(card.cron);
    setEditing(card.id); setPreset(match ? (match[3] === '*' ? 'daily' : 'weekly') : card.cron === '0 * * * *' ? 'hourly' : 'custom');
    if (match) setPresetTime(`${match[2]!.padStart(2, '0')}:${match[1]!.padStart(2, '0')}`);
    setLabelDraft(card.labels.join(', '));
    setForm({ text: card.text, status: card.status, labels: card.labels, cron: card.cron, timeZone: card.timeZone, enabled: card.enabled });
  };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const body = { ...form, labels: labelDraft.split(',').map(label => label.trim()).filter((label): label is TaskLabel => LABELS.includes(label as TaskLabel)) };
      if (editing) await boardApi.scheduledCards.update(projectId, editing, body);
      else await boardApi.scheduledCards.create(projectId, body);
      reset(); await refresh();
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  };
  const toggle = async (card: ScheduledCard) => {
    try { await boardApi.scheduledCards.setEnabled(projectId, card.id, !card.enabled); await refresh(); }
    catch (cause) { setError((cause as Error).message); }
  };
  const remove = async (card: ScheduledCard) => {
    try { await boardApi.scheduledCards.remove(projectId, card.id); if (editing === card.id) reset(); await refresh(); }
    catch (cause) { setError((cause as Error).message); }
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-label={tr('board.scheduled.title')}
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
        title={tr('board.scheduled.title')}
        data-testid="scheduled-cards-open"
        className={`grid ${TOOLBAR_CONTROL_H} ${TOOLBAR_ICON_W} place-items-center rounded ${open ? 'bg-white/15 text-app-text' : 'text-app-text-secondary hover:bg-white/5'}`}
      ><CalendarClock className="h-3.5 w-3.5" /></button>
      <Menu open={open} anchorRef={buttonRef} onClose={() => setOpen(false)} align="right" minWidth={390} unmanagedFocus ariaLabel={tr('board.scheduled.title')} testId="scheduled-cards-menu">
        <div className="max-h-[min(75vh,640px)] overflow-y-auto p-3 text-compact">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-medium text-app-text">{tr('board.scheduled.title')}</h2>
            <button type="button" className="flex items-center gap-1 rounded px-2 py-1 text-app-text-secondary hover:bg-white/10" onClick={reset}>
              <Plus className="h-3 w-3" />{tr('board.scheduled.add')}
            </button>
          </div>
          {cards.length === 0 && <p className="mb-3 text-app-text-muted">{tr('board.scheduled.empty')}</p>}
          <ul className="mb-3 space-y-2">
            {cards.map(card => (
              <li key={card.id} data-testid="scheduled-card-row" className="rounded border border-white/10 bg-black/10 p-2">
                <div className="flex items-start gap-2">
                  <input aria-label={tr('board.scheduled.enabled', { text: card.text })} type="checkbox" checked={card.enabled} onChange={() => void toggle(card)} className="mt-1 accent-primary" />
                  <div className="min-w-0 flex-1">
                    <div className="break-words font-medium text-app-text">{card.text}</div>
                    <div className="text-app-text-muted">{card.cron} · {card.timeZone}</div>
                    <div className="text-app-text-secondary">{tr('board.scheduled.next', { date: new Date(card.nextRunAt).toLocaleString(locale, { timeZone: card.timeZone }) })}</div>
                    <div className="text-app-text-secondary">{tr('board.scheduled.last', { result: card.lastResult ? tr(`board.scheduled.result.${card.lastResult}`) : tr('board.scheduled.noResult'), reason: card.lastReason ?? '' })}</div>
                  </div>
                  <button type="button" aria-label={tr('board.scheduled.edit')} onClick={() => edit(card)} className="rounded p-1 text-app-text-secondary hover:bg-white/10"><Pencil className="h-3.5 w-3.5" /></button>
                  <button type="button" aria-label={tr('board.scheduled.delete')} onClick={() => void remove(card)} className="rounded p-1 text-app-text-secondary hover:bg-rose-500/15 hover:text-rose-300"><Trash2 className="h-3.5 w-3.5" /></button>
                </div>
              </li>
            ))}
          </ul>
          <form onSubmit={submit} className="space-y-2 border-t border-white/10 pt-3">
            <h3 className="font-medium text-app-text">{tr(editing ? 'board.scheduled.editTitle' : 'board.scheduled.newTitle')}</h3>
            <input required maxLength={240} value={form.text} onChange={event => setForm({ ...form, text: event.target.value })} placeholder={tr('board.scheduled.text')} aria-label={tr('board.scheduled.text')} className="w-full rounded border border-white/15 bg-black/20 px-2 py-1.5 text-app-text" />
            <div className="flex gap-2">
              <select value={form.status} onChange={event => setForm({ ...form, status: event.target.value as ScheduledCardInput['status'] })} aria-label={tr('board.scheduled.column')} className="min-w-0 flex-1 rounded border border-white/15 bg-app-bg px-2 py-1.5 text-app-text">
                {COLUMNS.map(status => <option key={status} value={status}>{STATUS_LABEL[status]}</option>)}
              </select>
              <select value={preset} onChange={event => {
                const value = event.target.value; setPreset(value);
                const [hour, minute] = presetTime.split(':');
                if (value === 'daily') setForm({ ...form, cron: `${Number(minute)} ${Number(hour)} * * *` });
                if (value === 'weekly') setForm({ ...form, cron: `${Number(minute)} ${Number(hour)} * * 1` });
                if (value === 'hourly') setForm({ ...form, cron: '0 * * * *' });
              }} aria-label={tr('board.scheduled.preset')} className="min-w-0 flex-1 rounded border border-white/15 bg-app-bg px-2 py-1.5 text-app-text">
                <option value="daily">{tr('board.scheduled.daily')}</option><option value="weekly">{tr('board.scheduled.weekly')}</option>
                <option value="hourly">{tr('board.scheduled.hourly')}</option><option value="custom">{tr('board.scheduled.custom')}</option>
              </select>
            </div>
            {(preset === 'daily' || preset === 'weekly') && <input type="time" value={presetTime} aria-label={tr('board.scheduled.time')} onChange={event => {
              const value = event.target.value; setPresetTime(value);
              const [hour, minute] = value.split(':');
              setForm({ ...form, cron: `${Number(minute)} ${Number(hour)} * * ${preset === 'weekly' ? '1' : '*'}` });
            }} className="rounded border border-white/15 bg-app-bg px-2 py-1.5 text-app-text" />}
            <input required value={form.cron} onChange={event => { setPreset('custom'); setForm({ ...form, cron: event.target.value }); }} aria-label={tr('board.scheduled.cron')} placeholder="0 9 * * 1" className="w-full rounded border border-white/15 bg-black/20 px-2 py-1.5 font-mono text-app-text" />
            <input required value={form.timeZone} onChange={event => setForm({ ...form, timeZone: event.target.value })} aria-label={tr('board.scheduled.timeZone')} className="w-full rounded border border-white/15 bg-black/20 px-2 py-1.5 text-app-text" />
            <input value={labelDraft} onChange={event => setLabelDraft(event.target.value)} aria-label={tr('board.scheduled.labels')} placeholder={tr('board.scheduled.labels')} className="w-full rounded border border-white/15 bg-black/20 px-2 py-1.5 text-app-text" />
            {error && <p role="alert" className="text-rose-300">{error}</p>}
            <div className="flex justify-end gap-2">
              {editing && <button type="button" onClick={reset} className="rounded px-2 py-1.5 text-app-text-secondary hover:bg-white/10">{tr('board.scheduled.cancel')}</button>}
              <button disabled={busy} type="submit" className="rounded bg-primary/20 px-3 py-1.5 text-primary hover:bg-primary/30 disabled:opacity-50">{tr(editing ? 'board.scheduled.save' : 'board.scheduled.create')}</button>
            </div>
          </form>
        </div>
      </Menu>
    </>
  );
}

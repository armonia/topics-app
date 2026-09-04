/**
 * La barra dell'obiettivo, sopra il composer (3.4).
 *
 * Perché prende il posto di `TodoStrip` invece di affiancarsi: sarebbero due
 * elenchi di cose da fare uno sopra l'altro, che è il modo più veloce per far
 * smettere l'umano di guardarli entrambi. Una superficie sola, con una
 * precedenza dichiarata: i passi PERSISTITI del goal se ci sono, altrimenti
 * l'ultimo `TodoWrite` del trascritto — che resta utile ma non sopravvive a una
 * compattazione, e infatti si vede che è preso in prestito («piano del turno»).
 *
 * L'obiettivo non ha una spunta «fatto» accanto ai passi: i passi li scrive
 * l'agente col suo piano, e una casella cliccabile prometterebbe che spuntarla
 * conta qualcosa. Quello che l'umano decide è se l'obiettivo è raggiunto,
 * abbandonato o cambiato — e quelle tre azioni ci sono.
 */

import { useState } from 'react';
import { useT } from '../../hooks/useT';
import { Check, ChevronRight, Pencil, Square, Target, X } from 'lucide-react';
import type { TopicGoal } from '../../types';
import type { TodoSnapshot } from './selectLatestTodo';
import { CHAT_STRIP_NEUTRAL } from '../../lib/chatStripStyles';

interface Props {
  goal: TopicGoal;
  /** Ripiego quando il goal non ha passi suoi: l'ultimo TodoWrite del turno. */
  fallback?: TodoSnapshot;
  onClose: (status: 'achieved' | 'abandoned') => void;
  onEdit: (content: string) => void;
  /** Stop the auto-continuation, leaving the objective alive. */
  onStopLoop?: () => void;
}

type Row = { content: string; status: 'pending' | 'in_progress' | 'completed' };

export function GoalBar({ goal, fallback, onClose, onEdit, onStopLoop }: Props) {
  const tr = useT();
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(goal.content);

  const own = goal.steps.length > 0;
  const rows: Row[] = own
    ? goal.steps.map((s) => ({ content: s.content, status: s.status }))
    : (fallback?.items ?? []).map((t) => ({
        content: t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content,
        status: t.status,
      }));
  const done = rows.filter((r) => r.status === 'completed').length;
  const active = rows.find((r) => r.status === 'in_progress');

  // THE STATE OF THE LOOP, which is not the state of the objective.
  //
  // An active goal may or may not be chased on its own at the end of a turn
  // (server/services/goal-loop.ts), and the difference shows up only here:
  // without it, the only way to know the chat was carrying on by itself was to
  // watch it start again. `chasing` is a live loop that has already spent
  // something, `waiting` is a loop stopped because it is the reader's turn.
  const chasing = goal.loopState === 'running' && goal.continuations > 0;
  const waiting = goal.loopState === 'blocked';

  function commit() {
    const next = draft.trim();
    setEditing(false);
    if (!next || next === goal.content) {
      setDraft(goal.content);
      return;
    }
    onEdit(next);
  }

  if (editing) {
    return (
      <div
        data-testid="goal-bar-edit"
        className={`${CHAT_STRIP_NEUTRAL} flex items-center gap-2 px-2.5 py-1.5`}
      >
        <Target size={13} className="flex-shrink-0 text-app-text-secondary" />
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') {
              setDraft(goal.content);
              setEditing(false);
            }
          }}
          className="min-w-0 flex-1 bg-transparent text-[12px] text-app-text outline-none"
          placeholder={tr('goal.placeholder')}
        />
      </div>
    );
  }

  return (
    <div
      data-testid="goal-bar"
      className={CHAT_STRIP_NEUTRAL}
    >
      <div className="flex items-center gap-2 px-2.5 py-1.5">
        <button
          type="button"
          onClick={() => rows.length && setExpanded((e) => !e)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          aria-expanded={expanded}
          title={goal.content}
        >
          {rows.length > 0 && (
            <ChevronRight
              size={13}
              className={`flex-shrink-0 text-app-text-muted transition-transform ${expanded ? 'rotate-90' : ''}`}
            />
          )}
          <Target size={13} className="flex-shrink-0 text-app-text-secondary" />
          <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-app-text">
            {goal.content}
          </span>
          {rows.length > 0 && (
            <span className="flex-shrink-0 text-[11px] tabular-nums text-app-text-muted">
              {done}/{rows.length}
            </span>
          )}
        </button>
        {(chasing || waiting) && (
          <span
            data-testid="goal-loop-state"
            className={`flex-shrink-0 text-[11px] tabular-nums ${waiting ? 'text-amber-500' : 'text-app-text-secondary'}`}
          >
            {waiting ? tr('goal.loop.waitingYou') : tr('goal.loop.continuing', { n: String(goal.continuations) })}
          </span>
        )}
        {chasing && onStopLoop && (
          <button
            type="button"
            data-testid="goal-loop-stop"
            onClick={onStopLoop}
            title={tr('goal.loop.stop')}
            className="flex-shrink-0 p-0.5 text-app-text-muted hover:text-app-text"
          >
            <Square size={11} />
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            setDraft(goal.content);
            setEditing(true);
          }}
          title="Cambia obiettivo"
          className="flex-shrink-0 p-0.5 text-app-text-muted hover:text-app-text"
        >
          <Pencil size={12} />
        </button>
        <button
          type="button"
          onClick={() => onClose('achieved')}
          title="Obiettivo raggiunto"
          className="flex-shrink-0 p-0.5 text-app-text-muted hover:text-green-500"
        >
          <Check size={13} />
        </button>
        <button
          type="button"
          onClick={() => onClose('abandoned')}
          title={tr('goal.abandon')}
          className="flex-shrink-0 p-0.5 text-app-text-muted hover:text-app-text"
        >
          <X size={12} />
        </button>
      </div>

      {!expanded && active && (
        <div className="truncate px-2.5 pb-1.5 pl-[38px] text-[11px] text-app-text-secondary">
          {active.content}
        </div>
      )}

      {expanded && rows.length > 0 && (
        <ul className="space-y-0.5 border-t border-app-border/50 px-2.5 py-1.5">
          {!own && (
            <li className="pb-0.5 text-[10px] uppercase tracking-wide text-app-text-muted">
              {tr('goal.notCompacted')}
            </li>
          )}
          {rows.map((r, i) => (
            <li key={i} className="flex items-start gap-2 text-[12px]">
              <span className="mt-0.5 flex-shrink-0">
                {r.status === 'completed' ? '✓' : r.status === 'in_progress' ? '◐' : '○'}
              </span>
              <span
                className={
                  r.status === 'completed'
                    ? 'text-app-text-muted line-through'
                    : r.status === 'in_progress'
                      ? 'font-medium text-app-text'
                      : 'text-app-text-secondary'
                }
              >
                {r.content}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

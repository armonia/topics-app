import { X } from 'lucide-react';
import { DANGER_TEXT } from '../../lib/popoverStyles';
import type { Translate } from '../../../../shared/queue-reason-text';
import type { SideQuestionState } from './useSideQuestion';

export function SideQuestionPanel({ state, onClose, tr }: { state: SideQuestionState; onClose: () => void; tr: Translate }) {
  return (
    <aside aria-live="polite" aria-label={tr('chat.btw.title')} className="mx-2 mb-2 rounded-lg border border-app-border bg-app-surface p-3 text-compact">
      <div className="mb-2 flex items-center justify-between gap-3">
        <strong>{tr('chat.btw.title')}</strong>
        <button type="button" aria-label={tr('chat.btw.close')} className="rounded p-1 text-app-text-secondary hover:bg-app-hover" onClick={onClose}><X size={16} /></button>
      </div>
      <div className="mb-2 text-app-text-secondary">{state.question}</div>
      {state.busy && <div role="status" className="text-app-text-secondary">{tr('chat.btw.loading')}</div>}
      {state.answer && <div className="whitespace-pre-wrap text-app-text">{state.answer}</div>}
      {state.error && <div role="alert" className={DANGER_TEXT}>{tr('chat.btw.error', { reason: state.error })}</div>}
    </aside>
  );
}

/**
 * SALUTE: one row per problem T7 found, with its sentence and the button that
 * opens the place where it is fixed. Fixing it takes the row away at the next
 * read, which the page asks for when it opens and every few seconds after.
 */
import { useEffect } from 'react';
import { RefreshCw, TriangleAlert, Check } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { DANGER_TEXT, WARNING_TEXT } from '../../lib/popoverStyles';
import { BTN } from '../Agents/AgentConfigPieces';
import { healthTarget, openHealthTarget } from './systemNav';
import { healthSentence } from './healthSentence';
import type { HealthProblem } from '../../../../shared/agents-health';

export function SystemHealth({ problems, reload }: { problems: HealthProblem[] | null; reload: () => Promise<void> }) {
  const tr = useT();
  useEffect(() => { void reload(); }, [reload]);
  return (
    <section data-testid="system-health" className="max-w-3xl">
      <div className="mb-3 flex items-center gap-2">
        <h2 className="flex-1 text-body font-semibold text-app-text">{tr('system.health.title')}</h2>
        <button type="button" data-testid="system-health-refresh" onClick={() => { void reload(); }} className={BTN}>
          <RefreshCw size={12} aria-hidden="true" className="mr-1 inline" />{tr('system.health.refresh')}
        </button>
      </div>
      {problems === null ? (
        <p className="text-prose text-app-text-muted">{tr('system.reading')}</p>
      ) : problems.length === 0 ? (
        <p data-testid="system-health-clear" className="flex items-center gap-2 text-prose text-app-text-secondary">
          <Check size={14} aria-hidden="true" />{tr('system.health.clear')}
        </p>
      ) : (
        <ul className="space-y-2">
          {problems.map((p) => (
            <li key={p.id} data-testid="system-health-row" data-severity={p.severity} className="flex items-start gap-2 rounded border border-app-border p-2.5">
              <TriangleAlert size={14} aria-hidden="true" className={`mt-0.5 flex-shrink-0 ${p.severity === 'error' ? DANGER_TEXT : WARNING_TEXT}`} />
              <span className="min-w-0 flex-1 text-prose text-app-text">{healthSentence(tr, p)}</span>
              <button type="button" data-testid="system-health-open" onClick={() => openHealthTarget(healthTarget(p.destination))} className={BTN}>{tr('system.health.open')}</button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

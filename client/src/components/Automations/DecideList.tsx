/**
 * «Decidi tu»: what is broken or waits on you, oldest first. Each row says
 * why, how many runs in a row failed, what you could lose while it stays so
 * (the hub's purpose table), the brake that holds an agent sent on it, and
 * carries «Fix it», «Retry» on an OpenClaw job and the run on GitHub.
 *
 * A workflow step waiting for your ok is not here: no agent can fix it. The
 * note under the list counts them and says where the ones that are yours go.
 */
import { useState } from 'react';
import { AlertTriangle, CircleX, ExternalLink, Hand, Play, WandSparkles } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { DANGER_TEXT, WARNING_TEXT } from '../../lib/popoverStyles';
import { failStreak, ifBrokenToYou, type AutomationRow } from '../../lib/automations';
import type { AutomationsData } from './useAutomationsData';
import { BOX, BUTTON, BUTTON_PRIMARY, SECTION, SECTION_COUNT, SECTION_REST } from './automationsUi';
import { ProjectMark } from './AutomationMarks';

interface Props {
  rows: AutomationRow[];
  gates: number;
  selectedKey: string | null;
  data: AutomationsData;
  onSelect(r: AutomationRow): void;
  onRun(r: AutomationRow): void;
}

export function DecideList({ rows, gates, selectedKey, data, onSelect, onRun }: Props) {
  const tr = useT();
  const [said, setSaid] = useState<Record<string, string>>({});
  const brakes = data.model?.brakes ?? {};
  return (
    <>
      {rows.length > 0 && (
        <>
          <h2 className={`${SECTION} ${WARNING_TEXT}`}>
            <AlertTriangle size={13} aria-hidden="true" />{tr('auto.decide.title')}
            <span className={SECTION_COUNT}>{rows.length}</span>
            <span className={SECTION_REST}>{tr('auto.decide.order')}</span>
          </h2>
          <div className={BOX} data-testid="automations-decide">
            {rows.map((r) => {
              const isSelected = r.key === selectedKey;
              const streak = r.level === 'rotto' ? failStreak(r) : 0;
              const sub = [r.reason, streak > 1 ? tr('auto.decide.streak', { n: streak }) : null, tr(`auto.system.${r.system}`), r.when].filter(Boolean).join(' · ');
              const brake = brakes[r.key]?.text ?? null;
              const gh = r.system === 'github' ? r.tech.url : null;
              return (
                <div
                  key={r.key}
                  data-testid="automations-decide-row"
                  data-key={r.key}
                  className={`flex items-center gap-2.5 border-t border-app-border-subtle px-3 py-2.5 first:border-t-0 @max-2xl:flex-wrap @max-2xl:py-3 ${isSelected ? 'bg-primary/10 shadow-[inset_2px_0_0_var(--primary)]' : ''}`}
                >
                  <span className={`flex-none ${r.level === 'rotto' ? DANGER_TEXT : WARNING_TEXT}`} aria-hidden="true">
                    {r.level === 'rotto' ? <CircleX size={15} /> : <AlertTriangle size={15} />}
                  </span>
                  <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onSelect(r)}>
                    <span className="flex items-center gap-1.5 text-compact font-medium text-app-text"><ProjectMark project={r.project} />{r.title}</span>
                    <span className="mt-0.5 block text-mini text-app-text-secondary" data-testid="automations-decide-sub">{said[r.key] ?? sub}</span>
                    {r.ifBroken && <span className="mt-0.5 block text-mini text-app-text-muted" data-testid="automations-decide-ifbroken">{tr('auto.decide.ifBroken', { what: ifBrokenToYou(r.ifBroken) })}</span>}
                    {brake && <span className="mt-0.5 block text-mini text-primary" data-testid="automations-decide-brake">{brake}</span>}
                  </button>
                  <div className="flex flex-none items-center gap-1.5 @max-2xl:w-full @max-2xl:pl-6">
                    {r.votable && (
                      data.fixing.has(r.key) ? (
                        <span className="text-mini text-primary" data-testid="automations-decide-fixing">{tr('auto.fix.already')}</span>
                      ) : (
                        <button
                          type="button"
                          className={`${BUTTON_PRIMARY} @max-2xl:flex-1`}
                          disabled={data.hubDown}
                          data-testid="automations-decide-fix"
                          onClick={() => { void data.fix(r.key).then((x) => setSaid((p) => ({ ...p, [r.key]: x.ok ? tr(x.already ? 'auto.fix.already' : 'auto.fix.queued') : tr('auto.fix.failed', { why: x.why ?? '' }) }))); }}
                        >
                          <WandSparkles size={13} />{tr('auto.fix.go')}
                        </button>
                      )
                    )}
                    {r.jobId !== null && (
                      <button type="button" className={`${BUTTON} @max-2xl:flex-1`} disabled={data.gatewayDown || r.enabled === null} onClick={() => onRun(r)} data-testid="automations-decide-run">
                        <Play size={13} />{tr('auto.cmd.retry')}
                      </button>
                    )}
                    {gh && (
                      <a href={gh} target="_blank" rel="noopener noreferrer" className={`${BUTTON} @max-2xl:flex-1`} data-testid="automations-decide-github">
                        GitHub<ExternalLink size={12} aria-hidden="true" />
                      </a>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
      {gates > 0 && (
        <p className="m-0 mt-2 flex items-center gap-1.5 text-mini text-app-text-secondary" data-testid="automations-gates">
          <Hand size={13} className={WARNING_TEXT} aria-hidden="true" />
          {tr(gates === 1 ? 'auto.gates.one' : 'auto.gates.many', { n: gates })}
        </p>
      )}
    </>
  );
}

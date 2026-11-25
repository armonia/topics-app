import { CI_PHASE_MODES, type CiPhaseMode } from '../../../../shared/workflow';
import { useT } from '../../hooks/useT';

/**
 * When accepted work meets the CI, three choices with their own sentence:
 * before the land (measured with main, then it lands), after it (it lands
 * at once, the CI reads main and a red goes back to the agent), or never.
 * The caller writes the pick; this only draws it.
 */
export function CiPhaseControl({ mode, onPick, chip }: {
  mode: CiPhaseMode;
  onPick: (mode: CiPhaseMode) => void;
  chip: (on: boolean) => string;
}) {
  const tr = useT();
  return (
    <div className="space-y-1" title={tr('board.settings.workflow.ciTitle')}>
      <div className="flex items-center justify-between gap-2">
        <span>{tr('board.settings.workflow.ci')}</span>
        <div className="flex gap-0.5">
          {CI_PHASE_MODES.map((m) => (
            <button key={m} type="button" data-testid={`board-workflow-ci-${m}`} onClick={() => onPick(m)} className={chip(mode === m)}>
              {tr(`board.settings.workflow.ci.${m}`)}
            </button>
          ))}
        </div>
      </div>
      <p className="text-mini text-app-text-muted" data-testid="board-workflow-ci-hint">{tr(`board.settings.workflow.ci.${mode}.hint`)}</p>
    </div>
  );
}

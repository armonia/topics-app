import { type AppBehaviorSettings } from '../../lib/api';
import { ToggleRow } from './ToggleRow';
import { useT } from '@/hooks/useT';

/**
 * The switch for automatic per-turn checkpoints.
 *
 * It sits next to the runtime choice because it is the same question from the
 * other side: there you decide HOW the agent is run, here what happens to the
 * tree BEFORE it writes. Ahead of every turn Topics photographs the worktree
 * onto a dedicated ref (`refs/topics/checkpoints/<session>/<seq>`), and
 * `/rewind` in chat puts it back without detaching HEAD.
 *
 * OFF UNTIL YOU TURN IT ON, and that is not timidity. The feature writes git
 * objects into a repository that belongs to somebody else, once per turn the
 * agent takes: it has to arrive without touching anyone. Here "nobody decided"
 * means no.
 *
 * THE COPY SAYS THE PART THAT TENDS TO GO UNSAID: the tree comes back, the
 * conversation does not. Two different promises, Topics keeps the first, and
 * whoever assumes the second finds out at the worst possible moment.
 */
export function TurnCheckpointsChoice({
  settings, saving, onSave,
}: {
  settings: AppBehaviorSettings;
  saving: boolean;
  onSave: (patch: Partial<AppBehaviorSettings>) => Promise<void>;
}) {
  const tr = useT();
  return (
    <div className="mb-3 rounded-lg border border-app-border bg-surface/40 px-3 py-1">
      <ToggleRow
        label={tr('settings.turnCheckpoints.label')}
        description={tr('settings.turnCheckpoints.blurb')}
        value={settings.turnCheckpointsEnabled === true}
        onChange={(v) => {
          void onSave({ turnCheckpointsEnabled: v }).catch(() => { /* the section renders the error */ });
        }}
      />
      {saving && <div className="pb-1 text-[11px] text-app-text-muted">{tr('settings.turnCheckpoints.saving')}</div>}
    </div>
  );
}

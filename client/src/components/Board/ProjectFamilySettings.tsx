import { useT } from '../../hooks/useT';
import type { useProjectFamily } from '../../hooks/useProjectFamily';
import { projectDisplayName } from '../../lib/projectFamilyApi';
import { Segmented } from '../Shared/Segmented';
import type { MergeMode } from '../../../../shared/project-family';

/**
 * The board settings rows for accorpa / separa. The state and the gestures come
 * from `useProjectFamily` (called by the panel, before its early return); this
 * only draws them. A project with merged children has nothing to set here: the
 * switch lives on each child.
 */
export function ProjectFamilySettings({ family }: { family: ReturnType<typeof useProjectFamily> }) {
  const tr = useT();
  const { own, parent, choices, busy, apply } = family;
  if (!own) return null;

  if (parent) {
    return (
      <div className="space-y-1.5" data-testid="project-family-settings">
        <p className="text-app-text-secondary">{tr('family.panel.under', { parent: projectDisplayName(parent) })}</p>
        <Segmented<MergeMode>
          value={own.mergeMode ?? 'accorpa'}
          options={[{ value: 'accorpa', label: tr('family.mode.accorpa') }, { value: 'separa', label: tr('family.mode.separa') }]}
          onChange={(mergeMode) => { void apply({ mergeMode }); }}
          ariaLabel={tr('family.panel.mode')}
          testId="project-family-mode"
          disabled={busy}
        />
        <button
          type="button"
          disabled={busy}
          onClick={() => { void apply({ parentId: null }); }}
          className="rounded px-1.5 py-0.5 text-mini text-app-text-secondary hover:bg-black/5 dark:hover:bg-white/10 coarse:min-h-11"
          data-testid="project-family-detach"
        >{tr('family.detach', { parent: projectDisplayName(parent) })}</button>
      </div>
    );
  }

  if (family.hasChildren) {
    return <p className="text-app-text-secondary" data-testid="project-family-settings">{tr('family.panel.hasChildren')}</p>;
  }

  const options = [...choices.suggested, ...choices.others];
  if (options.length === 0) return null;
  return (
    <label className="flex flex-col gap-1" data-testid="project-family-settings">
      <span className="text-app-text-secondary">{tr('family.merge')}</span>
      <select
        disabled={busy}
        value=""
        onChange={(e) => { if (e.target.value) void apply({ parentId: e.target.value, mergeMode: 'accorpa' }); }}
        className="w-full rounded bg-black/5 dark:bg-white/5 px-1.5 py-1 text-compact text-app-text outline-none coarse:min-h-11"
        data-testid="project-family-parent"
      >
        <option value="">{tr('family.panel.choose')}</option>
        {choices.suggested.length > 0 && (
          <optgroup label={tr('family.suggested')}>
            {choices.suggested.map((r) => <option key={r.id} value={r.id}>{projectDisplayName(r)}</option>)}
          </optgroup>
        )}
        {choices.others.length > 0 && (
          <optgroup label={tr('family.others')}>
            {choices.others.map((r) => <option key={r.id} value={r.id}>{projectDisplayName(r)}</option>)}
          </optgroup>
        )}
      </select>
    </label>
  );
}

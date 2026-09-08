import { AlertCircle } from 'lucide-react';
import { type AppBehaviorSettings, type AgentRuntime } from '../../lib/api';
import { DEFAULT_AGENT_RUNTIME } from '../../../../shared/types';
import { useT } from '../../hooks/useT';
import { SettingSelect } from './SettingSelect';

/** Execution is independent from the API used for chat. Native Topics
 * currently runs Claude only and still needs existing Claude login credentials. */
export function AgentRuntimeChoice({
  settings, saving, registered, onSave,
}: {
  settings: AppBehaviorSettings;
  saving: boolean;
  registered: boolean;
  onSave: (patch: Partial<AppBehaviorSettings>) => Promise<void>;
}) {
  const t = useT();
  // Il ripiego arriva dalla costante condivisa, non da una stringa a mano: la
  // riga qui sotto decide se mostrare l'avviso «scelto ma non c'è», e con un
  // `?? 'cli'` fossilizzato l'avviso spariva proprio per chi non ha scelto —
  // cioè per quasi tutti, cioè proprio per chi ha più bisogno di vederlo.
  const chosen = settings.agentRuntime ?? DEFAULT_AGENT_RUNTIME;
  return (
    <div className="space-y-2">
      <SettingSelect
        label={t('runtime.label')}
        hint={t('runtime.hint')}
        value={settings.agentRuntime}
        disabled={saving}
        autoLabel={t('runtime.topicsDefault')}
        onChange={(v) => { void onSave({ agentRuntime: v as AgentRuntime | null }).catch(() => { /* l'errore lo mostra la scheda */ }); }}
        options={[
          { value: 'topics', label: t('runtime.topics') },
          { value: 'cli', label: t('runtime.cli') },
          { value: 'jcode', label: t('runtime.jcode') },
        ]}
      />
      <p className="text-[11px] text-app-text-muted break-words">{t('runtime.blurb')}</p>
      {(chosen === 'jcode' || chosen === 'topics') && !registered && (
        <div data-testid="agent-runtime-unavailable" className="mt-1.5 flex items-center gap-2 text-[11px] text-app-text-muted border border-dashed border-app-border rounded-md px-2 py-1.5">
          <AlertCircle size={12} className="flex-shrink-0" />
          <span className="flex-1 break-words">
            {chosen === 'topics'
              ? t('runtime.defaultUnavailable')
              : t('runtime.missing')}
          </span>
        </div>
      )}
    </div>
  );
}

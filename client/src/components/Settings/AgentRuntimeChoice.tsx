import { AlertCircle } from 'lucide-react';
import { type AppBehaviorSettings, type AgentRuntime } from '../../lib/api';
import { useT } from '../../hooks/useT';
import { SettingSelect } from './SettingSelect';

/**
 * COME si esegue un agente, che è una domanda diversa da CHI risponde.
 *
 * Sta in cima alla scheda e non dentro una card perché non appartiene a nessun
 * provider: governa la meccanica con cui tutte le righe qui sotto vengono
 * eseguite. `cli` è una CLI per sessione in una PTY; `jcode` manda le sessioni
 * dentro un demone condiviso via ACP.
 *
 * Il numero è nel testo, e ci sta per un motivo: è tutta la ragione per cui
 * l'interruttore esiste, ed è misurato su questa macchina, non stimato. Senza
 * il numero la scelta sembra una preferenza di gusto, e nessuno la cambierebbe.
 *
 * Detto com'è, non com'è comodo: il provider si registra all'AVVIO del server
 * (`initProviders`), quindi la scelta vale da lì. Prometterla immediata
 * significherebbe che chi la cambia e non vede cambiare nulla pensa sia rotta.
 */
export function AgentRuntimeChoice({
  settings, saving, registered, onSave,
}: {
  settings: AppBehaviorSettings;
  saving: boolean;
  registered: boolean;
  onSave: (patch: Partial<AppBehaviorSettings>) => Promise<void>;
}) {
  const t = useT();
  const chosen = settings.agentRuntime ?? 'cli';
  return (
    <div className="mb-3 rounded-lg border border-app-border bg-surface/40 px-3 py-2">
      <SettingSelect
        label={t('runtime.label')}
        hint={t('runtime.hint')}
        value={settings.agentRuntime}
        disabled={saving}
        autoLabel={t('runtime.cliDefault')}
        onChange={(v) => { void onSave({ agentRuntime: v as AgentRuntime | null }).catch(() => { /* l'errore lo mostra la scheda */ }); }}
        options={[
          { value: 'cli', label: t('runtime.cli') },
          { value: 'jcode', label: t('runtime.jcode') },
        ]}
      />
      <p className="text-[11px] text-app-text-muted break-words">{t('runtime.blurb')}</p>
      {chosen === 'jcode' && !registered && (
        <div className="mt-1.5 flex items-center gap-2 text-[11px] text-app-text-muted border border-dashed border-app-border rounded-md px-2 py-1.5">
          <AlertCircle size={12} className="flex-shrink-0" />
          {/* Scelto ma non presente fra le righe: o il server non è ancora
              ripartito, o `jcode` non è nel PATH — il registro salta gli agenti
              ACP il cui eseguibile non c'è. Sono i due casi veri, e nessuno dei
              due si vede senza dirlo. */}
          <span className="flex-1 break-words">{t('runtime.missing')}</span>
        </div>
      )}
    </div>
  );
}

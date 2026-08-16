import { AlertCircle } from 'lucide-react';
import { type AppBehaviorSettings, type AgentRuntime } from '../../lib/api';
import { DEFAULT_AGENT_RUNTIME } from '../../../../shared/types';
import { useT } from '../../hooks/useT';
import { SettingSelect } from './SettingSelect';

/**
 * COME si esegue un agente, che è una domanda diversa da CHI risponde.
 *
 * Sta in cima alla scheda e non dentro una card perché non appartiene a nessun
 * provider: governa la meccanica con cui tutte le righe qui sotto vengono
 * eseguite. `cli` è una CLI per sessione in una PTY; `jcode` manda le sessioni
 * dentro un demone condiviso via ACP; `topics` è il runtime nativo — nessun
 * programma esterno, la sessione vive dentro il server — ed è il default.
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
  // Il ripiego arriva dalla costante condivisa, non da una stringa a mano: la
  // riga qui sotto decide se mostrare l'avviso «scelto ma non c'è», e con un
  // `?? 'cli'` fossilizzato l'avviso spariva proprio per chi non ha scelto —
  // cioè per quasi tutti, cioè proprio per chi ha più bisogno di vederlo.
  const chosen = settings.agentRuntime ?? DEFAULT_AGENT_RUNTIME;
  return (
    <div className="mb-3 rounded-lg border border-app-border bg-surface/40 px-3 py-2">
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
        <div className="mt-1.5 flex items-center gap-2 text-[11px] text-app-text-muted border border-dashed border-app-border rounded-md px-2 py-1.5">
          <AlertCircle size={12} className="flex-shrink-0" />
          {/* Due frasi, perché sono due situazioni diverse e dirle uguali
              sarebbe allarmare la persona sbagliata.

              CHI L'HA SCELTO ha un problema: ha chiesto jcode e gli agenti non
              ci stanno andando — o il server non è ancora ripartito, o
              l'eseguibile non è nel PATH (il registro salta gli agenti ACP
              senza binario). Va detto, è la sua richiesta disattesa.

              CHI NON HA SCELTO NIENTE non ha nessun problema: prende il default
              perché è il default, e sulla sua macchina jcode non c'è. Gli
              agenti girano sulla CLI esattamente come prima e non è rotto
              niente. Dirgli «scelto, ma non disponibile» significherebbe
              accusarlo di una scelta che non ha fatto e mandarlo a cercare un
              guasto che non esiste: qui è un'INFORMAZIONE, non un avviso. */}
          <span className="flex-1 break-words">
            {settings.agentRuntime ? t('runtime.missing') : t('runtime.defaultUnavailable')}
          </span>
        </div>
      )}
    </div>
  );
}

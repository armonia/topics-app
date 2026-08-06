import { useEffect, useState } from 'react';
import { Sparkles, Terminal } from 'lucide-react';
import { slashCommandsApi } from '../../lib/api';

/**
 * «Questo turno sta girando la skill X».
 *
 * Quando lanci `/recap`, la CLI espande il comando PRIMA del turno: sul filo non
 * torna nessun `tool_use` (verificato), quindi non c'è nessuna riga di tool da
 * mostrare. Prima il segnale c'era per sbaglio — il corpo del comando colava
 * dentro la risposta — e toglierlo ha lasciato il turno muto.
 *
 * Questa riga NON finge una chiamata a un tool: non nasce da `tool_calls`, non
 * viene salvata, non ha un corpo da aprire. Dice l'unica cosa che Topics sa per
 * certo — quale comando hai lanciato — nel posto dove la si cercava.
 *
 * Skill o comando lo dice il registro (`/api/slash-commands`, campo `kind`):
 * quando non lo sappiamo ancora, si resta sul termine neutro invece di
 * indovinare.
 */

/** Il registro è già in cache nel modulo dell'API: qui si legge e basta. */
function useCommandKind(name: string): 'command' | 'skill' | null {
  const [kind, setKind] = useState<'command' | 'skill' | null>(null);
  useEffect(() => {
    let alive = true;
    slashCommandsApi
      .list()
      .then((list) => {
        if (!alive) return;
        const hit = list.find((c) => c.name === name);
        setKind(hit?.kind ?? null);
      })
      .catch(() => { /* registro non raggiungibile: si resta sul neutro */ });
    return () => { alive = false; };
  }, [name]);
  return kind;
}

export function InvokedCommandRow({ command, args }: { command: string; args?: string }) {
  const kind = useCommandKind(command);
  const isSkill = kind === 'skill';
  const Icon = isSkill ? Sparkles : Terminal;
  return (
    <div
      data-testid="invoked-command-row"
      data-command={command}
      data-kind={kind ?? 'unknown'}
      className="text-[12px] flex items-center gap-2 py-1 text-app-text-secondary"
      title={`Questo turno gira ${isSkill ? 'la skill' : 'il comando'} /${command}`}
    >
      {/* Il posto del chevron resta vuoto: questa riga non si apre, ma parte
          dalla stessa colonna delle righe di azione che le stanno sotto. */}
      <span className="w-3 flex-shrink-0" aria-hidden="true" />
      <Icon size={13} className="flex-shrink-0 text-app-text-muted" />
      <span className="flex-1 min-w-0 flex items-baseline gap-1">
        <span className="flex-shrink-0 font-medium text-app-text">{isSkill ? 'Skill' : 'Comando'}</span>
        <span className="min-w-0 flex items-baseline text-[11px] text-app-text-secondary font-mono">
          <span className="flex-shrink-0">(</span>
          <span className="truncate">/{command}{args ? ` ${args}` : ''}</span>
          <span className="flex-shrink-0">)</span>
        </span>
      </span>
    </div>
  );
}

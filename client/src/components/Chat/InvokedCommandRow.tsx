import { useEffect, useState } from 'react';
import { useT } from '@/hooks/useT';
import { ChevronDown, ChevronRight, Sparkles, Terminal } from 'lucide-react';
import { slashCommandsApi } from '../../lib/api';

/**
 * «Questo turno gira /recap» — e cosa c'è dentro /recap.
 *
 * Quando lanci un comando, la CLI lo espande PRIMA del turno: sul filo non
 * torna nessun `tool_use` e nessun testo (verificato), quindi non c'è nessuna
 * riga di tool da mostrare. Prima il segnale c'era per sbaglio — il corpo del
 * comando colava dentro la risposta — e toglierlo aveva lasciato il turno muto.
 *
 * La riga NON finge una chiamata a un tool: non nasce da `tool_calls`, non si
 * salva, e il corpo non è «il risultato» di niente. È il FILE del comando,
 * letto dal disco su richiesta — la stessa cartella da cui Topics ricava
 * l'elenco dei comandi. È il file com'è ADESSO, non una fotografia di quando è
 * girato: su un comando lanciato un minuto fa è la stessa cosa, su una chat di
 * sei mesi fa può non esserlo — sta nel titolo del corpo, non come etichetta a
 * schermo, perché è una precisazione per chi se la chiede.
 *
 * L'intestazione è il comando e basta — `/recap` — non «Skill (/recap)»: il
 * nome della categoria non aggiunge niente che il resto della riga non dica.
 */
export function InvokedCommandRow({ command, args }: { command: string; args?: string }) {
  const tr = useT();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<'command' | 'skill' | null>(null);
  const [body, setBody] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Il registro è già in cache nel modulo dell'API: qui si legge il tipo per
  // scegliere l'icona, senza una richiesta in più.
  useEffect(() => {
    let alive = true;
    slashCommandsApi.list()
      .then((list) => { if (alive) setKind(list.find((c) => c.name === command)?.kind ?? null); })
      .catch(() => { /* registro non raggiungibile: icona neutra */ });
    return () => { alive = false; };
  }, [command]);

  // Il corpo si scarica alla PRIMA apertura: una chat lunga non deve leggere
  // dal disco un file per ogni comando che contiene.
  useEffect(() => {
    if (!open || body !== null || error) return;
    let alive = true;
    slashCommandsApi.source(command)
      .then((src) => { if (alive) setBody(src.body); })
      .catch(() => { if (alive) setError('Il file di questo comando non è più leggibile.'); });
    return () => { alive = false; };
  }, [open, command, body, error]);

  const Icon = kind === 'skill' ? Sparkles : Terminal;

  return (
    <div data-testid="invoked-command-row" data-command={command} data-kind={kind ?? 'unknown'} className="text-[12px]">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={tr('cmd.runs', { what: kind === 'skill' ? tr('cmd.kind.skill') : tr('cmd.kind.command'), name: command })}
        className="w-full flex items-center gap-2 py-1 text-left text-app-text-secondary hover:text-app-text transition-colors"
      >
        {open
          ? <ChevronDown size={12} className="text-app-text-muted flex-shrink-0" />
          : <ChevronRight size={12} className="text-app-text-muted flex-shrink-0" />}
        <Icon size={13} className="flex-shrink-0 text-app-text-muted" />
        <span className="flex-1 min-w-0 flex items-baseline gap-1 font-mono">
          <span className="flex-shrink-0 font-medium text-app-text">/{command}</span>
          {args && <span className="min-w-0 truncate text-[11px] text-app-text-secondary">{args}</span>}
        </span>
      </button>
      {open && (
        // Niente etichetta sopra il corpo: l'intestazione dice già `/recap`, e
        // aperta la riga non può mostrare altro che il suo contenuto. La nota
        // che è il file com'è ADESSO — e non com'era quando è girato — sta nel
        // titolo, dove chi se lo chiede la trova e chi no non la legge.
        <div className="ml-5 pb-1.5 space-y-1">
          {error ? (
            <div className="text-[11px] text-amber-600 dark:text-amber-400">{error}</div>
          ) : body === null ? (
            <div className="text-[11px] italic text-app-text-muted">Leggo il file…</div>
          ) : (
            <pre
              data-testid="invoked-command-body"
              title={tr('cmd.currentFile', { name: command })}
              className="tool-card-code text-[11px] font-mono text-app-text-secondary whitespace-pre-wrap overflow-auto max-h-72 bg-app-hover/40 rounded px-2 py-1.5"
            >
              {body}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

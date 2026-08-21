import { useEffect, useState } from 'react';
import { useT } from '../../hooks/useT';
import { ChevronDown, ChevronRight, Sparkles, Terminal } from 'lucide-react';
import { slashCommandsApi } from '../../lib/api';

/**
 * «Hai lanciato /recap» — e cosa c'è dentro /recap. UNA volta sola.
 *
 * Quando lanci un comando, la CLI lo espande PRIMA del turno: sul filo non
 * torna nessun `tool_use` e nessun testo (verificato), quindi non c'è nessuna
 * riga di tool da mostrare. Prima il segnale c'era per sbaglio — il corpo del
 * comando colava dentro la risposta — e toglierlo aveva lasciato il turno muto.
 *
 * Il rimedio di allora però ne disegnava DUE: il tuo messaggio si leggeva come
 * un comando (il chip qui sotto) **e** la risposta apriva con una riga
 * «questo turno gira /compact». Stesso nome, stessa icona, una sopra l'altra a
 * un centimetro di distanza, e nessuna delle due diceva qualcosa che l'altra
 * non dicesse. Chi guardava vedeva il proprio comando due volte e non capiva se
 * fosse partito due volte.
 *
 * Ne resta uno, ed è quello che sta nel posto giusto: il MESSAGGIO che hai
 * scritto tu. È l'unico che sa la verità (il resto del turno non porta traccia
 * del comando) e non finge una chiamata a un tool che non c'è stata. Il corpo
 * del comando — che era la sola cosa in più della riga sparita — si apre da
 * qui: è il FILE del comando, letto dal disco su richiesta, la stessa cartella
 * da cui Topics ricava l'elenco dei comandi. È il file com'è ADESSO, non una
 * fotografia di quando è girato: su un comando lanciato un minuto fa è la
 * stessa cosa, su una chat di sei mesi fa può non esserlo — sta nel titolo del
 * corpo, non come etichetta a schermo, perché è una precisazione per chi se la
 * chiede.
 */
export function SlashCommandChip({ command, args }: { command: string; args?: string }) {
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
    <span
      data-testid="user-slash-command"
      data-command={command}
      data-kind={kind ?? 'unknown'}
      className="block"
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        data-testid="user-slash-command-toggle"
        title={tr('cmd.ran', { what: kind === 'skill' ? tr('cmd.kind.skill') : tr('cmd.kind.command'), name: command })}
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 font-mono text-[0.92em] text-left"
      >
        <Icon size={12} className="flex-shrink-0 opacity-70" />
        <span className="font-medium">/{command}</span>
        {args && <span className="opacity-80">{args}</span>}
        {open
          ? <ChevronDown size={12} className="flex-shrink-0 opacity-60" />
          : <ChevronRight size={12} className="flex-shrink-0 opacity-60" />}
      </button>
      {open && (
        // Niente etichetta sopra il corpo: l'intestazione dice già `/recap`, e
        // aperta la riga non può mostrare altro che il suo contenuto. La nota
        // che è il file com'è ADESSO — e non com'era quando è girato — sta nel
        // titolo, dove chi se lo chiede la trova e chi no non la legge.
        <span className="mt-1 block">
          {error ? (
            <span className="block text-[11px] text-amber-600 dark:text-amber-400">{error}</span>
          ) : body === null ? (
            <span className="block text-[11px] italic opacity-70">Leggo il file…</span>
          ) : (
            <pre
              data-testid="invoked-command-body"
              title={tr('cmd.currentFile', { name: command })}
              className="tool-card-code text-[11px] font-mono whitespace-pre-wrap overflow-auto max-h-72 bg-black/10 dark:bg-black/20 rounded px-2 py-1.5"
            >
              {body}
            </pre>
          )}
        </span>
      )}
    </span>
  );
}

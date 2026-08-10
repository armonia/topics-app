import { useEffect, useMemo, useRef, useState } from 'react';
import { scriptsApi } from '../lib/api';
import { shellProcessKey, stripBackgroundShellBanner } from '../../../shared/background-shell-registry';
import { useScripts } from './useScripts';

/**
 * Lo stato VIVO di una shell lasciata in background dall'agente.
 *
 * La card della chat mostrava lo scatto del momento in cui il tool ha
 * risposto: un ricordo, non uno stato. La shell invece resta — cresce, muore,
 * esce con un codice — e tutto questo il server lo sa già: `registerBackgroundShell`
 * la mette nel registro dei processi (`routes/processes.ts`), `noteBackgroundShellOutput`
 * le attacca l'output nuovo a ogni `BashOutput`, e la stessa coda che legge il
 * pannello Processi è leggibile da qui.
 *
 * Quindi questo hook non inventa un canale: aggancia la card allo stesso
 * registro, per id. Se la shell non è nel registro — chat vecchia riaperta,
 * server riavviato, id non riconosciuto — torna `known: false` e la card
 * resta esattamente com'era prima. Nessuna card peggiora, alcune migliorano.
 */

export interface LiveBackgroundShell {
  /** La shell risulta al registro (altrimenti la card resta statica). */
  known: boolean;
  /** `running` finché vive; poi `done`/`error` come nel pannello Processi. */
  status: 'running' | 'done' | 'error' | null;
  exitCode?: number;
  /** La coda del log, senza l'intestazione del registro. Può essere vuota. */
  output: string;
  /** Righe che il ring buffer del server ha buttato prima che arrivassero qui. */
  truncatedLines: number;
}

const IDLE: LiveBackgroundShell = { known: false, status: null, output: '', truncatedLines: 0 };

/** Ogni quanto si rilegge la coda di una shell VIVA. Le morte non si rileggono. */
const TAIL_POLL_MS = 2000;
/** Tetto lato client: il ring buffer da 500KB è del server, qui si sommano i delta. */
const MAX_TAIL_CHARS = 100_000;

/**
 * Quale voce del registro è LA shell di questa card.
 *
 * Prima la chiave ESATTA (sessione + id): due chat diverse chiamano `bash_1` la
 * loro prima shell, e senza la sessione la card di una mostrerebbe l'output
 * dell'altra — che è peggio di non mostrare niente. Il ripiego per solo
 * `shellId` esiste per le chat riaperte senza sessionKey a portata, e scatta
 * SOLO quando quell'id è unico nel registro: se c'è ambiguità si preferisce la
 * card statica di prima.
 *
 * A parità di chiave vince la voce viva: la stessa shell può comparire due
 * volte, viva e poi fra le «recenti».
 */
export function pickShellEntry<T extends { processId: string; source?: string; shellId?: string; status: string }>(
  scripts: T[],
  shellId: string | undefined,
  sessionKey?: string,
): T | undefined {
  if (!shellId) return undefined;
  const shells = scripts.filter(s => s.source === 'shell' && s.shellId === shellId);
  if (sessionKey) {
    const key = shellProcessKey(sessionKey, shellId);
    const exact = shells.filter(s => s.processId === key);
    if (exact.length) return exact.find(s => s.status === 'running') ?? exact[0];
    // La sessione c'era ma non corrisponde a niente: fermarsi qui è voluto —
    // ripiegare sull'id porterebbe dritti alla shell di un'altra chat.
    if (shells.length) return undefined;
  }
  const keys = new Set(shells.map(s => s.processId));
  if (keys.size !== 1) return undefined;
  return shells.find(s => s.status === 'running') ?? shells[0];
}

export function useBackgroundShell(shellId: string | undefined, sessionKey?: string): LiveBackgroundShell {
  // `useScripts` è un singleton condiviso: N card sullo stesso schermo
  // pagano UN poll, non N. Senza `onMessage` non tocca lo stato della WS.
  const { allScripts } = useScripts();
  // `pending` (l'ultima riga non ancora chiusa da `\n`) sta FUORI da `output`:
  // si mostra ma non si accumula, altrimenti si rivedrebbe una seconda volta
  // quando arriva completa.
  const [tail, setTail] = useState<{ output: string; pending: string; truncatedLines: number }>(
    { output: '', pending: '', truncatedLines: 0 },
  );

  const entry = useMemo(
    () => pickShellEntry(allScripts, shellId, sessionKey),
    [allScripts, shellId, sessionKey],
  );

  const processId = entry?.processId;
  const isRunning = entry?.status === 'running';

  // Cursore ASSOLUTO (righe dall'inizio), non indice nel buffer: il buffer si
  // accorcia da sotto — stessa disciplina di `ProcessLogPane`.
  const offsetRef = useRef(0);
  useEffect(() => {
    offsetRef.current = 0;
    setTail({ output: '', pending: '', truncatedLines: 0 });
  }, [processId]);

  useEffect(() => {
    if (!processId) return;
    let active = true;
    let inFlight = false;

    const poll = async () => {
      if (!active || inFlight) return;
      inFlight = true;
      try {
        const data = await scriptsApi.output(processId, offsetRef.current);
        if (!active) return;
        offsetRef.current = data.offset;
        setTail(prev => {
          const pending = data.pending ?? '';
          const dropped = data.truncatedLines ?? 0;
          if (!data.output && !dropped && pending === prev.pending) return prev;
          const merged = prev.output && data.output
            ? `${prev.output}\n${data.output}`
            : (prev.output || data.output || '');
          return {
            output: merged.length > MAX_TAIL_CHARS ? merged.slice(merged.length - MAX_TAIL_CHARS) : merged,
            pending,
            truncatedLines: prev.truncatedLines + dropped,
          };
        });
      } catch {
        // Registro non raggiungibile: la card resta su ciò che ha già.
      } finally {
        inFlight = false;
      }
    };

    void poll();
    // Una shell finita non produce più niente: si legge una volta e basta.
    if (!isRunning) return () => { active = false; };
    const id = setInterval(() => { void poll(); }, TAIL_POLL_MS);
    return () => { active = false; clearInterval(id); };
  }, [processId, isRunning]);

  if (!entry || !shellId) return IDLE;
  const whole = tail.pending
    ? (tail.output ? `${tail.output}\n${tail.pending}` : tail.pending)
    : tail.output;
  const clean = stripBackgroundShellBanner(whole, shellId);
  return {
    known: true,
    status: entry.status,
    ...(entry.exitCode != null ? { exitCode: entry.exitCode } : {}),
    output: clean,
    truncatedLines: tail.truncatedLines,
  };
}

/**
 * L'id che il CLI assegna alla shell appena avviata, letto dal risultato della
 * `Bash` in background — l'unico posto dove la card lo trova, perché il
 * `detail` di una `shell` porta il comando, non l'id.
 *
 * Volutamente stretta: si chiama SOLO quando `background` è true, altrimenti
 * un qualunque output che contenga «ID: …» darebbe un falso positivo e la card
 * si aggancerebbe alla shell di qualcun altro. Gemella permissiva lato server:
 * `providers/claude/background-shell.ts`.
 */
export function parseShellIdFromStartResult(result: string | undefined): string | undefined {
  if (!result) return undefined;
  const m = result.match(/\b(?:with\s+)?ID:?\s*([A-Za-z0-9_.-]+)/i)
    ?? result.match(/"(?:bash_id|shell_id)"\s*:\s*"([^"]+)"/);
  return m?.[1];
}

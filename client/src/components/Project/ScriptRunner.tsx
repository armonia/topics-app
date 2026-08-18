import { useState, useEffect, useCallback, useRef } from 'react';
import { TREE_ROW_CARD } from '@/lib/selectionStyles';
import { Play, Square } from 'lucide-react';
import { scriptsApi } from '../../lib/api';
import { useDetectedScripts } from '../../hooks/useDetectedScripts';
import type { DetectedScript } from '../../types';
import type { ScriptProcessInfo } from '../../lib/api';
import { useScripts } from '../../hooks/useScripts';
import { lastFailureByScript } from '../../lib/processFailure';
import { useT } from '../../hooks/useT';
import { Spinner } from '../Shared/Spinner';

interface ScriptRunnerProps {
  projectPath: string;
  onRunScript?: (command: string) => void;
  onOpenProcessLog?: (processId: string, scriptName: string) => void;
}

function getScriptColor(name: string): string {
  if (name.match(/^(dev|start|serve)/)) return 'text-green-500';
  if (name.match(/^(build|compile)/)) return 'text-blue-500';
  if (name.match(/^(test|spec|e2e|cypress)/)) return 'text-yellow-500';
  if (name.match(/^(lint|format|prettier|eslint)/)) return 'text-purple-500';
  return 'text-app-text-muted';
}

export function ScriptRunner({ projectPath, onRunScript, onOpenProcessLog }: ScriptRunnerProps) {
  const tr = useT();
  /**
   * Script e manifest vivono in uno STORE per `projectPath`, non qui: stando
   * qui morivano alla chiusura della sezione — che e' cio' che `ProjectSidebar`
   * fa, montando questo componente dentro `{expandedSections.processes && …}` —
   * e riaprendo il pannello si vedeva di nuovo lo spinner. Stesso difetto del
   * FileExplorer, stesso gesto. Vedi `hooks/useDetectedScripts.ts`.
   */
  const { scripts, found, looked, ready } = useDetectedScripts(projectPath);
  const { scripts: runningScripts, refresh: refreshScripts } = useScripts({ projectPath });
  const runningScriptsRef = useRef(runningScripts);
  runningScriptsRef.current = runningScripts;
  // PER-KEY pending sets, not shared scalars: two concurrent actions (e.g. a
  // slow "Run build" overlapping a fast "Run lint") used to clobber each
  // other's spinner — the fast one's `finally` nulled the scalar and the slow
  // one looked never-started, inviting a duplicate click. Starting is keyed
  // by script name; stopping by processId (the only stable key that also
  // covers auto-detected processes — whose rows compare processId, which the
  // old scalar, set to scriptName, never matched: their Stop spinner never
  // showed at all).
  const [startingScripts, setStartingScripts] = useState<Set<string>>(new Set());
  const [stoppingScripts, setStoppingScripts] = useState<Set<string>>(new Set());
  const addKey = (setter: React.Dispatch<React.SetStateAction<Set<string>>>, key: string) =>
    setter(prev => new Set(prev).add(key));
  const removeKey = (setter: React.Dispatch<React.SetStateAction<Set<string>>>, key: string) =>
    setter(prev => { const next = new Set(prev); next.delete(key); return next; });
  const mountedRef = useRef(true);
  // Il ripiego legge gli script SENZA farli entrare fra le dipendenze del
  // callback: rifarlo a ogni cambio di lista rimonterebbe le righe.
  const scriptsRef = useRef<DetectedScript[]>([]);
  useEffect(() => () => { mountedRef.current = false; }, []);

  // Lo specchio per le callback stabili: leggere `scripts` direttamente le
  // rifarebbe a ogni cambio di lista, rimontando le righe.
  scriptsRef.current = scripts;

  /**
   * `id` e cio che si lancia, `name` cio che si mostra: sono diversi perche lo
   * stesso nome puo stare in due manifest. Lo stato «sto partendo» resta sul
   * nome, che e la chiave con cui la riga si ritrova nella lista.
   */
  const handleRunScript = useCallback(async (id: string, name: string) => {
    addKey(setStartingScripts, name);
    try {
      await scriptsApi.run(projectPath, id);
      refreshScripts();
    } catch {
      if (onRunScript) {
        // Il ripiego passa dalla chat: si scrive il comando VERO dello script,
        // non `npm run` — che su un target di Makefile non vuol dire niente.
        const comando = scriptsRef.current.find(x => x.id === id)?.argv.join(' ') ?? name;
        onRunScript(`cd ${JSON.stringify(projectPath)} && ${comando}`);
      }
    } finally {
      removeKey(setStartingScripts, name);
    }
  }, [projectPath, onRunScript, refreshScripts]);

  const handleStopScript = useCallback(async (processId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    addKey(setStoppingScripts, processId);
    try {
      await scriptsApi.stop(processId);
      // Poll until the process is actually gone. Match on processId, not name:
      // two shells can share a command line, and a restarted script gets a new
      // processId — the name would answer about the wrong process.
      const poll = async (attempts: number) => {
        if (!mountedRef.current) return;
        await refreshScripts();
        if (!mountedRef.current) return;
        const stillRunning = runningScriptsRef.current.some(s => s.processId === processId && s.status === 'running');
        if (stillRunning && attempts > 0) {
          setTimeout(() => poll(attempts - 1), 500);
        } else {
          removeKey(setStoppingScripts, processId);
        }
      };
      setTimeout(() => poll(10), 500);
    } catch {
      if (mountedRef.current) removeKey(setStoppingScripts, processId);
    }
  }, [refreshScripts]);

  const scriptEntries = scripts;
  // Il manifest si mostra accanto al nome solo se ce n'e piu d'uno: con un
  // package.json e basta sarebbe la stessa etichetta su ogni riga.
  const piuManifest = new Set(scripts.map(s => s.from)).size > 1;

  // Map script name → running process
  const runningMap = new Map<string, ScriptProcessInfo>();
  for (const sp of runningScripts) {
    if (sp.status === 'running') runningMap.set(sp.scriptName, sp);
  }

  // L'ULTIMO FALLIMENTO per script. Senza, un processo che muore male torna con
  // l'icona Play come se non fosse mai partito: l'exit code non si vede da
  // nessuna parte e il log — che il server ha ancora — non è più raggiungibile
  // da un click. Clicchi "build", fallisce mentre guardi la chat, e non lo sai.
  const failedMap = lastFailureByScript(runningScripts);

  const detectedRows = runningScripts.filter(
    sp => sp.status === 'running' && sp.source === 'detected' && !scripts.some(x => x.name === sp.scriptName));
  const shellRows = runningScripts.filter(sp => sp.status === 'running' && sp.source === 'shell');

  if (!ready) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 text-app-text-tertiary text-[11px]">
        <Spinner size="sm" />
      </div>
    );
  }

  // Niente script dichiarati non vuol dire niente processi: una shell in
  // background o un server auto-rilevato vivono anche in una cartella senza
  // manifest, e nasconderli qui li renderebbe di nuovo invisibili.
  //
  // Ma quando non c'e DAVVERO niente, la sezione lo DICE. Prima faceva
  // `return null` e si apriva sul vuoto, senza distinguere «qui non c'e niente»
  // da «non ho guardato» — che e la differenza che conta quando ti chiedi
  // perche il pannello e muto.
  if (scriptEntries.length === 0 && detectedRows.length === 0 && shellRows.length === 0) {
    return (
      <div data-testid="script-runner-empty" className="px-3 py-2 text-[11px] text-app-text-tertiary leading-relaxed">
        {found.length === 0
          ? <>{tr('scripts.noManifest')}</>
          : <>{tr('scripts.noneDeclared', { files: found.join(', ') })}</>}
        {looked.length > 0 && (
          <div className="mt-1 text-app-text-faint" title={looked.join('\n')}>
            {tr('scripts.lookedIn', { files: looked.join(', ') })}
          </div>
        )}
      </div>
    );
  }

  return (
    <div data-testid="script-runner" className="text-[12px] pb-1">
      {scriptEntries.map((script) => {
        const { id, name, detail: cmd, from } = script;
        const running = runningMap.get(name);
        // Un fallimento conta solo se lo script non è ripartito nel frattempo.
        const failed = running ? undefined : failedMap.get(name);
        const isStarting = startingScripts.has(name);
        const isStopping = running ? stoppingScripts.has(running.processId) : false;
        const ports = running?.ports ?? [];

        return (
          <div key={id}>
            <div
              // L'aggancio e l'ID, non il testo: la riga mostra il nome PIU il
              // manifest, e `getByText` legge il testo concatenato — cercare
              // «test» esatto non trova «testCargo.toml».
              data-script-id={id}
              data-script-from={from}
              className={`flex items-center gap-1.5 ${TREE_ROW_CARD} px-2 py-1 group cursor-pointer ${isStopping ? 'opacity-60' : ''}`}
              onClick={() => {
                if (isStopping) return;
                if (running) {
                  onOpenProcessLog?.(running.processId, name);
                } else if (!isStarting) {
                  // L'ID, non il nome: `test` puo essere sia uno script di
                  // package.json sia un target del Makefile.
                  handleRunScript(id, name);
                }
              }}
              title={cmd}
            >
              {isStopping ? (
                <Spinner size="xs" tone="current" className="text-red-500 flex-shrink-0" />
              ) : running ? (
                <div className="w-[10px] h-[10px] flex-shrink-0 relative">
                  <div className="absolute inset-0 rounded-full bg-green-500 animate-pulse" />
                </div>
              ) : isStarting ? (
                <Spinner size="xs" tone="current" className="text-primary flex-shrink-0" />
              ) : failed ? (
                <div className="w-[10px] h-[10px] flex-shrink-0 rounded-full bg-red-500" />
              ) : (
                <Play size={10} className={`flex-shrink-0 ${getScriptColor(name)}`} />
              )}
              <span className={`flex-1 truncate ${isStopping ? 'text-red-500/70' : running ? 'text-green-500 font-medium' : failed ? 'text-red-500' : 'text-app-text-body'}`}>
                {name}
                {piuManifest && (
                  <span className="ml-1.5 text-[10px] text-app-text-faint">{from}</span>
                )}
              </span>
              {failed && !isStopping && (
                <button
                  onClick={(e) => { e.stopPropagation(); onOpenProcessLog?.(failed.processId, name); }}
                  className="text-[10px] font-medium text-red-600 dark:text-red-400 bg-red-500/10 px-1 py-[1px] rounded-full flex-shrink-0 hover:bg-red-500/20 transition-colors"
                  title={tr('processes.openFailedLog')}
                >
                  exit {failed.exitCode}
                </button>
              )}
              {/* Inline ports for running scripts */}
              {!isStopping && ports.map(port => (
                <a
                  key={port}
                  href={`http://${window.location.hostname}:${port}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[11px] text-primary hover:underline flex-shrink-0"
                  onClick={e => e.stopPropagation()}
                >
                  :{port}
                </a>
              ))}
              {running && !isStopping && (
                <button
                  onClick={(e) => handleStopScript(running.processId, e)}
                  className="p-0.5 rounded hover:bg-red-500/20 text-app-text-faint hover:text-red-500 transition-colors opacity-40 group-hover:opacity-100"
                  title="Stop"
                >
                  <Square size={10} />
                </button>
              )}
              {!running && !isStopping && (
                <span className="text-[11px] text-app-text-faint truncate max-w-[100px] hidden group-hover:block">{cmd}</span>
              )}
            </div>
          </div>
        );
      })}

      {/* Auto-detected running servers — started inside a Claude session via a
          bare shell command (not a package.json script), surfaced here so they're
          visible and stoppable like any tracked process. */}
      {detectedRows
        .map(sp => {
          const isStopping = stoppingScripts.has(sp.processId);
          const ports = sp.ports ?? [];
          return (
            <div key={sp.processId}>
              <div
                className={`flex items-center gap-1.5 ${TREE_ROW_CARD} px-2 py-1 group cursor-pointer ${isStopping ? 'opacity-60' : ''}`}
                onClick={() => { if (!isStopping) onOpenProcessLog?.(sp.processId, sp.scriptName); }}
                title={sp.command}
              >
                {isStopping ? (
                  <Spinner size="xs" tone="current" className="text-red-500 flex-shrink-0" />
                ) : (
                  <div className="w-[10px] h-[10px] flex-shrink-0 relative">
                    <div className="absolute inset-0 rounded-full bg-green-500 animate-pulse" />
                  </div>
                )}
                <span className={`truncate ${isStopping ? 'text-red-500/70' : 'text-green-500 font-medium'}`}>{sp.scriptName}</span>
                <span
                  className="text-[9px] uppercase tracking-wide px-1 py-px rounded bg-app-text-faint/15 text-app-text-faint flex-shrink-0"
                  title="Started in a Claude session and auto-detected by Topics (logs not captured)"
                >
                  auto
                </span>
                <span className="flex-1" />
                {!isStopping && ports.map(port => (
                  <a
                    key={port}
                    href={`http://${window.location.hostname}:${port}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[11px] text-primary hover:underline flex-shrink-0"
                    onClick={e => e.stopPropagation()}
                  >
                    :{port}
                  </a>
                ))}
                {!isStopping && (
                  <button
                    onClick={(e) => handleStopScript(sp.processId, e)}
                    className="p-0.5 rounded hover:bg-red-500/20 text-app-text-faint hover:text-red-500 transition-colors opacity-40 group-hover:opacity-100"
                    title="Stop"
                  >
                    <Square size={10} />
                  </button>
                )}
              </div>
            </div>
          );
        })}

      {/* Shell che l'agente ha lasciato in background (`Bash(run_in_background)`).
          Prima esistevano solo come card nel transcript: un ricordo che scorreva
          via. Qui sono uno stato — si contano, si leggono e si fermano come
          qualunque altro processo. */}
      {shellRows.map(sp => {
        const isStopping = stoppingScripts.has(sp.processId);
        const ports = sp.ports ?? [];
        return (
          <div key={sp.processId}>
            <div
              data-testid="shell-process-row"
              data-shell-id={sp.shellId}
              className={`flex items-center gap-1.5 ${TREE_ROW_CARD} px-2 py-1 group cursor-pointer ${isStopping ? 'opacity-60' : ''}`}
              onClick={() => { if (!isStopping) onOpenProcessLog?.(sp.processId, sp.scriptName); }}
              title={sp.command}
            >
              {isStopping ? (
                <Spinner size="xs" tone="current" className="text-red-500 flex-shrink-0" />
              ) : (
                <div className="w-[10px] h-[10px] flex-shrink-0 relative">
                  <div className="absolute inset-0 rounded-full bg-green-500 animate-pulse" />
                </div>
              )}
              <span className={`truncate ${isStopping ? 'text-red-500/70' : 'text-green-500 font-medium'}`}>{sp.scriptName}</span>
              <span
                className="text-[9px] uppercase tracking-wide px-1 py-px rounded bg-primary/15 text-primary flex-shrink-0"
                title={tr('scripts.shellFromAgent')}
              >
                shell
              </span>
              <span className="flex-1" />
              {!isStopping && ports.map(port => (
                <a
                  key={port}
                  href={`http://${window.location.hostname}:${port}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[11px] text-primary hover:underline flex-shrink-0"
                  onClick={e => e.stopPropagation()}
                >
                  :{port}
                </a>
              ))}
              {/* Senza pid non c'è niente da fermare: il bottone lo dice invece
                  di fingere. Il pid arriva appena il processo si fa trovare
                  nell'albero del CLI (pochi secondi). */}
              {!isStopping && (
                <button
                  onClick={(e) => { if (sp.pid) handleStopScript(sp.processId, e); else e.stopPropagation(); }}
                  disabled={!sp.pid}
                  className={`p-0.5 rounded transition-colors ${sp.pid
                    ? 'hover:bg-red-500/20 text-app-text-faint hover:text-red-500 opacity-40 group-hover:opacity-100'
                    : 'text-app-text-faint opacity-20 cursor-default'}`}
                  title={sp.pid ? 'Stop' : tr('scripts.noPid')}
                >
                  <Square size={10} />
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

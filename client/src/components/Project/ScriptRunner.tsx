import { useState, useEffect, useCallback, useRef } from 'react';
import { Play, Square } from 'lucide-react';
import { filesApi, scriptsApi } from '../../lib/api';
import type { ScriptProcessInfo } from '../../lib/api';
import { useScripts } from '../../hooks/useScripts';

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
  const [scripts, setScripts] = useState<Record<string, string>>({});
  const { scripts: runningScripts, refresh: refreshScripts } = useScripts({ projectPath });
  const runningScriptsRef = useRef(runningScripts);
  runningScriptsRef.current = runningScripts;
  const [ready, setReady] = useState(false);
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
  useEffect(() => () => { mountedRef.current = false; }, []);

  // Load package.json scripts on mount
  useEffect(() => {
    let active = true;
    filesApi.packageScripts(projectPath).catch(() => ({ scripts: {} }))
      .then((pkgData) => {
        if (!active) return;
        setScripts(pkgData.scripts);
        setReady(true);
      });
    return () => { active = false; };
  }, [projectPath]);

  const handleRunScript = useCallback(async (name: string) => {
    addKey(setStartingScripts, name);
    try {
      await scriptsApi.run(projectPath, name);
      refreshScripts();
    } catch {
      if (onRunScript) {
        onRunScript(`cd ${JSON.stringify(projectPath)} && npm run ${name}`);
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

  const scriptEntries = Object.entries(scripts);

  // Map script name → running process
  const runningMap = new Map<string, ScriptProcessInfo>();
  for (const sp of runningScripts) {
    if (sp.status === 'running') runningMap.set(sp.scriptName, sp);
  }

  const detectedRows = runningScripts.filter(
    sp => sp.status === 'running' && sp.source === 'detected' && !(sp.scriptName in scripts));
  const shellRows = runningScripts.filter(sp => sp.status === 'running' && sp.source === 'shell');

  if (!ready) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 text-app-text-tertiary text-[11px]">
        <div className="w-3 h-3 border-[1.5px] border-app-spinner border-t-primary rounded-full animate-spin" />
      </div>
    );
  }

  // Niente script nel package.json non vuol dire niente processi: una shell in
  // background o un server auto-rilevato vivono anche in una cartella senza
  // package.json, e nasconderli qui li renderebbe di nuovo invisibili.
  if (scriptEntries.length === 0 && detectedRows.length === 0 && shellRows.length === 0) return null;

  return (
    <div data-testid="script-runner" className="text-[12px] pb-1">
      {scriptEntries.map(([name, cmd]) => {
        const running = runningMap.get(name);
        const isStarting = startingScripts.has(name);
        const isStopping = running ? stoppingScripts.has(running.processId) : false;
        const ports = running?.ports ?? [];

        return (
          <div key={name}>
            <div
              className={`flex items-center gap-1.5 px-3 py-1 transition-colors group cursor-pointer ${isStopping ? 'opacity-60' : 'hover:bg-app-hover'}`}
              onClick={() => {
                if (isStopping) return;
                if (running) {
                  onOpenProcessLog?.(running.processId, name);
                } else if (!isStarting) {
                  handleRunScript(name);
                }
              }}
              title={cmd}
            >
              {isStopping ? (
                <div className="w-[10px] h-[10px] border border-red-500 border-t-transparent rounded-full animate-spin flex-shrink-0" />
              ) : running ? (
                <div className="w-[10px] h-[10px] flex-shrink-0 relative">
                  <div className="absolute inset-0 rounded-full bg-green-500 animate-pulse" />
                </div>
              ) : isStarting ? (
                <div className="w-[10px] h-[10px] border border-primary border-t-transparent rounded-full animate-spin flex-shrink-0" />
              ) : (
                <Play size={10} className={`flex-shrink-0 ${getScriptColor(name)}`} />
              )}
              <span className={`flex-1 truncate ${isStopping ? 'text-red-500/70' : running ? 'text-green-500 font-medium' : 'text-app-text-body'}`}>
                {name}
              </span>
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
                className={`flex items-center gap-1.5 px-3 py-1 transition-colors group cursor-pointer ${isStopping ? 'opacity-60' : 'hover:bg-app-hover'}`}
                onClick={() => { if (!isStopping) onOpenProcessLog?.(sp.processId, sp.scriptName); }}
                title={sp.command}
              >
                {isStopping ? (
                  <div className="w-[10px] h-[10px] border border-red-500 border-t-transparent rounded-full animate-spin flex-shrink-0" />
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
              className={`flex items-center gap-1.5 px-3 py-1 transition-colors group cursor-pointer ${isStopping ? 'opacity-60' : 'hover:bg-app-hover'}`}
              onClick={() => { if (!isStopping) onOpenProcessLog?.(sp.processId, sp.scriptName); }}
              title={sp.command}
            >
              {isStopping ? (
                <div className="w-[10px] h-[10px] border border-red-500 border-t-transparent rounded-full animate-spin flex-shrink-0" />
              ) : (
                <div className="w-[10px] h-[10px] flex-shrink-0 relative">
                  <div className="absolute inset-0 rounded-full bg-green-500 animate-pulse" />
                </div>
              )}
              <span className={`truncate ${isStopping ? 'text-red-500/70' : 'text-green-500 font-medium'}`}>{sp.scriptName}</span>
              <span
                className="text-[9px] uppercase tracking-wide px-1 py-px rounded bg-primary/15 text-primary flex-shrink-0"
                title="Shell lasciata in background dall'agente — l'output arriva dai suoi BashOutput"
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
                  title={sp.pid ? 'Stop' : "Processo non ancora individuato — fermala dalla chat con KillShell"}
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

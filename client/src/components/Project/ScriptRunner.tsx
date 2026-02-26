import { useState, useEffect, useCallback } from 'react';
import { Play, Square, Globe } from 'lucide-react';
import { filesApi, scriptsApi } from '../../lib/api';
import type { ScriptProcessInfo } from '../../lib/api';

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
  const [runningScripts, setRunningScripts] = useState<ScriptProcessInfo[]>([]);
  const [ready, setReady] = useState(false);
  const [startingScript, setStartingScript] = useState<string | null>(null);

  // Load both scripts and running state together before rendering
  useEffect(() => {
    let active = true;
    Promise.all([
      filesApi.packageScripts(projectPath).catch(() => ({ scripts: {} })),
      scriptsApi.list().catch(() => ({ scripts: [] as ScriptProcessInfo[] })),
    ]).then(([pkgData, runData]) => {
      if (!active) return;
      setScripts(pkgData.scripts);
      setRunningScripts((runData.scripts as ScriptProcessInfo[]).filter(s => s.projectPath === projectPath));
      setReady(true);
    });
    return () => { active = false; };
  }, [projectPath]);

  // Poll running scripts after initial load
  useEffect(() => {
    if (!ready) return;
    const interval = setInterval(() => {
      scriptsApi.list()
        .then(data => setRunningScripts(data.scripts.filter(s => s.projectPath === projectPath)))
        .catch(() => {});
    }, 3000);
    return () => clearInterval(interval);
  }, [projectPath, ready]);

  const handleRunScript = useCallback(async (name: string) => {
    setStartingScript(name);
    try {
      await scriptsApi.run(projectPath, name);
      const data = await scriptsApi.list();
      setRunningScripts(data.scripts.filter(s => s.projectPath === projectPath));
    } catch {
      if (onRunScript) {
        onRunScript(`cd ${JSON.stringify(projectPath)} && npm run ${name}`);
      }
    } finally {
      setStartingScript(null);
    }
  }, [projectPath, onRunScript]);

  const handleStopScript = useCallback(async (processId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await scriptsApi.stop(processId);
      setTimeout(async () => {
        const data = await scriptsApi.list();
        setRunningScripts(data.scripts.filter(s => s.projectPath === projectPath));
      }, 1000);
    } catch {}
  }, [projectPath]);

  const scriptEntries = Object.entries(scripts);

  // Map script name → running process
  const runningMap = new Map<string, ScriptProcessInfo>();
  for (const sp of runningScripts) {
    if (sp.status === 'running') runningMap.set(sp.scriptName, sp);
  }

  if (!ready) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 text-app-text-tertiary text-[11px]">
        <div className="w-3 h-3 border-[1.5px] border-app-spinner border-t-primary rounded-full animate-spin" />
      </div>
    );
  }

  if (scriptEntries.length === 0) return null;

  return (
    <div className="text-[12px] pb-1">
      {scriptEntries.map(([name, cmd]) => {
        const running = runningMap.get(name);
        const isStarting = startingScript === name;
        const ports = running?.ports ?? [];

        return (
          <div key={name}>
            <div
              className="flex items-center gap-1.5 px-3 py-1 hover:bg-app-hover transition-colors group cursor-pointer"
              onClick={() => {
                if (running) {
                  onOpenProcessLog?.(running.processId, name);
                } else if (!isStarting) {
                  handleRunScript(name);
                }
              }}
              title={cmd}
            >
              {running ? (
                <div className="w-[10px] h-[10px] flex-shrink-0 relative">
                  <div className="absolute inset-0 rounded-full bg-green-500 animate-pulse" />
                </div>
              ) : isStarting ? (
                <div className="w-[10px] h-[10px] border border-primary border-t-transparent rounded-full animate-spin flex-shrink-0" />
              ) : (
                <Play size={10} className={`flex-shrink-0 ${getScriptColor(name)}`} />
              )}
              <span className={`flex-1 truncate ${running ? 'text-green-500 font-medium' : 'text-app-text-body'}`}>
                {name}
              </span>
              {/* Inline ports for running scripts */}
              {ports.map(port => (
                <a
                  key={port}
                  href={`http://localhost:${port}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[10px] text-primary hover:underline flex-shrink-0"
                  onClick={e => e.stopPropagation()}
                >
                  :{port}
                </a>
              ))}
              {running && (
                <button
                  onClick={(e) => handleStopScript(running.processId, e)}
                  className="p-0.5 rounded hover:bg-red-500/20 text-app-text-faint hover:text-red-500 transition-colors opacity-0 group-hover:opacity-100"
                  title="Stop"
                >
                  <Square size={9} />
                </button>
              )}
              {!running && (
                <span className="text-[10px] text-app-text-faint truncate max-w-[100px] hidden group-hover:block">{cmd}</span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

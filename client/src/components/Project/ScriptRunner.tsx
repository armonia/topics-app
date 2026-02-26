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
  const [ports, setPorts] = useState<{ port: number; pid: number; command: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [startingScript, setStartingScript] = useState<string | null>(null);

  // Load package.json scripts
  useEffect(() => {
    setLoading(true);
    filesApi.packageScripts(projectPath)
      .then(data => setScripts(data.scripts))
      .catch(() => setScripts({}))
      .finally(() => setLoading(false));
  }, [projectPath]);

  // Poll running scripts + ports together
  useEffect(() => {
    const fetchAll = async () => {
      try {
        const [scriptsData, statusRes] = await Promise.all([
          scriptsApi.list(),
          fetch('/api/system/status').then(r => r.ok ? r.json() : null),
        ]);
        setRunningScripts(scriptsData.scripts.filter(s => s.projectPath === projectPath));
        if (statusRes?.ports) setPorts(statusRes.ports);
      } catch {
        setRunningScripts([]);
      }
    };
    fetchAll();
    const interval = setInterval(fetchAll, 5000);
    return () => clearInterval(interval);
  }, [projectPath]);

  // Run a script — does NOT open the log tab
  const handleRunScript = useCallback(async (name: string) => {
    setStartingScript(name);
    try {
      await scriptsApi.run(projectPath, name);
      // Refresh the running list
      const data = await scriptsApi.list();
      setRunningScripts(data.scripts.filter(s => s.projectPath === projectPath));
    } catch {
      // Fallback to terminal
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

  if (loading) {
    return (
      <div className="px-2 py-2">
        <div className="w-3 h-3 border-2 border-app-spinner border-t-primary rounded-full animate-spin mx-auto" />
      </div>
    );
  }

  if (scriptEntries.length === 0) return null;

  return (
    <div className="text-[12px] pb-1">
      {scriptEntries.map(([name, cmd]) => {
        const running = runningMap.get(name);
        const isStarting = startingScript === name;

        return (
          <div
            key={name}
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
        );
      })}

      {/* Active Ports */}
      {ports.length > 0 && (
        <div className="mt-1 border-t border-app-border pt-1">
          {ports.map(p => (
            <div
              key={p.port}
              className="flex items-center gap-1.5 px-3 py-1 hover:bg-app-hover transition-colors"
            >
              <Globe size={10} className="text-green-500 flex-shrink-0" />
              <a
                href={`http://localhost:${p.port}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline flex-shrink-0"
                onClick={e => e.stopPropagation()}
              >
                :{p.port}
              </a>
              <span className="text-app-text-faint truncate">{p.command}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

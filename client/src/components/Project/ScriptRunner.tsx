import { useState, useEffect, useCallback } from 'react';
import { Play, Square, ChevronDown, ChevronRight } from 'lucide-react';
import { filesApi, scriptsApi } from '../../lib/api';
import type { ScriptProcessInfo } from '../../lib/api';

interface ScriptRunnerProps {
  projectPath: string;
  onRunScript?: (command: string) => void;
  onOpenProcessLog?: (processId: string, scriptName: string) => void;
}

// Categorize scripts for better display
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
  const [showScripts, setShowScripts] = useState(true);
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

  // Poll running scripts
  useEffect(() => {
    const fetchRunning = () => {
      scriptsApi.list()
        .then(data => {
          // Filter to scripts for this project
          setRunningScripts(data.scripts.filter(s => s.projectPath === projectPath));
        })
        .catch(() => setRunningScripts([]));
    };
    fetchRunning();
    const interval = setInterval(fetchRunning, 3000);
    return () => clearInterval(interval);
  }, [projectPath]);

  const handleRunScript = useCallback(async (name: string) => {
    // Check if already running
    const alreadyRunning = runningScripts.find(s => s.scriptName === name && s.status === 'running');
    if (alreadyRunning) {
      // Focus existing log
      onOpenProcessLog?.(alreadyRunning.processId, name);
      return;
    }

    setStartingScript(name);
    try {
      const result = await scriptsApi.run(projectPath, name);
      onOpenProcessLog?.(result.processId, name);
      // Refresh the list
      const data = await scriptsApi.list();
      setRunningScripts(data.scripts.filter(s => s.projectPath === projectPath));
    } catch (err) {
      // Fallback to terminal if available
      if (onRunScript) {
        const fullCommand = `cd ${JSON.stringify(projectPath)} && npm run ${name}`;
        onRunScript(fullCommand);
      }
    } finally {
      setStartingScript(null);
    }
  }, [projectPath, runningScripts, onRunScript, onOpenProcessLog]);

  const handleStopScript = useCallback(async (processId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await scriptsApi.stop(processId);
      // Refresh
      setTimeout(async () => {
        const data = await scriptsApi.list();
        setRunningScripts(data.scripts.filter(s => s.projectPath === projectPath));
      }, 1000);
    } catch {}
  }, [projectPath]);

  const scriptEntries = Object.entries(scripts);
  const hasScripts = scriptEntries.length > 0;

  // Map script name → running process
  const runningMap = new Map<string, ScriptProcessInfo>();
  for (const sp of runningScripts) {
    if (sp.status === 'running') {
      runningMap.set(sp.scriptName, sp);
    }
  }

  if (loading) {
    return (
      <div className="px-2 py-2">
        <div className="w-3 h-3 border-2 border-app-spinner border-t-primary rounded-full animate-spin mx-auto" />
      </div>
    );
  }

  return (
    <div className="text-[12px]">
      {/* Scripts Section */}
      {hasScripts && (
        <>
          <button
            onClick={() => setShowScripts(!showScripts)}
            className="w-full flex items-center gap-2 px-3 py-1 text-[10px] font-medium text-app-text-muted uppercase tracking-wider hover:bg-app-hover transition-colors"
          >
            {showScripts ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
            Scripts
            <span className="ml-auto text-app-text-faint">{scriptEntries.length}</span>
          </button>
          {showScripts && (
            <div className="pb-1">
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
                      } else {
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
            </div>
          )}
        </>
      )}
    </div>
  );
}

import { useState, useEffect, useCallback } from 'react';
import { Play, RotateCcw, Globe, ChevronDown, ChevronRight } from 'lucide-react';
import { filesApi, processesApi } from '../../lib/api';

interface ScriptRunnerProps {
  projectPath: string;
  onRunScript?: (command: string) => void;
}

// Categorize scripts for better display
function getScriptCategory(name: string): string {
  if (name.match(/^(dev|start|serve)/)) return 'dev';
  if (name.match(/^(build|compile)/)) return 'build';
  if (name.match(/^(test|spec|e2e|cypress)/)) return 'test';
  if (name.match(/^(lint|format|prettier|eslint)/)) return 'lint';
  return 'other';
}

function getScriptColor(name: string): string {
  const cat = getScriptCategory(name);
  switch (cat) {
    case 'dev': return 'text-green-500';
    case 'build': return 'text-blue-500';
    case 'test': return 'text-yellow-500';
    case 'lint': return 'text-purple-500';
    default: return 'text-app-text-muted';
  }
}

export function ScriptRunner({ projectPath, onRunScript }: ScriptRunnerProps) {
  const [scripts, setScripts] = useState<Record<string, string>>({});
  const [ports, setPorts] = useState<{ port: number; pid: number; command: string }[]>([]);
  const [showScripts, setShowScripts] = useState(true);
  const [showPorts, setShowPorts] = useState(true);
  const [loading, setLoading] = useState(true);

  // Load package.json scripts
  useEffect(() => {
    setLoading(true);
    filesApi.packageScripts(projectPath)
      .then(data => setScripts(data.scripts))
      .catch(() => setScripts({}))
      .finally(() => setLoading(false));
  }, [projectPath]);

  // Poll active ports
  useEffect(() => {
    const fetchPorts = () => {
      processesApi.ports()
        .then(data => setPorts(data.ports))
        .catch(() => setPorts([]));
    };
    fetchPorts();
    const interval = setInterval(fetchPorts, 10000);
    return () => clearInterval(interval);
  }, []);

  const handleRunScript = useCallback((name: string, command: string) => {
    if (onRunScript) {
      // The command to run in terminal
      const fullCommand = `cd ${JSON.stringify(projectPath)} && npm run ${name}`;
      onRunScript(fullCommand);
    }
  }, [projectPath, onRunScript]);

  const scriptEntries = Object.entries(scripts);
  const hasScripts = scriptEntries.length > 0;

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
              {scriptEntries.map(([name, cmd]) => (
                <div
                  key={name}
                  className="flex items-center gap-1.5 px-3 py-1 hover:bg-app-hover transition-colors group cursor-pointer"
                  onClick={() => handleRunScript(name, cmd)}
                  title={cmd}
                >
                  <Play size={10} className={`flex-shrink-0 ${getScriptColor(name)}`} />
                  <span className="flex-1 truncate text-app-text-body">{name}</span>
                  <span className="text-[10px] text-app-text-faint truncate max-w-[100px] hidden group-hover:block">{cmd}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* Active Ports Section */}
      <button
        onClick={() => setShowPorts(!showPorts)}
        className="w-full flex items-center gap-2 px-3 py-1 text-[10px] font-medium text-app-text-muted uppercase tracking-wider hover:bg-app-hover transition-colors"
      >
        {showPorts ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        Active Ports
        <span className="ml-auto text-app-text-faint">{ports.length}</span>
      </button>
      {showPorts && (
        <div className="pb-1">
          {ports.length === 0 ? (
            <div className="px-3 py-1 text-app-text-faint text-[11px]">No ports listening</div>
          ) : (
            ports.map(p => (
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
            ))
          )}
        </div>
      )}
    </div>
  );
}

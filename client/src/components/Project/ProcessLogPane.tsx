import { useState, useEffect, useRef, useCallback } from 'react';
import { Square, RotateCcw } from 'lucide-react';
import { scriptsApi } from '../../lib/api';

interface ProcessLogPaneProps {
  processId: string;
  scriptName?: string;
}

function formatDuration(startedAt: string, completedAt?: string): string {
  const start = new Date(startedAt).getTime();
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  const diff = Math.floor((end - start) / 1000);
  if (diff < 60) return `${diff}s`;
  const m = Math.floor(diff / 60);
  const s = diff % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function ProcessLogPane({ processId, scriptName }: ProcessLogPaneProps) {
  const [output, setOutput] = useState('');
  const [offset, setOffset] = useState(0);
  const [status, setStatus] = useState<string>('running');
  const [exitCode, setExitCode] = useState<number | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [startedAt] = useState(() => new Date().toISOString());
  const [completedAt, setCompletedAt] = useState<string | undefined>();
  const preRef = useRef<HTMLPreElement>(null);
  const autoScrollRef = useRef(true);

  // Track if user has scrolled up (disable auto-scroll)
  const handleScroll = useCallback(() => {
    const el = preRef.current;
    if (!el) return;
    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    autoScrollRef.current = isNearBottom;
  }, []);

  // Poll for output
  useEffect(() => {
    let active = true;
    let currentOffset = 0;

    const poll = async () => {
      if (!active) return;
      try {
        const data = await scriptsApi.output(processId, currentOffset);
        if (!active) return;
        if (data.output) {
          setOutput(prev => prev ? prev + '\n' + data.output : data.output);
        }
        currentOffset = data.offset;
        setOffset(data.offset);
        setStatus(data.status);
        setExitCode(data.exitCode);
        if (data.done) {
          setCompletedAt(new Date().toISOString());
        }
        setError(null);
      } catch (err: any) {
        if (!active) return;
        setError(err.message || 'Failed to fetch output');
      }
    };

    poll();
    const id = setInterval(poll, 2000);

    return () => {
      active = false;
      clearInterval(id);
    };
  }, [processId]);

  // Auto-scroll to bottom when output changes
  useEffect(() => {
    if (autoScrollRef.current && preRef.current) {
      preRef.current.scrollTop = preRef.current.scrollHeight;
    }
  }, [output]);

  const handleStop = useCallback(async () => {
    try {
      await scriptsApi.stop(processId);
    } catch {}
  }, [processId]);

  const statusColor = status === 'running'
    ? 'text-green-500'
    : status === 'done'
    ? 'text-app-text-muted'
    : 'text-red-500';

  const statusLabel = status === 'running'
    ? 'Running'
    : status === 'done'
    ? `Done (exit ${exitCode ?? 0})`
    : `Error (exit ${exitCode ?? 1})`;

  return (
    <div className="flex flex-col h-full bg-app-bg">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-app-border bg-elevated flex-shrink-0">
        <span className="text-[12px] font-medium text-app-text truncate">
          {scriptName || processId.slice(0, 8)}
        </span>
        <span className={`text-[11px] ${statusColor}`}>
          {statusLabel}
        </span>
        <span className="text-[10px] text-app-text-muted">
          {formatDuration(startedAt, completedAt)}
        </span>
        <div className="flex-1" />
        {status === 'running' && (
          <button
            onClick={handleStop}
            className="flex items-center gap-1 px-2 py-0.5 text-[11px] text-red-500 hover:bg-red-500/10 rounded transition-colors"
            title="Stop process"
          >
            <Square size={10} />
            Stop
          </button>
        )}
      </div>

      {/* Output */}
      <pre
        ref={preRef}
        onScroll={handleScroll}
        className="flex-1 overflow-auto p-3 text-[12px] leading-relaxed text-app-text font-mono whitespace-pre-wrap break-words select-text"
      >
        {output || (error ? `Error: ${error}` : 'Waiting for output...')}
      </pre>

      {/* Status bar */}
      {status === 'running' && (
        <div className="flex items-center gap-2 px-3 py-1 border-t border-app-border bg-elevated flex-shrink-0">
          <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
          <span className="text-[10px] text-app-text-muted">
            Streaming output... ({offset} lines)
          </span>
        </div>
      )}
    </div>
  );
}

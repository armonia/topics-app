/**
 * Per-tool detail cards.
 *
 * One component per `ToolCallDetail.type`. The parent <ToolCallRow> already
 * handles the collapsible header (chevron + icon + name + status); these
 * components render the EXPANDED body. Stay compact: 30–80 lines each, no
 * external dependencies beyond the existing markdown/code utilities.
 *
 * All cards follow the same visual language: small monospace 11px text,
 * subtle bg `bg-app-hover/40`, rounded corners. Long content is scrollable
 * (max-h-* with overflow-auto). No fancy syntax highlighting yet — that's a
 * future polish; the current improvement is over the previous 100% raw
 * `JSON.stringify` everything.
 */

import type { ToolCallDetail } from '../../types';

// ── Shell ───────────────────────────────────────────────────────────────────

export function ShellCard({ command, cwd, output, exitCode, isError }: {
  command: string; cwd?: string; output?: string; exitCode?: number | null; isError?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <div>
        <div className="text-[11px] uppercase tracking-wide text-app-text-muted mb-0.5">
          {cwd ? `Command (cwd: ${cwd})` : 'Command'}
        </div>
        <pre className="text-[11px] font-mono text-app-text whitespace-pre-wrap bg-app-hover/40 rounded px-2 py-1.5">
          $ {command}
        </pre>
      </div>
      {output && (
        <div>
          <div className="text-[11px] uppercase tracking-wide text-app-text-muted mb-0.5 flex items-center gap-2">
            <span>Output</span>
            {typeof exitCode === 'number' && (
              <span className={`text-[11px] font-mono ${exitCode === 0 ? 'text-green-500' : 'text-red-500'}`}>exit {exitCode}</span>
            )}
          </div>
          <pre className={`text-[11px] font-mono whitespace-pre-wrap overflow-auto max-h-72 rounded px-2 py-1.5 ${isError ? 'text-red-500 bg-red-500/5' : 'text-app-text-secondary bg-app-hover/40'}`}>
            {output}
          </pre>
        </div>
      )}
    </div>
  );
}

// ── Read ────────────────────────────────────────────────────────────────────

export function ReadCard({ filePath, content, offset, limit }: {
  filePath: string; content?: string; offset?: number; limit?: number;
}) {
  const meta = offset != null || limit != null
    ? ` (lines ${offset ?? 0}${limit ? `–${(offset ?? 0) + limit}` : '+'})`
    : '';
  return (
    <div className="space-y-1.5">
      <div className="text-[11px] uppercase tracking-wide text-app-text-muted">
        File{meta}
      </div>
      <div className="text-[11px] font-mono text-app-text-secondary truncate">{filePath}</div>
      {content && (
        <div>
          <div className="text-[11px] uppercase tracking-wide text-app-text-muted mb-0.5">Content</div>
          <pre className="text-[11px] font-mono text-app-text-secondary whitespace-pre-wrap overflow-auto max-h-80 bg-app-hover/40 rounded px-2 py-1.5">
            {content}
          </pre>
        </div>
      )}
    </div>
  );
}

// ── Edit ────────────────────────────────────────────────────────────────────

export function EditCard({ filePath, oldString, newString, unifiedDiff }: {
  filePath: string; oldString?: string; newString?: string; unifiedDiff?: string;
}) {
  return (
    <div className="space-y-1.5">
      <div className="text-[11px] uppercase tracking-wide text-app-text-muted">File</div>
      <div className="text-[11px] font-mono text-app-text-secondary truncate">{filePath}</div>
      {unifiedDiff ? (
        <pre className="text-[11px] font-mono whitespace-pre overflow-auto max-h-80 bg-app-hover/40 rounded px-2 py-1.5">
          {unifiedDiff.split('\n').map((line, i) => (
            <span key={i} className={
              line.startsWith('+') && !line.startsWith('+++') ? 'block text-green-500' :
              line.startsWith('-') && !line.startsWith('---') ? 'block text-red-500' :
              line.startsWith('@@') ? 'block text-blue-400' :
              'block text-app-text-secondary'
            }>{line || ' '}</span>
          ))}
        </pre>
      ) : (
        <div className="grid grid-cols-2 gap-1.5">
          {oldString && (
            <div>
              <div className="text-[11px] uppercase tracking-wide text-red-500/70 mb-0.5">- Before</div>
              <pre className="text-[11px] font-mono whitespace-pre-wrap overflow-auto max-h-72 bg-red-500/5 rounded px-2 py-1.5 text-app-text-secondary border-l-2 border-red-500/40">
                {oldString}
              </pre>
            </div>
          )}
          {newString && (
            <div>
              <div className="text-[11px] uppercase tracking-wide text-green-500/70 mb-0.5">+ After</div>
              <pre className="text-[11px] font-mono whitespace-pre-wrap overflow-auto max-h-72 bg-green-500/5 rounded px-2 py-1.5 text-app-text-secondary border-l-2 border-green-500/40">
                {newString}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Write ───────────────────────────────────────────────────────────────────

export function WriteCard({ filePath, content }: { filePath: string; content?: string }) {
  return (
    <div className="space-y-1.5">
      <div className="text-[11px] uppercase tracking-wide text-app-text-muted">New file</div>
      <div className="text-[11px] font-mono text-app-text-secondary truncate">{filePath}</div>
      {content && (
        <div>
          <div className="text-[11px] uppercase tracking-wide text-app-text-muted mb-0.5">
            Contents · {content.length.toLocaleString()} chars
          </div>
          <pre className="text-[11px] font-mono text-app-text-secondary whitespace-pre-wrap overflow-auto max-h-80 bg-green-500/5 rounded px-2 py-1.5 border-l-2 border-green-500/40">
            {content}
          </pre>
        </div>
      )}
    </div>
  );
}

// ── Search (Grep / Glob / WebSearch) ────────────────────────────────────────

export function SearchCard({ query, toolName, content, mode, numFiles, numMatches }: {
  query: string; toolName?: 'search' | 'grep' | 'glob' | 'web_search';
  content?: string; mode?: 'content' | 'files_with_matches' | 'count';
  numFiles?: number; numMatches?: number;
}) {
  const label = toolName === 'grep' ? 'Pattern' : toolName === 'glob' ? 'Glob' : 'Query';
  return (
    <div className="space-y-1.5">
      <div className="text-[11px] uppercase tracking-wide text-app-text-muted">
        {label} {mode ? `· ${mode}` : ''}
      </div>
      <pre className="text-[11px] font-mono text-app-text bg-app-hover/40 rounded px-2 py-1.5 whitespace-pre-wrap">
        {query}
      </pre>
      {(numFiles != null || numMatches != null) && (
        <div className="text-[11px] text-app-text-muted">
          {numFiles != null && `${numFiles} file${numFiles === 1 ? '' : 's'}`}
          {numFiles != null && numMatches != null && ' · '}
          {numMatches != null && `${numMatches} match${numMatches === 1 ? '' : 'es'}`}
        </div>
      )}
      {content && (
        <pre className="text-[11px] font-mono text-app-text-secondary whitespace-pre-wrap overflow-auto max-h-72 bg-app-hover/40 rounded px-2 py-1.5">
          {content}
        </pre>
      )}
    </div>
  );
}

// ── Fetch (WebFetch) ────────────────────────────────────────────────────────

export function FetchCard({ url, prompt, result, statusCode, bytes }: {
  url: string; prompt?: string; result?: string; statusCode?: number; bytes?: number;
}) {
  return (
    <div className="space-y-1.5">
      <div className="text-[11px] uppercase tracking-wide text-app-text-muted flex items-center gap-2">
        <span>URL</span>
        {typeof statusCode === 'number' && (
          <span className={`text-[11px] font-mono ${statusCode >= 400 ? 'text-red-500' : 'text-green-500'}`}>HTTP {statusCode}</span>
        )}
        {typeof bytes === 'number' && (
          <span className="text-[11px] text-app-text-muted">{(bytes / 1024).toFixed(1)} KB</span>
        )}
      </div>
      <a href={url} target="_blank" rel="noopener noreferrer" className="text-[11px] font-mono text-blue-500 hover:underline break-all block">
        {url}
      </a>
      {prompt && (
        <div>
          <div className="text-[11px] uppercase tracking-wide text-app-text-muted mb-0.5">Prompt</div>
          <pre className="text-[11px] text-app-text-secondary whitespace-pre-wrap bg-app-hover/40 rounded px-2 py-1.5">
            {prompt}
          </pre>
        </div>
      )}
      {result && (
        <div>
          <div className="text-[11px] uppercase tracking-wide text-app-text-muted mb-0.5">Response</div>
          <pre className="text-[11px] font-mono text-app-text-secondary whitespace-pre-wrap overflow-auto max-h-72 bg-app-hover/40 rounded px-2 py-1.5">
            {result}
          </pre>
        </div>
      )}
    </div>
  );
}

// ── Todo (TodoWrite) ────────────────────────────────────────────────────────

export function TodoCard({ items }: { items: Array<{ content: string; status: 'pending' | 'in_progress' | 'completed'; activeForm?: string }> }) {
  return (
    <ul className="space-y-1">
      {items.map((t, i) => (
        <li key={i} className="flex items-start gap-2 text-[12px]">
          <span className="mt-0.5 text-[12px] flex-shrink-0">
            {t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '◐' : '○'}
          </span>
          <span className={
            t.status === 'completed' ? 'text-app-text-muted line-through' :
            t.status === 'in_progress' ? 'text-app-text font-medium' :
            'text-app-text-secondary'
          }>
            {t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content}
          </span>
        </li>
      ))}
    </ul>
  );
}

// ── Sub-agent (Task) ────────────────────────────────────────────────────────

export function SubAgentCard({ subAgentType, description, actions, result, isRunning }: {
  subAgentType?: string; description?: string;
  actions: Array<{ index: number; toolName: string; summary?: string; status?: 'running' | 'success' | 'error' }>;
  result?: string;
  /**
   * From the parent ToolCall's own status, not derived from actions[].
   * Background/async agent runs finalize (success/error) without ever
   * streaming parent_tool_use_id-tagged events through SidechainTracker,
   * so actions[] can stay empty forever even after the row settles — fall
   * back to "no activity captured" instead of "starting…" once isRunning
   * is false, so the card doesn't look stuck.
   */
  isRunning?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      {(subAgentType || description) && (
        <div className="text-[11px] text-app-text-secondary">
          {subAgentType && <span className="font-mono text-purple-500">{subAgentType}</span>}
          {subAgentType && description && ' · '}
          {description}
        </div>
      )}
      {actions.length === 0 ? (
        <div className="text-[11px] italic text-app-text-muted">
          {isRunning ? 'Sub-agent starting…' : (result ? null : 'No activity captured.')}
        </div>
      ) : (
        <div>
          <div className="text-[11px] uppercase tracking-wide text-app-text-muted mb-0.5">
            Activity · {actions.length} step{actions.length === 1 ? '' : 's'}
          </div>
          <ul className="space-y-0.5 max-h-72 overflow-auto bg-app-hover/40 rounded px-2 py-1.5 border-l-2 border-purple-500/40">
            {actions.map((a) => (
              <li key={a.index} className="flex items-start gap-2 text-[11px] font-mono leading-snug">
                <span className="flex-shrink-0 text-app-text-muted w-4 text-right">{a.index + 1}.</span>
                <span className="flex-shrink-0 text-purple-500/80">[{a.toolName}]</span>
                <span className="flex-1 text-app-text-secondary truncate">{a.summary ?? ''}</span>
                <span className="flex-shrink-0">
                  {a.status === 'running' && <span className="text-app-text-muted">·</span>}
                  {a.status === 'success' && <span className="text-green-500">✓</span>}
                  {a.status === 'error' && <span className="text-red-500">✗</span>}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {result && (
        <div>
          <div className="text-[11px] uppercase tracking-wide text-app-text-muted mb-0.5">Final result</div>
          <pre className="text-[11px] text-app-text-secondary whitespace-pre-wrap overflow-auto max-h-56 bg-app-hover/40 rounded px-2 py-1.5">
            {result}
          </pre>
        </div>
      )}
    </div>
  );
}

// ── Plan (ExitPlanMode) ─────────────────────────────────────────────────────

export function PlanCard({ text }: { text: string }) {
  return (
    <div className="space-y-1.5">
      <div className="text-[11px] uppercase tracking-wide text-app-text-muted">Proposed plan</div>
      <pre className="text-[11px] text-app-text whitespace-pre-wrap bg-app-hover/40 rounded px-2 py-1.5 max-h-80 overflow-auto">
        {text}
      </pre>
    </div>
  );
}

// ── MCP namespaced tool ─────────────────────────────────────────────────────

export function McpCard({ server, tool, args, result }: {
  server: string; tool: string; args?: Record<string, unknown>; result?: string;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5 text-[11px]">
        <span className="px-1.5 py-0.5 rounded-full text-[11px] bg-amber-500/15 text-amber-700 dark:text-amber-400 font-medium">
          {server}
        </span>
        <span className="text-app-text-muted">·</span>
        <span className="font-mono text-app-text">{tool}</span>
      </div>
      {args && Object.keys(args).length > 0 && (
        <div>
          <div className="text-[11px] uppercase tracking-wide text-app-text-muted mb-0.5">Arguments</div>
          <pre className="text-[11px] font-mono text-app-text-secondary whitespace-pre-wrap overflow-auto max-h-40 bg-app-hover/40 rounded px-2 py-1.5">
            {JSON.stringify(args, null, 2)}
          </pre>
        </div>
      )}
      {result && (
        <div>
          <div className="text-[11px] uppercase tracking-wide text-app-text-muted mb-0.5">Result</div>
          <pre className="text-[11px] font-mono text-app-text-secondary whitespace-pre-wrap overflow-auto max-h-72 bg-app-hover/40 rounded px-2 py-1.5">
            {result}
          </pre>
        </div>
      )}
    </div>
  );
}

// ── Unknown / generic fallback ──────────────────────────────────────────────

export function UnknownCard({ args, result }: { args?: Record<string, unknown>; result?: string }) {
  return (
    <div className="space-y-1.5">
      {args && Object.keys(args).length > 0 && (
        <div>
          <div className="text-[11px] uppercase tracking-wide text-app-text-muted mb-0.5">Arguments</div>
          <pre className="text-[11px] font-mono text-app-text-secondary whitespace-pre-wrap overflow-auto max-h-40 bg-app-hover/40 rounded px-2 py-1.5">
            {JSON.stringify(args, null, 2)}
          </pre>
        </div>
      )}
      {result && (
        <div>
          <div className="text-[11px] uppercase tracking-wide text-app-text-muted mb-0.5">Result</div>
          <pre className="text-[11px] font-mono text-app-text-secondary whitespace-pre-wrap overflow-auto max-h-56 bg-app-hover/40 rounded px-2 py-1.5">
            {result}
          </pre>
        </div>
      )}
    </div>
  );
}

// ── Dispatcher ──────────────────────────────────────────────────────────────

export function ToolCardBody({ detail, isError, isRunning }: { detail: ToolCallDetail; isError?: boolean; isRunning?: boolean }) {
  switch (detail.type) {
    case 'shell':
      return <ShellCard command={detail.command} cwd={detail.cwd} output={detail.output} exitCode={detail.exitCode} isError={isError} />;
    case 'read':
      return <ReadCard filePath={detail.filePath} content={detail.content} offset={detail.offset} limit={detail.limit} />;
    case 'edit':
      return <EditCard filePath={detail.filePath} oldString={detail.oldString} newString={detail.newString} unifiedDiff={detail.unifiedDiff} />;
    case 'write':
      return <WriteCard filePath={detail.filePath} content={detail.content} />;
    case 'search':
      return <SearchCard query={detail.query} toolName={detail.toolName} content={detail.content} mode={detail.mode} numFiles={detail.numFiles} numMatches={detail.numMatches} />;
    case 'fetch':
      return <FetchCard url={detail.url} prompt={detail.prompt} result={detail.result} statusCode={detail.statusCode} bytes={detail.bytes} />;
    case 'todo':
      return <TodoCard items={detail.items} />;
    case 'sub_agent':
      return <SubAgentCard subAgentType={detail.subAgentType} description={detail.description} actions={detail.actions} result={detail.result} isRunning={isRunning} />;
    case 'plan':
      return <PlanCard text={detail.text} />;
    case 'mcp':
      return <McpCard server={detail.server} tool={detail.tool} args={detail.args} result={detail.result} />;
    case 'unknown':
      return <UnknownCard args={detail.raw.args} result={detail.raw.result} />;
  }
}

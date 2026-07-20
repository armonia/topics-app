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
 * (max-h-* with overflow-auto). Code payloads (Read/Write/Edit content, the
 * shell command) run through the SAME lazy hljs facade as markdown code
 * fences (CHAT-TOOL-04) — language derived from the file extension, plain
 * text fallback when unknown/oversize/not-yet-loaded.
 */

import { useMemo, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import type { ToolCallDetail } from '../../types';
import { highlightCode, langFromPath, subscribeHighlighter, highlighterReady } from '../../lib/syntaxHighlight';

/**
 * Monospace block with lazy syntax highlighting. hljs ESCAPES the source and
 * only wraps tokens in class-only <span>s, so the injected HTML is safe by
 * construction (same posture as MessageContent's CodeBlock). Until the
 * tokenizers land — or for unknown languages / oversize payloads — it renders
 * the plain text exactly like the previous raw <pre>.
 */
function HighlightedPre({ code, lang, className, testId, prefix }: {
  code: string; lang: string; className: string; testId?: string;
  /** Literal chrome rendered before the code, outside highlighting ("$ "). */
  prefix?: ReactNode;
}) {
  const ready = useSyncExternalStore(subscribeHighlighter, highlighterReady);
  const html = useMemo(
    () => (lang ? highlightCode(code, lang) : null),
    // `ready` re-runs the memo once the lazy tokenizers land.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [code, lang, ready],
  );
  return (
    // `tool-card-code` scopes the theme-aware hljs palette (index.css) —
    // tool card surfaces follow the app theme, unlike always-dark fences.
    <pre data-testid={testId} className={`tool-card-code ${className}`}>
      {prefix}
      {html ? <code dangerouslySetInnerHTML={{ __html: html }} /> : code}
    </pre>
  );
}

// ── Shell ───────────────────────────────────────────────────────────────────

export function ShellCard({ command, cwd, output, exitCode, isError }: {
  command: string; cwd?: string; output?: string; exitCode?: number | null; isError?: boolean;
}) {
  return (
    <div className="space-y-1">
      <HighlightedPre
        testId="tool-call-args"
        className="text-[11px] font-mono text-app-text whitespace-pre-wrap bg-app-hover/40 rounded px-2 py-1.5"
        prefix="$ "
        code={command}
        lang="bash"
      />
      {cwd && <div className="text-[11px] font-mono text-app-text-muted truncate">cwd: {cwd}</div>}
      {output && (
        <div>
          {typeof exitCode === 'number' && exitCode !== 0 && (
            <div className="text-[11px] font-mono text-red-500 mb-0.5">exit {exitCode}</div>
          )}
          <pre data-testid="tool-call-result" className={`text-[11px] font-mono whitespace-pre-wrap overflow-auto max-h-72 rounded px-2 py-1.5 ${isError ? 'text-red-500 bg-red-500/5' : 'text-app-text-secondary bg-app-hover/40'}`}>
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
    ? ` · lines ${offset ?? 0}${limit ? `–${(offset ?? 0) + limit}` : '+'}`
    : '';
  return (
    <div className="space-y-1">
      <div data-testid="tool-call-args" className="text-[11px] font-mono text-app-text-secondary truncate">{filePath}{meta}</div>
      {content && (
        <HighlightedPre
          testId="tool-call-result"
          className="text-[11px] font-mono text-app-text-secondary whitespace-pre-wrap overflow-auto max-h-80 bg-app-hover/40 rounded px-2 py-1.5"
          code={content}
          lang={langFromPath(filePath)}
        />
      )}
    </div>
  );
}

// ── Edit ────────────────────────────────────────────────────────────────────

export function EditCard({ filePath, oldString, newString, unifiedDiff }: {
  filePath: string; oldString?: string; newString?: string; unifiedDiff?: string;
}) {
  return (
    <div className="space-y-1">
      <div data-testid="tool-call-args" className="text-[11px] font-mono text-app-text-secondary truncate">{filePath}</div>
      {unifiedDiff ? (
        <pre data-testid="tool-call-result" className="text-[11px] font-mono whitespace-pre overflow-auto max-h-80 bg-app-hover/40 rounded px-2 py-1.5">
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
              <HighlightedPre
                className="text-[11px] font-mono whitespace-pre-wrap overflow-auto max-h-72 bg-red-500/5 rounded px-2 py-1.5 text-app-text-secondary border-l-2 border-red-500/40"
                code={oldString}
                lang={langFromPath(filePath)}
              />
            </div>
          )}
          {newString && (
            <div>
              <div className="text-[11px] uppercase tracking-wide text-green-500/70 mb-0.5">+ After</div>
              <HighlightedPre
                testId="tool-call-result"
                className="text-[11px] font-mono whitespace-pre-wrap overflow-auto max-h-72 bg-green-500/5 rounded px-2 py-1.5 text-app-text-secondary border-l-2 border-green-500/40"
                code={newString}
                lang={langFromPath(filePath)}
              />
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
    <div className="space-y-1">
      <div data-testid="tool-call-args" className="text-[11px] font-mono text-app-text-secondary truncate">
        {filePath}{content ? ` · ${content.length.toLocaleString()} chars` : ''}
      </div>
      {content && (
        <HighlightedPre
          testId="tool-call-result"
          className="text-[11px] font-mono text-app-text-secondary whitespace-pre-wrap overflow-auto max-h-80 bg-green-500/5 rounded px-2 py-1.5 border-l-2 border-green-500/40"
          code={content}
          lang={langFromPath(filePath)}
        />
      )}
    </div>
  );
}

// ── Search (Grep / Glob / WebSearch) ────────────────────────────────────────

export function SearchCard({ query, content, mode, numFiles, numMatches }: {
  query: string; toolName?: 'search' | 'grep' | 'glob' | 'web_search';
  content?: string; mode?: 'content' | 'files_with_matches' | 'count';
  numFiles?: number; numMatches?: number;
}) {
  return (
    <div className="space-y-1">
      <pre data-testid="tool-call-args" className="text-[11px] font-mono text-app-text bg-app-hover/40 rounded px-2 py-1.5 whitespace-pre-wrap">
        {query}
      </pre>
      {(mode != null || numFiles != null || numMatches != null) && (
        <div className="text-[11px] text-app-text-muted">
          {[
            mode,
            numFiles != null ? `${numFiles} file${numFiles === 1 ? '' : 's'}` : null,
            numMatches != null ? `${numMatches} match${numMatches === 1 ? '' : 'es'}` : null,
          ].filter(Boolean).join(' · ')}
        </div>
      )}
      {content && (
        <pre data-testid="tool-call-result" className="text-[11px] font-mono text-app-text-secondary whitespace-pre-wrap overflow-auto max-h-72 bg-app-hover/40 rounded px-2 py-1.5">
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
    <div className="space-y-1">
      <div className="flex items-baseline gap-2 min-w-0">
        <a data-testid="tool-call-args" href={url} target="_blank" rel="noopener noreferrer" className="text-[11px] font-mono text-blue-500 hover:underline break-all">
          {url}
        </a>
        {typeof statusCode === 'number' && (
          <span className={`text-[11px] font-mono flex-shrink-0 ${statusCode >= 400 ? 'text-red-500' : 'text-green-500'}`}>{statusCode}</span>
        )}
        {typeof bytes === 'number' && (
          <span className="text-[11px] text-app-text-muted flex-shrink-0">{(bytes / 1024).toFixed(1)} KB</span>
        )}
      </div>
      {prompt && (
        <pre className="text-[11px] text-app-text-secondary whitespace-pre-wrap bg-app-hover/40 rounded px-2 py-1.5">
          {prompt}
        </pre>
      )}
      {result && (
        <pre data-testid="tool-call-result" className="text-[11px] font-mono text-app-text-secondary whitespace-pre-wrap overflow-auto max-h-72 bg-app-hover/40 rounded px-2 py-1.5">
          {result}
        </pre>
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

/**
 * Args block shared by McpCard/UnknownCard: short payloads render as a single
 * compact line, only genuinely structured ones get the pretty-printed block.
 */
function ArgsPre({ args }: { args: Record<string, unknown> }) {
  const oneLine = JSON.stringify(args);
  const text = oneLine.length <= 100 ? oneLine : JSON.stringify(args, null, 2);
  return (
    <pre data-testid="tool-call-args" className="text-[11px] font-mono text-app-text-secondary whitespace-pre-wrap overflow-auto max-h-40 bg-app-hover/40 rounded px-2 py-1.5">
      {text}
    </pre>
  );
}

export function McpCard({ args, result }: {
  server: string; tool: string; args?: Record<string, unknown>; result?: string;
}) {
  // Server + tool name already live in the row header — repeating them here
  // as a pill row was pure noise. The body is just args → result.
  return (
    <div className="space-y-1">
      {args && Object.keys(args).length > 0 && <ArgsPre args={args} />}
      {result && (
        <pre data-testid="tool-call-result" className="text-[11px] font-mono text-app-text-secondary whitespace-pre-wrap overflow-auto max-h-72 bg-app-hover/40 rounded px-2 py-1.5">
          {result}
        </pre>
      )}
    </div>
  );
}

// ── Unknown / generic fallback ──────────────────────────────────────────────

export function UnknownCard({ args, result }: { args?: Record<string, unknown>; result?: string }) {
  return (
    <div className="space-y-1">
      {args && Object.keys(args).length > 0 && <ArgsPre args={args} />}
      {result && (
        <pre data-testid="tool-call-result" className="text-[11px] font-mono text-app-text-secondary whitespace-pre-wrap overflow-auto max-h-56 bg-app-hover/40 rounded px-2 py-1.5">
          {result}
        </pre>
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

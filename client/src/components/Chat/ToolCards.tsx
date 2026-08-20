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

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useT } from '../../hooks/useT';
import type { ReactNode } from 'react';
import type { Components } from 'react-markdown';
import type { ToolCallDetail } from '../../types';
import { ChatMarkdown } from '../ChatMarkdown';
import { highlightCode, langFromPath, subscribeHighlighter, highlighterReady } from '../../lib/syntaxHighlight';
import { clampBody, formatBytes } from './clampBody';
import { unwrapStoredToolResult } from '../../../../shared/tool-result-text';
import { skillInstructions } from './toolCardBody';
import { useBackgroundShell, parseShellIdFromStartResult } from '../../hooks/useBackgroundShell';
import { useWaitedProcess } from '../../hooks/useWaitedProcess';
import type { LiveBackgroundShell } from '../../hooks/useBackgroundShell';

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

// ── Shell in background: il pezzo che si aggiorna da solo ───────────────────

/**
 * La coda VIVA di una shell lasciata in background, letta dal registro dei
 * processi invece che dal transcript.
 *
 * Il transcript dice cosa c'era quando il tool ha risposto e non lo dice mai
 * più; il registro sa se la shell corre ancora, quanto output ha prodotto da
 * allora e con che codice è uscita. Quando il registro non la conosce — chat
 * vecchia, server riavviato — questo blocco non compare e la card resta quella
 * di prima: nessuna riga di segnaposto per uno stato che non abbiamo.
 */
function LiveShellTail({ live }: { live: LiveBackgroundShell }) {
  const tr = useT();
  if (!live.known) return null;
  const running = live.status === 'running';
  return (
    <div className="space-y-1" data-testid="shell-live">
      <div className="flex items-center gap-1.5 text-[11px] text-app-text-muted">
        <span
          data-testid="shell-live-status"
          data-status={running ? 'running' : 'ended'}
          className={`inline-block w-1.5 h-1.5 rounded-full ${running ? 'bg-emerald-500 animate-pulse' : (live.status === 'error' ? 'bg-red-500' : 'bg-app-text-muted')}`}
        />
        <span>{running ? 'in corso' : (live.exitCode != null ? `uscita ${live.exitCode}` : 'terminata')}</span>
      </div>
      {live.truncatedLines > 0 && (
        <div className="text-[11px] text-app-text-muted">{tr('tool.logTruncated', { n: live.truncatedLines })}</div>
      )}
      {live.output && (
        <pre
          data-testid="shell-live-output"
          className="tool-card-code text-[11px] font-mono text-app-text-secondary whitespace-pre-wrap overflow-auto max-h-72 bg-app-hover/40 rounded px-2 py-1.5"
        >
          {live.output}
        </pre>
      )}
    </div>
  );
}

// ── Shell ───────────────────────────────────────────────────────────────────

export function ShellCard({ command, cwd, output, exitCode, isError, background, sessionKey }: {
  command: string; cwd?: string; output?: string; exitCode?: number | null; isError?: boolean;
  /** `run_in_background`: il risultato è l'id della shell, non il suo output. */
  background?: boolean; sessionKey?: string;
}) {
  // L'id sta solo dentro il testo del risultato («Command running in background
  // with ID: bash_1»): il `detail` porta il comando, non l'id.
  const liveShellId = background && !isError ? parseShellIdFromStartResult(output) : undefined;
  const live = useBackgroundShell(liveShellId, sessionKey);
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
          <pre data-testid="tool-call-result" className={`tool-card-code text-[11px] font-mono whitespace-pre-wrap overflow-auto max-h-72 rounded px-2 py-1.5 ${isError ? 'text-red-500 bg-red-500/5' : 'text-app-text-secondary bg-app-hover/40'}`}>
            {output}
          </pre>
        </div>
      )}
      <LiveShellTail live={live} />
    </div>
  );
}

// ── Read ────────────────────────────────────────────────────────────────────

export function ReadCard({ filePath, content, offset, limit }: {
  filePath: string; content?: string; offset?: number; limit?: number;
}) {
  const meta = offset != null || limit != null
    ? ` · lines ${offset ?? 0}${limit ? `-${(offset ?? 0) + limit}` : '+'}`
    : '';
  return (
    <div className="space-y-1">
      <div data-testid="tool-call-args" className="text-[11px] font-mono text-app-text-secondary truncate">{filePath}{meta}</div>
      {content && (
        <HighlightedPre
          testId="tool-call-result"
          className="text-[11px] font-mono text-app-text-secondary whitespace-pre-wrap overflow-auto max-h-72 bg-app-hover/40 rounded px-2 py-1.5"
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
        <pre data-testid="tool-call-result" className="tool-card-code text-[11px] font-mono whitespace-pre overflow-auto max-h-72 bg-app-hover/40 rounded px-2 py-1.5">
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
        // Due colonne solo quando ci sono davvero due lati: con uno solo, metà
        // card restava bianca. `min-w-0` sulle celle o il codice lungo le
        // allarga invece di scorrere dentro il proprio riquadro.
        <div className={`grid gap-1.5 [&>*]:min-w-0 ${oldString && newString ? 'grid-cols-2' : 'grid-cols-1'}`}>
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
          className="text-[11px] font-mono text-app-text-secondary whitespace-pre-wrap overflow-auto max-h-72 bg-green-500/5 rounded px-2 py-1.5 border-l-2 border-green-500/40"
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
      <pre data-testid="tool-call-args" className="tool-card-code text-[11px] font-mono text-app-text bg-app-hover/40 rounded px-2 py-1.5 whitespace-pre-wrap">
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
        <pre data-testid="tool-call-result" className="tool-card-code text-[11px] font-mono text-app-text-secondary whitespace-pre-wrap overflow-auto max-h-72 bg-app-hover/40 rounded px-2 py-1.5">
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
        <pre className="tool-card-code text-[11px] text-app-text-secondary whitespace-pre-wrap bg-app-hover/40 rounded px-2 py-1.5">
          {prompt}
        </pre>
      )}
      {result && <ClampedPre text={result} />}
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
                {/* `w-6`: al decimo passo «10.» non ci stava più in `w-4` e
                    spingeva la colonna del tool. */}
                <span className="flex-shrink-0 w-6 text-right tabular-nums text-app-text-muted">{a.index + 1}.</span>
                {/* Il nome di un tool MCP è lungo quanto vuole: se non si
                    restringe, a essere tagliato è il riassunto accanto. */}
                <span className="min-w-0 shrink max-w-[45%] truncate text-purple-500/80">[{a.toolName}]</span>
                <span className="flex-1 min-w-0 text-app-text-secondary truncate">{a.summary ?? ''}</span>
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
          <ClampedPre text={result} />
        </div>
      )}
    </div>
  );
}

// ── Plan (ExitPlanMode, o il piano scritto in ~/.claude/plans) ──────────────

/**
 * Mappa di renderer VUOTA, ma module-const: `ChatMarkdown` memoizza il parse
 * sul riferimento, quindi una `{}` scritta inline rifarebbe l'AST a ogni
 * render. I renderer ricchi di `MessageContent` (menzioni, media, mermaid) qui
 * non servono e non si possono importare: ToolCards è a valle di
 * MessageContent nel grafo, e prenderli formerebbe un ciclo.
 */
const PLAN_MARKDOWN_COMPONENTS: Components = {};

/**
 * Il piano su cui stai per dire sì o no.
 *
 * Era un `<pre>`: un piano è markdown — titolo, passi numerati, grassetti — e
 * in monospazio a 11px si leggeva come un file di log, cioè come la cosa che
 * si scorre senza leggere. È l'unico testo di questa chat su cui si prende una
 * DECISIONE, quindi qui si rende per come è scritto. Il pannello con le due
 * scelte lo aggiunge `<ToolCallRow>` sotto, quando il turno resta in attesa.
 */
export function PlanCard({ text }: { text: string }) {
  return (
    <div className="space-y-1.5">
      <div className="text-[11px] uppercase tracking-wide text-app-text-muted">Piano proposto</div>
      <div
        data-testid="plan-card-body"
        className="prose prose-sm max-w-none text-[12px] text-app-text bg-app-hover/40 rounded px-2 py-1.5 max-h-72 overflow-auto prose-p:my-0.5 prose-headings:my-1 prose-headings:text-[13px] prose-ul:my-0.5 prose-ol:my-0.5 prose-li:my-0 prose-pre:my-1 prose-code:text-[11px]"
      >
        <ChatMarkdown components={PLAN_MARKDOWN_COMPONENTS}>{text}</ChatMarkdown>
      </div>
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
    <pre data-testid="tool-call-args" className="tool-card-code text-[11px] font-mono text-app-text-secondary whitespace-pre-wrap overflow-auto max-h-40 bg-app-hover/40 rounded px-2 py-1.5">
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
      {result && <ClampedPre text={result} />}
    </div>
  );
}

// ── Clamped result block (CHAT-PERF-01) ─────────────────────────────────────

/**
 * Result <pre> that collapses multi-MB bodies behind a "show all" toggle so a
 * pathological tool output never lays out megabytes of text inline. Shared by
 * every result-bearing card; preserves the `tool-call-result` test hook.
 */
function ClampedPre({ text: raw, testId = 'tool-call-result', maxH = 'max-h-72' }: {
  text: string; testId?: string; maxH?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  // I messaggi VECCHI portano il risultato ancora nella forma grezza del filo —
  // l'array di blocchi serializzato — perché l'adapter non sapeva leggerlo
  // (server/providers/claude-code.ts, ora corretto). Erano 4.735 risultati su
  // 32.492: quasi tutti i tool MCP e ToolSearch, che mostravano `[{"type":
  // "text","text":"…"}]` al posto del testo. Qui si rileggono per come sono,
  // senza riscrivere il DB per un difetto di sola resa.
  const text = useMemo(() => unwrapStoredToolResult(raw), [raw]);
  const { shown, oversized, length } = clampBody(text);
  return (
    <div className="space-y-1">
      <pre data-testid={testId} className={`tool-card-code text-[11px] font-mono text-app-text-secondary whitespace-pre-wrap overflow-auto ${maxH} bg-app-hover/40 rounded px-2 py-1.5`}>
        {expanded ? text : shown}
        {oversized && !expanded && <span className="text-app-text-muted">…</span>}
      </pre>
      {oversized && (
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="text-[11px] text-blue-500 hover:underline"
        >
          {expanded ? 'Mostra meno' : `Mostra tutto (${formatBytes(length)})`}
        </button>
      )}
    </div>
  );
}

/** Back-compat alias used by the background/harness cards. */
function ResultPre({ text }: { text: string }) {
  return <ClampedPre text={text} />;
}

// ── Monitor (long-lived event watcher) ──────────────────────────────────────
//
// Resta statica, e non per dimenticanza: un `Monitor` non passa dal registro
// delle shell — non ha un id con cui ritrovarlo, il CLI ne annuncia solo la
// descrizione e la sorgente. Agganciarlo vorrebbe dire un registro suo, che
// oggi non esiste: qui una card viva la si può dare solo a chi un id ce l'ha.

export function MonitorCard({ description, command, wsUrl, persistent, result }: {
  description: string; command?: string; wsUrl?: string; persistent?: boolean; result?: string;
}) {
  return (
    <div className="space-y-1">
      {description && <div className="text-[12px] text-app-text">{description}</div>}
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-app-text-muted">
        {persistent && <span className="px-1.5 py-0.5 rounded bg-app-hover/60 font-mono">persistent</span>}
        {wsUrl && <span className="font-mono text-blue-500 break-all">{wsUrl}</span>}
      </div>
      {command && (
        <HighlightedPre code={command} lang="bash" className="text-[11px] font-mono text-app-text whitespace-pre-wrap overflow-auto max-h-40 bg-app-hover/40 rounded px-2 py-1.5" prefix={<span className="text-app-text-muted select-none">$ </span>} />
      )}
      {result && <ResultPre text={result} />}
    </div>
  );
}

// ── Wait (attesa di un processo) ────────────────────────────────────────────
//
// Questa card e' la risposta alla riga scritta sopra su `MonitorCard`: qui l'id
// c'e', quindi la card puo' essere VIVA. Mentre il processo gira il cronometro
// va e il pallino pulsa; quando esce, il pallino si spegne e compare il codice
// di uscita — anche se la risposta del tool, letta mezz'ora fa, diceva soltanto
// «ancora in esecuzione». E' esattamente la domanda che uno si fa riaprendo la
// chat: «poi com'e' finita?».

function elapsedLabel(fromIso: string | undefined, nowMs: number): string | undefined {
  if (!fromIso) return undefined;
  const started = Date.parse(fromIso);
  if (!Number.isFinite(started)) return undefined;
  const secs = Math.max(0, Math.round((nowMs - started) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

export function WaitCard({ processId, until, timeoutMs, result, sessionKey }: {
  processId: string; until?: string; timeoutMs?: number; result?: string; sessionKey?: string;
}) {
  const live = useWaitedProcess(processId, sessionKey);
  const running = live.status === 'running';
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running]);
  // Il cronometro si ferma su `completedAt`, non su «adesso»: riaprendo la
  // chat domani, «adesso» direbbe che quel build e' durato quindici ore.
  const fine = live.completedAt ? Date.parse(live.completedAt) : now;
  const elapsed = elapsedLabel(live.startedAt, fine);

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-app-text-muted">
        <span className={`inline-block w-1.5 h-1.5 rounded-full ${running ? 'bg-green-500 animate-pulse' : live.status === 'error' ? 'bg-red-500' : 'bg-app-text-muted/50'}`} />
        <span className="font-mono text-app-text-secondary">{live.scriptName || processId}</span>
        {live.known
          ? <span>{running ? 'running' : live.status === 'error' ? 'failed' : 'finished'}{live.exitCode != null ? ` · exit ${live.exitCode}` : ''}</span>
          : <span>waiting</span>}
        {elapsed && <span className="font-mono">{elapsed}</span>}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-app-text-muted">
        {until && <span className="px-1.5 py-0.5 rounded bg-app-hover/60 font-mono">until /{until}/</span>}
        {timeoutMs != null && <span className="px-1.5 py-0.5 rounded bg-app-hover/60 font-mono">max {Math.round(timeoutMs / 1000)}s</span>}
      </div>
      {result && <ResultPre text={result} />}
    </div>
  );
}

// ── BashOutput / KillShell (background-shell lifecycle) ──────────────────────

export function BashOutputCard({ shellId, filter, output, sessionKey }: {
  shellId: string; filter?: string; output?: string; sessionKey?: string;
}) {
  const live = useBackgroundShell(shellId, sessionKey);
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-app-text-muted">
        <span className="font-mono">shell <span className="text-app-text-secondary">{shellId}</span></span>
        {filter && <span className="font-mono">filter <span className="text-app-text-secondary">/{filter}/</span></span>}
      </div>
      {/* Con il registro la lettura di allora è un doppione della coda viva, che
          contiene già quel pezzo e tutto quello venuto dopo: si mostra l'una O
          l'altra, mai le due insieme. Il `filter` fa eccezione — lì il testo
          nel transcript è un SOTTOINSIEME scelto dall'agente, e la coda intera
          non lo sostituisce. */}
      {(!live.known || filter) && output && <ResultPre text={output} />}
      <LiveShellTail live={live} />
    </div>
  );
}

export function KillShellCard({ shellId, result }: { shellId: string; result?: string }) {
  return (
    <div className="space-y-1">
      <div className="text-[11px] text-app-text-muted font-mono">shell <span className="text-app-text-secondary">{shellId}</span></div>
      {result && <ResultPre text={result} />}
    </div>
  );
}

// ── NotebookEdit ────────────────────────────────────────────────────────────

export function NotebookEditCard({ notebookPath, cellId, editMode, cellType }: {
  notebookPath: string; cellId?: string; editMode?: string; cellType?: string;
}) {
  return (
    <div className="space-y-1">
      <div className="text-[11px] font-mono text-app-text-secondary break-all">{notebookPath}</div>
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-app-text-muted">
        {editMode && <span className="px-1.5 py-0.5 rounded bg-app-hover/60 font-mono">{editMode}</span>}
        {cellType && <span className="font-mono">{cellType}</span>}
        {cellId && <span className="font-mono">cell <span className="text-app-text-secondary">{cellId}</span></span>}
      </div>
    </div>
  );
}

// ── Skill ───────────────────────────────────────────────────────────────────

/**
 * Il corpo di una `Skill`: le ISTRUZIONI che la skill ha caricato.
 *
 * Non c'è più la riga con `/nome`: quel nome sta già nell'intestazione della
 * riga, e riscriverlo qui sotto era la stessa cosa detta due volte (McpCard
 * l'aveva già tolto per la stessa ragione). E non c'è più «Launching skill: X»,
 * che era l'unica cosa che la CLI restituisce e non dice niente che
 * l'intestazione non dica già: al suo posto ora arriva il corpo vero, che il
 * provider stacca dall'evento iniettato invece di lasciarlo colare nella
 * risposta. I messaggi vecchi, che quel corpo non ce l'hanno, restano con la
 * card vuota — e vuota resta, senza il segnaposto.
 */
export function SkillCard({ result }: { result?: string }) {
  const body = skillInstructions(result);
  if (!body) return null;
  return (
    <div className="space-y-1">
      <div className="text-[11px] uppercase tracking-wide text-app-text-muted">Istruzioni caricate</div>
      <ClampedPre text={body} />
    </div>
  );
}

// ── SlashCommand ─────────────────────────────────────────────────────────────

/** Come la SkillCard: il comando è già nell'intestazione della riga, qui sotto
 *  ci va solo quello che ha prodotto. */
export function SlashCommandCard({ result }: { command?: string; result?: string }) {
  if (!result) return null;
  return <ClampedPre text={result} />;
}

// ── LSP (code intelligence) ─────────────────────────────────────────────────

export function LspCard({ operation, filePath, symbol, result }: {
  operation: string; filePath?: string; symbol?: string; result?: string;
}) {
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <span className="font-mono text-app-text">{operation}</span>
        {symbol && <span className="font-mono text-app-text-secondary">{symbol}</span>}
        {filePath && <span className="font-mono text-app-text-muted break-all">{filePath}</span>}
      </div>
      {result && <ResultPre text={result} />}
    </div>
  );
}

// ── Unknown / generic fallback ──────────────────────────────────────────────

export function UnknownCard({ args, result }: { args?: Record<string, unknown>; result?: string }) {
  return (
    <div className="space-y-1">
      {args && Object.keys(args).length > 0 && <ArgsPre args={args} />}
      {result && <ClampedPre text={result} />}
    </div>
  );
}

// ── Dispatcher ──────────────────────────────────────────────────────────────


export function ToolCardBody({ detail, isError, isRunning, sessionKey }: {
  detail: ToolCallDetail; isError?: boolean; isRunning?: boolean;
  /** Serve alle sole card delle shell in background: è la metà della chiave
   *  con cui la shell sta nel registro dei processi. */
  sessionKey?: string;
}) {
  switch (detail.type) {
    case 'shell':
      return <ShellCard command={detail.command} cwd={detail.cwd} output={detail.output} exitCode={detail.exitCode} isError={isError} background={detail.background} sessionKey={sessionKey} />;
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
    case 'monitor':
      return <MonitorCard description={detail.description} command={detail.command} wsUrl={detail.wsUrl} persistent={detail.persistent} result={detail.result} />;
    case 'wait':
      return <WaitCard processId={detail.processId} until={detail.until} timeoutMs={detail.timeoutMs} result={detail.result} sessionKey={sessionKey} />;
    case 'bash_output':
      return <BashOutputCard shellId={detail.shellId} filter={detail.filter} output={detail.output} sessionKey={sessionKey} />;
    case 'kill_shell':
      return <KillShellCard shellId={detail.shellId} result={detail.result} />;
    case 'notebook_edit':
      return <NotebookEditCard notebookPath={detail.notebookPath} cellId={detail.cellId} editMode={detail.editMode} cellType={detail.cellType} />;
    case 'skill':
      return <SkillCard result={detail.result} />;
    case 'slash_command':
      return <SlashCommandCard result={detail.result} />;
    case 'lsp':
      return <LspCard operation={detail.operation} filePath={detail.filePath} symbol={detail.symbol} result={detail.result} />;
    case 'unknown':
      return <UnknownCard args={detail.raw.args} result={detail.raw.result} />;
  }
}

import { createElement, useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronRight, HelpCircle, Loader2, X } from 'lucide-react';
import type { ToolCall, ToolUserResponse } from '../../types';
import { resolveToolDetail, buildToolDisplayLabel } from './toolDetail';
import { ToolCardBody } from './ToolCards';
import { iconForDetail } from './toolIcons';
import { ToolInputForm } from './ToolInputForm';
import { formatDurationMs } from './toolGrouping';
import { chatApi } from '../../lib/api';

/**
 * Live elapsed readout for a running call — ticks every second from `since`.
 * The "hot" signal that the agent is actually inside this tool. Hidden for
 * the first ~second so instant tools don't blink a "0.9s" in and out.
 */
export function ElapsedTimer({ since }: { since: number }) {
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const ms = Date.now() - since;
  if (ms < 900) return null;
  return (
    <span className="text-[10px] tabular-nums text-app-text-muted" data-testid="tool-elapsed">
      {formatDurationMs(ms)}
    </span>
  );
}

/** Running must persist this long before the body auto-opens — instant tools
 *  (a sub-250ms Read) never flash a panel open and closed (CHAT-TOOL-03). */
const AUTO_OPEN_DELAY_MS = 250;
/** Once auto-opened, the body stays visible at least this long even if the
 *  tool finishes earlier, so short tools remain readable. */
const AUTO_OPEN_MIN_DWELL_MS = 1500;

interface Props {
  toolCall: ToolCall;
  /**
   * Optional override for the row label. Defaults to the canonical
   * display name from `buildToolDisplayLabel(detail)` (e.g. "Read",
   * "Shell"). Provider-specific renderers can pass a richer label.
   */
  label?: string;
  /**
   * Session key the tool belongs to — required to submit the user's
   * answer when `toolCall.status === 'waiting_for_input'`. Absent
   * disables the input form (the row still renders, with a hint).
   */
  sessionKey?: string;
}

/**
 * One inline tool-call row. Borderless, single-line header (chevron, icon,
 * name + summary, status); click to reveal a typed body card matching the
 * tool kind (shell terminal, read content, edit diff, sub-agent log, etc.).
 *
 * The detail comes from `tc.detail` when the server's normalizer set it; the
 * client falls back to `deriveToolDetail` for legacy messages persisted
 * before the normalization layer existed. Both paths land in the same
 * `<ToolCardBody>` dispatcher so a Bash tool from 6 months ago and one
 * streaming right now render identically.
 */
export function ToolCallRow({ toolCall, label, sessionKey }: Props) {
  const [open, setOpen] = useState(false);

  // Resolve the detail (server-provided or fallback derivation) and the
  // user-facing display name + summary. Sub-agent rows are auto-expanded
  // because their action log IS the primary signal — collapsed they'd hide
  // the entire reason for showing the row.
  const detail = resolveToolDetail(toolCall);
  const display = buildToolDisplayLabel(detail, toolCall.name);
  const Icon = iconForDetail(detail);
  const status = toolCall.status ?? 'pending';
  const isRunning = status === 'pending' || status === 'running';
  const isWaiting = status === 'waiting_for_input';
  const isError = status === 'error';

  // Auto-open rows that NEED to be open: sub-agent (action log is the
  // primary signal), waiting_for_input (the form is the row's whole
  // reason for showing), and RUNNING tools — the open body is the live
  // preview of what the agent is doing right now; it collapses back on
  // completion so finished rows stay compact. Honor user toggles afterwards.
  //
  // CHAT-TOOL-03 anti-flash gating: the running auto-open engages only after
  // AUTO_OPEN_DELAY_MS of sustained running (instant tools never flash), and
  // once engaged it lingers AUTO_OPEN_MIN_DWELL_MS past completion so a
  // sub-second tool stays readable instead of blinking.
  const [userToggled, setUserToggled] = useState(false);
  const [autoOpen, setAutoOpen] = useState(false);
  const autoOpenedAtRef = useRef(0);
  useEffect(() => {
    if (isRunning) {
      const t = setTimeout(() => {
        autoOpenedAtRef.current = Date.now();
        setAutoOpen(true);
      }, AUTO_OPEN_DELAY_MS);
      return () => clearTimeout(t);
    }
    if (autoOpen) {
      const residual = Math.max(0, AUTO_OPEN_MIN_DWELL_MS - (Date.now() - autoOpenedAtRef.current));
      const t = setTimeout(() => setAutoOpen(false), residual);
      return () => clearTimeout(t);
    }
  }, [isRunning, autoOpen]);
  const effectiveOpen = userToggled
    ? open
    : (open || detail.type === 'sub_agent' || isWaiting || autoOpen);

  const onToggle = () => {
    setUserToggled(true);
    setOpen((v) => !v);
  };

  return (
    <div
      data-testid={`tool-call-row-${toolCall.id}`}
      className={`text-[12px] rounded-md transition-colors ${
        // "In use" state must be unmissable: the active tool gets a soft
        // primary tint + hairline ring (negative margin keeps the text
        // column aligned with settled rows). Settled rows stay flat.
        isRunning ? 'bg-primary/5 ring-1 ring-primary/10 -mx-1.5 px-1.5' : ''
      }`}
    >
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-2 py-1 text-left text-app-text-secondary hover:text-app-text transition-colors"
      >
        {effectiveOpen ? <ChevronDown size={12} className="text-app-text-muted flex-shrink-0" /> : <ChevronRight size={12} className="text-app-text-muted flex-shrink-0" />}
        {/* `Icon` is a stable Lucide component from iconForDetail()'s static
            lookup, not one defined during render; createElement is the
            lint-clean equivalent of `<Icon/>` (react-hooks/static-components). */}
        {createElement(Icon, { size: 13, className: `flex-shrink-0 ${isRunning ? 'text-primary' : 'text-app-text-muted'}` })}
        {/* Claude Code-style header: `Shell(bun test)` / `Read(App.tsx)` —
            the WHAT sits inside the parens at full contrast instead of a
            timid muted afterthought. Truncation may eat the closing paren
            on long args; that's the familiar CLI look. */}
        <span data-testid="tool-call-name" className={`flex-shrink-0 font-medium ${isRunning ? 'text-primary' : 'text-app-text'}`}>{label ?? display.name}</span>
        {display.summary && (
          <span className="text-[11.5px] text-app-text-secondary truncate font-mono">
            ({display.summary})
          </span>
        )}
        <span className="ml-auto flex-shrink-0 inline-flex items-center gap-1.5" data-testid={`tool-call-status-${toolCall.id}`} data-status={status}>
          {/* Real-usage duration: live ticking elapsed while running (the
              "hot" signal the agent is inside this tool), settled span once
              the result lands. Legacy rows without timestamps show nothing. */}
          {isRunning && typeof toolCall.startedAt === 'number' && (
            <ElapsedTimer since={toolCall.startedAt} />
          )}
          {!isRunning && typeof toolCall.startedAt === 'number' && typeof toolCall.endedAt === 'number' && toolCall.endedAt >= toolCall.startedAt && (
            <span className="text-[10px] tabular-nums text-app-text-muted" data-testid="tool-duration">
              {formatDurationMs(toolCall.endedAt - toolCall.startedAt)}
            </span>
          )}
          {/* `waiting_for_input` is the new state: spinner is misleading
              ("we're working on it") because we're actually blocked on
              the user. Show a help-circle accent instead, matching the
              banner inside the form. Falls back to spinner for the
              pending/running cases that still mean the agent is busy. */}
          {isWaiting && <HelpCircle size={11} className="text-amber-500" />}
          {isRunning && <Loader2 size={11} className="animate-spin text-primary" />}
          {status === 'success' && <Check size={11} className="text-green-500" />}
          {status === 'error' && <X size={11} className="text-red-500" />}
        </span>
      </button>
      {effectiveOpen && (
        <div className="ml-5 pb-1.5">
          {/* Pending input form takes precedence: when the agent is asking
              the user, the regular ToolCardBody (args/result preview) is
              not the primary signal — the form is. We still render the
              args summary above for context. */}
          {isWaiting && toolCall.userInputSchema && sessionKey ? (
            <ToolInputForm
              schema={toolCall.userInputSchema}
              toolCallId={toolCall.id}
              onSubmit={async (response: ToolUserResponse) => {
                // The WS broadcast that follows will flip status →
                // 'running' and persist `userResponse`; we don't need
                // to update local state here. If the server rejects
                // (404/502/503) the chatApi throws an ApiError with the
                // message attached, which `ToolInputForm` surfaces inline.
                await chatApi.toolResponse(sessionKey, toolCall.id, response);
              }}
            />
          ) : isWaiting && !sessionKey ? (
            <div className="text-[11px] text-amber-600 bg-amber-500/10 rounded px-2 py-1">
              The agent is asking for input but this view has no session context. Reload to answer.
            </div>
          ) : (
            <ToolCardBody detail={detail} isError={isError} isRunning={isRunning} />
          )}
          {toolCall.userResponse && status !== 'waiting_for_input' && (
            <div className="mt-1.5 text-[11px] text-app-text-muted">
              <span className="uppercase tracking-wide">Answered</span>
              <span className="ml-1 font-mono">
                {toolCall.userResponse.kind === 'questions'
                  ? Object.values(toolCall.userResponse.answers).join(' · ')
                  : toolCall.userResponse.kind === 'raw'
                    ? toolCall.userResponse.text
                    : JSON.stringify(toolCall.userResponse.value)}
              </span>
            </div>
          )}
          {toolCall.error && status === 'error' && detail.type !== 'shell' && (
            <div className="mt-1.5">
              <div className="text-[11px] uppercase tracking-wide text-red-500 mb-0.5">Error</div>
              <pre data-testid="tool-call-error" className="text-[11px] font-mono text-red-500 whitespace-pre-wrap overflow-auto max-h-40 bg-red-500/5 rounded px-2 py-1.5">
                {toolCall.error}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

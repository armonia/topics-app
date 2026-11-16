/**
 * When a Topics agent hands work to a sub-agent, and how.
 *
 * Why it exists (measured on 14/11/2026, one full day of transcripts): the two
 * heaviest orchestration chats ran 413 and 435 Bash calls in their own context
 * and started 4 and 1 `spawn_agent`. Median context 230-270k tokens, three
 * compactions each, and every call re-reads it all: together a third of the
 * weekly quota spent that day. The prompt only said `spawn_agent` exists, not
 * when to use it.
 *
 * The wording follows what was measured elsewhere, not taste:
 *  - an orchestrator that decides, children in parallel with their own context
 *    (Anthropic, "How we built our multi-agent research system", 06/2025);
 *  - a complete mandate: objective, shape of the result, tools, boundaries
 *    (same source: without it children duplicate work or pick the wrong task);
 *  - a clean mandate instead of the chat history (clean-slate dispatch: -99%
 *    inherited context, no collisions with discarded hypotheses);
 *  - the result as evidence that can be reopened, not prose: 41.8% of the
 *    failures of delegated search happen at the hand-off, almost always
 *    silently (arXiv 2608.01507, SWE-QA);
 *  - exploration split from solving: up to -60% of the main agent's tokens
 *    (FastContext, arXiv 2606.14066).
 *
 * Pure: no disk, no environment. Used by the headless session prompt
 * (`topics-agent-prompt.ts`), the native engine and the CLI hook script
 * (`delegationHookScript`), so thresholds and wording live in one place.
 */

/** How many inline work calls in a row, without a delegation, before the nudge; and from what context size. */
export const DELEGATION_NUDGE = { everyInlineCalls: 25, minContextTokens: 120_000 } as const;

export interface DelegationState { inline: number; next: number }

/**
 * Calls that do work in the caller's context: shell, reads, searches, process output.
 * Waiting on CI and driving the browser count too: measured on 16/11/2026, the heaviest
 * chat spent its tool calls on `wait_for_process` and `browser_eval` and the nudge never
 * saw them, so it never came.
 */
export const INLINE_WORK_TOOL = /^(Bash|Read|Grep|Glob|bash|read_file|grep|glob|(mcp__topics__)?(run_command|read_process_output|wait_for_process|browser_eval))$/;

/** Calls that hand work to another session. */
export const DELEGATION_TOOL = /^((mcp__topics__)?spawn_agent|Agent|Task)$/;

/** The system prompt paragraph. */
export function delegationPolicy(): string {
  return [
    'DELEGATE THE WORK, KEEP THE DECISIONS. Your whole context is re-read on every tool call, so a command that prints a lot costs far more here than in a fresh session.',
    'Hand to a sub-agent with `mcp__topics__spawn_agent`: exploring or mapping code (more than ~5 reads or searches), reading logs, CI output or test failures, running and triaging a suite, waiting on and steering CI, driving and checking the browser, trying a route, any research.',
    'Independent pieces go out together, 2-4 at once, with isolation:"worktree" when two could write the same files.',
    'Keep here: the decision, edits that need the whole picture, one-off commands.',
    'Mechanical work (find, list, extract) goes to a cheaper profile when agent_type lists one (scout, delegate).',
    'Each mandate stands alone, not a pointer to this chat: the objective, what to return and in what shape, which tools or sources, where to stop.',
    'Ask for evidence, not prose: file paths with line ranges, commands with their exit code, verbatim excerpts. Before acting on a claim that matters, reopen the span it cites: hand-offs fail silently.',
    'Do not poll a child: its result wakes you.',
  ].join(' ');
}

/** The mid-turn nudge, with this session's numbers. */
export function delegationNudgeText(inlineCalls: number, contextK: number): string {
  return `Topics: ${inlineCalls} tool calls in a row in this context (now ~${contextK}k tokens) without a sub-agent. `
    + 'If what follows is more exploring, reading or running, hand it to `mcp__topics__spawn_agent` with a self-contained mandate and ask for paths, line ranges and exit codes back. '
    + 'Waiting on CI and driving the browser are work too, not a last step: hand them over as well. Carry on here only for the one edit that needs the whole picture.';
}

/**
 * A session's counter: `observe` on every tool round returns the nudge text
 * when it is due, null otherwise. Below the minimum context it does not nudge
 * (it would cost little anyway) and checks again 5 calls later; after a nudge
 * the next one comes `everyInlineCalls` later, so it does not become noise.
 */
export function createDelegationTracker(nudge = DELEGATION_NUDGE, from?: DelegationState) {
  let inline = from?.inline ?? 0;
  let next = from?.next ?? nudge.everyInlineCalls;
  return {
    /** The count, serializable: a detached turn (`turn-host.ts`) carries it across processes. */
    state(): DelegationState {
      return { inline, next };
    },
    observe(toolNames: readonly string[], contextTokens: number): string | null {
      if (toolNames.some((n) => DELEGATION_TOOL.test(n))) {
        inline = 0;
        next = nudge.everyInlineCalls;
        return null;
      }
      inline += toolNames.filter((n) => INLINE_WORK_TOOL.test(n)).length;
      if (inline < next) return null;
      if (contextTokens < nudge.minContextTokens) {
        next = inline + 5;
        return null;
      }
      next = inline + nudge.everyInlineCalls;
      return delegationNudgeText(inline, Math.round(contextTokens / 1000));
    },
  };
}

/** A string inside single shell quotes. */
const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The same counter for the Claude Code CLI, as a synchronous `PostToolUse`
 * hook: the only event that can hand text back to the model
 * (`hookSpecificOutput.additionalContext`). It is `sh` and not `bun` because it
 * runs on every call and must cost milliseconds even on a loaded machine; it
 * reads the context size only when the count reaches the threshold, from the
 * tail of the transcript. State: one file per session under `$TMPDIR`, two numbers.
 */
export function delegationHookScript(nudge = DELEGATION_NUDGE): string {
  const template = JSON.stringify(delegationNudgeText(-1, -2)).replace('-1', '%d').replace('-2', '%d');
  const delegation = DELEGATION_TOOL.source.replace(/^\^|\$$/g, '');
  const inline = INLINE_WORK_TOOL.source.replace(/^\^|\$$/g, '');
  return `#!/bin/sh
# Topics: delegation nudge (generated by server/lib/delegation-policy.ts, do not edit).
# Always exits 0: an error here must never stop a tool.
input=$(cat)
first() { printf '%s' "$input" | grep -o "\\"$1\\":\\"[^\\"]*\\"" | head -1 | sed 's/.*:"\\(.*\\)"/\\1/'; }
sid=$(first session_id); tool=$(first tool_name); tr=$(first transcript_path)
[ -n "$sid" ] && [ -n "$tool" ] || exit 0
dir="\${TMPDIR:-/tmp}/topics-delegation"; mkdir -p "$dir" 2>/dev/null || exit 0
f="$dir/$(printf '%s' "$sid" | tr -cd 'A-Za-z0-9_-')"
if printf '%s' "$tool" | grep -Eq '^(${delegation})$'; then echo "0 ${nudge.everyInlineCalls}" > "$f"; exit 0; fi
printf '%s' "$tool" | grep -Eq '^(${inline})$' || exit 0
set -- $(cat "$f" 2>/dev/null); n=$((\${1:-0} + 1)); next=\${2:-${nudge.everyInlineCalls}}
if [ "$n" -ge "$next" ]; then
  ctx=0
  if [ -f "$tr" ]; then
    u=$(tail -c 400000 "$tr" | grep -o '"usage":{[^}]*}' | tail -1)
    for k in input_tokens cache_read_input_tokens cache_creation_input_tokens; do
      v=$(printf '%s' "$u" | grep -o "\\"$k\\":[0-9]*" | head -1 | sed 's/.*://'); ctx=$((ctx + \${v:-0}))
    done
  fi
  if [ "$ctx" -ge ${nudge.minContextTokens} ]; then
    next=$((n + ${nudge.everyInlineCalls}))
    msg=$(printf ${shQuote(template)} "$n" "$((ctx / 1000))")
    printf '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":%s}}\\n' "$msg"
  else
    next=$((n + 5))
  fi
fi
echo "$n $next" > "$f"
exit 0
`;
}

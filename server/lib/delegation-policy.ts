/**
 * Quando un agente di Topics passa il lavoro a un sotto-agente, e come.
 *
 * Perché esiste (misura del 14/11/2026, transcript di un giorno intero): le due
 * chat di orchestrazione più pesanti hanno fatto 413 e 435 Bash nel proprio
 * contesto e lanciato 4 e 1 `spawn_agent`. Contesto mediano 230-270k token,
 * tre compattazioni a testa, e ogni chiamata rilegge tutto: da sole valevano un
 * terzo della quota settimanale consumata quel giorno. Il prompt diceva solo
 * che `spawn_agent` esiste, non quando usarlo.
 *
 * Il testo segue ciò che è misurato altrove, non un gusto:
 *  - orchestratore che decide, figli in parallelo con contesto proprio
 *    (Anthropic, «How we built our multi-agent research system», 06/2025);
 *  - mandato completo: obiettivo, forma del risultato, strumenti, confini
 *    (stessa fonte: senza, i figli duplicano o sbagliano compito);
 *  - mandato pulito invece della storia della chat (clean-slate: −99% di
 *    contesto ereditato, nessuna collisione con ipotesi scartate);
 *  - il risultato come prova riapribile, non come prosa: il 41,8% dei
 *    fallimenti della ricerca delegata nasce al passaggio di consegne, quasi
 *    sempre in silenzio (arXiv 2608.01507, SWE-QA);
 *  - esplorazione separata dal lavoro: fino a −60% di token del principale
 *    (FastContext, arXiv 2606.14066).
 *
 * Puro: niente disco, niente ambiente. Lo usano il prompt delle sessioni
 * headless (`topics-agent-prompt.ts`), il motore nativo e lo script di hook
 * della CLI (`delegationHookScript`), così soglie e parole stanno in un posto.
 */

/** Ogni quante chiamate di lavoro in fila, senza una delega, arriva il richiamo; e da che contesto. */
export const DELEGATION_NUDGE = { everyInlineCalls: 25, minContextTokens: 120_000 } as const;

export interface DelegationState { inline: number; next: number }

/** Le chiamate che fanno lavoro nel contesto di chi le chiama: shell, letture, ricerche, uscite di processi. */
export const INLINE_WORK_TOOL = /^(Bash|Read|Grep|Glob|bash|read_file|grep|glob|(mcp__topics__)?(run_command|read_process_output))$/;

/** Le chiamate che passano lavoro a un'altra sessione. */
export const DELEGATION_TOOL = /^((mcp__topics__)?spawn_agent|Agent|Task)$/;

/** Il paragrafo del prompt di sistema. */
export function delegationPolicy(): string {
  return [
    'DELEGATE THE WORK, KEEP THE DECISIONS. Your whole context is re-read on every tool call, so a command that prints a lot costs far more here than in a fresh session.',
    'Hand to a sub-agent with `mcp__topics__spawn_agent`: exploring or mapping code (more than ~5 reads or searches), reading logs, CI output or test failures, running and triaging a suite, trying a route, any research.',
    'Independent pieces go out together, 2-4 at once, with isolation:"worktree" when two could write the same files.',
    'Keep here: the decision, edits that need the whole picture, one-off commands.',
    'Mechanical work (find, list, extract) goes to a cheaper profile when agent_type lists one (scout, delegate).',
    'Each mandate stands alone, not a pointer to this chat: the objective, what to return and in what shape, which tools or sources, where to stop.',
    'Ask for evidence, not prose: file paths with line ranges, commands with their exit code, verbatim excerpts. Before acting on a claim that matters, reopen the span it cites: hand-offs fail silently.',
    'Do not poll a child: its result wakes you.',
  ].join(' ');
}

/** Il richiamo a metà turno, con i numeri di questa sessione. */
export function delegationNudgeText(inlineCalls: number, contextK: number): string {
  return `Topics: ${inlineCalls} tool calls in a row in this context (now ~${contextK}k tokens) without a sub-agent. `
    + 'If what follows is more exploring, reading or running, hand it to `mcp__topics__spawn_agent` with a self-contained mandate and ask for paths, line ranges and exit codes back. '
    + 'If it is the last step of an edit, carry on.';
}

/**
 * Il contatore di una sessione: `observe` a ogni giro di tool, torna il testo
 * del richiamo quando tocca, altrimenti null. Sotto il contesto minimo non
 * richiama (costerebbe poco comunque) e riguarda fra 5 chiamate; dopo un
 * richiamo il prossimo arriva fra `everyInlineCalls`, così non diventa rumore.
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

/** Una stringa dentro apici singoli di shell. */
const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Lo stesso contatore per la CLI di Claude Code, come hook `PostToolUse`
 * sincrono: l'unico evento che può restituire testo al modello
 * (`hookSpecificOutput.additionalContext`). È `sh` e non `bun` perché gira a
 * ogni chiamata e deve costare millisecondi anche a Mac carico; il contesto lo
 * legge solo quando il contatore arriva alla soglia, dalla coda del transcript.
 * Stato: un file per sessione sotto `$TMPDIR`, due numeri.
 */
export function delegationHookScript(nudge = DELEGATION_NUDGE): string {
  const template = JSON.stringify(delegationNudgeText(-1, -2)).replace('-1', '%d').replace('-2', '%d');
  const delegation = DELEGATION_TOOL.source.replace(/^\^|\$$/g, '');
  const inline = INLINE_WORK_TOOL.source.replace(/^\^|\$$/g, '');
  return `#!/bin/sh
# Topics: richiamo alla delega (generato da server/lib/delegation-policy.ts, non modificare).
# Esce sempre 0: un errore qui non deve mai fermare un tool.
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

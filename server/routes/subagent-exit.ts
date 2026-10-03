/**
 * Pure helpers for the Path-B sub-agent wake (see terminal.ts exit handler +
 * topics.ts deliverSubAgentExit). Kept side-effect-free so the message-shaping
 * logic can be unit-tested without importing the terminal runtime (bridge,
 * timers, session maps).
 */
import type { SubAgentOutcome, SubAgentReason, SubAgentResult } from '../lib/subagent-result';

/** A sub-agent spawned FROM a topic chat (`parentSessionKey` = `topic:<id>`) has
 *  exited. The topics router turns this into a chat message so the conversation
 *  that delegated the work reaches its end instead of hanging on a promise it
 *  can't keep ("ti aggiorno quando consegna"). */
export interface SubAgentExitInfo {
  parentSessionKey: string;
  childId: string;
  name: string;
  /** How the child ended, read from its own transcript (`classifySubAgentTranscript`). */
  outcome: SubAgentOutcome;
  exitCode: number | null;
  /** The branch of the worktree the child worked in, when it had one of its own
   *  (WORKTREE-14). Absent for a child that inherited the parent's directory,
   *  which is exactly the case where the report must not change by a byte. */
  branch?: string | null;
  /** Which turn of the child this result closes (SUBAGENT-11); 1 when absent. */
  turn?: number;
  /** The model the child actually ran, read from its transcript. */
  model?: string | null;
  agentType?: string | null;
  durationMs?: number | null;
  cwd?: string;
  /** The parent's own `stop_agent` ended the child (`SubAgentResult.stoppedByParent`). */
  stoppedByParent?: true;
  /**
   * Called once the result reached the parent chat, as a wake or as a row: the
   * copy kept on the child's `subagents` row until then can go.
   */
  settle?: () => void;
}

/** The result a report carries, whatever optional fields its caller filled. */
export function subAgentResultOf(info: SubAgentExitInfo): SubAgentResult {
  return {
    ...info.outcome,
    agentId: info.childId,
    name: info.name,
    turn: info.turn ?? 1,
    model: info.model ?? null,
    agentType: info.agentType ?? null,
    durationMs: info.durationMs ?? null,
    cwd: info.cwd ?? '',
    branch: info.branch ?? null,
    ...(info.stoppedByParent ? { stoppedByParent: true as const } : {}),
  };
}

/** The language the report is written in: the chat's output language, Italian unless it is English. */
export type ReportLanguage = 'it' | 'en';

const WORDS = {
  it: {
    head: (name: string) => `**Sotto-agente "${name}", esito:**`,
    silent: '_(terminato senza output)_',
    lastSeen: 'Ultima riga vista, non un esito:',
    branch: (b: string) => `Ramo: \`${b}\`. Per leggerlo: \`git log main..${b}\`.`,
    status: {
      failed: 'non ha finito il compito',
      stopped: 'fermato prima di finire il turno',
      undelivered: 'il compito non gli è mai arrivato',
      lost: 'perso prima di finire il turno',
    },
    reason: (r: SubAgentReason): string => {
      switch (r.code) {
        case 'api-error': return `errore dell'API: ${r.detail || 'senza dettaglio'}`;
        case 'no-prompt': return 'il suo transcript non contiene il prompt';
        case 'no-transcript': return 'nessun transcript trovato';
        case 'exit-code': return `uscito con codice ${r.exitCode}`;
        case 'exited-mid-turn': return 'uscito a metà turno';
        case 'stopped-by-parent': return 'fermato con stop_agent';
        case 'tab-closed': return 'la sua tab è stata chiusa';
        case 'reloaded': return 'la sua tab è stata ricaricata';
        case 'swept': return "ritirato perché chi l'ha lanciato non lavora più";
        case 'terminal-lost': return 'il suo terminale non è sopravvissuto al riavvio';
      }
    },
  },
  en: {
    head: (name: string) => `**Sub-agent "${name}", result:**`,
    silent: '_(finished with no output)_',
    lastSeen: 'Last line seen, not a result:',
    branch: (b: string) => `Branch: \`${b}\`. To read it: \`git log main..${b}\`.`,
    status: {
      failed: 'did not finish its task',
      stopped: 'stopped before its turn ended',
      undelivered: 'its task never reached it',
      lost: 'lost before its turn ended',
    },
    reason: (r: SubAgentReason): string => {
      switch (r.code) {
        case 'api-error': return `API error: ${r.detail || 'no detail'}`;
        case 'no-prompt': return 'its transcript holds no prompt';
        case 'no-transcript': return 'no transcript was found';
        case 'exit-code': return `exited with code ${r.exitCode}`;
        case 'exited-mid-turn': return 'exited mid-turn';
        case 'stopped-by-parent': return 'stopped with stop_agent';
        case 'tab-closed': return 'its tab was closed';
        case 'reloaded': return 'its tab was reloaded';
        case 'swept': return 'retired because its parent is no longer working';
        case 'terminal-lost': return 'its terminal did not survive the restart';
      }
    },
  },
} as const;

/**
 * The body of the chat message that reports a sub-agent's exit.
 *
 * Only a `completed` outcome is the child's own words. Every other status is
 * named with its reason, and a partial text is quoted as the last line seen:
 * the old body was "the last assistant text, else a neutral note", which let a
 * working sentence pass for a result and called a prompt that never arrived a
 * clean finish.
 */
export function formatSubAgentExitBody(info: Pick<SubAgentExitInfo, 'outcome'>, language: ReportLanguage = 'it'): string {
  const w = WORDS[language];
  const { status, text, reason } = info.outcome;
  const trimmed = text.trim();
  if (status === 'completed') return trimmed || w.silent;
  const note = `_(${w.status[status]}${reason ? `: ${w.reason(reason)}` : ''})_`;
  if (!trimmed) return note;
  const quoted = trimmed.split('\n').map((l) => `> ${l}`).join('\n');
  return `${note}\n\n${w.lastSeen}\n\n${quoted}`;
}

/** Full assistant-message content for a sub-agent exit: a bold header naming the
 *  sub-agent, then its result body, and, for a child that worked in a worktree
 *  of its own, the line saying WHERE that work is. The parent no longer has the
 *  files under its hand: the branch is all it has left to read. */
export function formatSubAgentExitMessage(
  info: Pick<SubAgentExitInfo, 'name' | 'outcome' | 'branch'>,
  language: ReportLanguage = 'it',
): string {
  const w = WORDS[language];
  const head = `${w.head(info.name)}\n\n${formatSubAgentExitBody(info, language)}`;
  if (!info.branch) return head;
  return `${head}\n\n${w.branch(info.branch)}`;
}

/**
 * Il piano che aspetta un sì o un no, e da dove si sa che c'è.
 *
 * Un turno in plan mode può proporre in DUE forme, perché la CLI 2.1.223 non
 * espone più `ExitPlanMode` (vedi `server/lib/plan-approval.ts`):
 *   · il piano scritto in `~/.claude/plans/<slug>.md` — una riga di tool che il
 *     server, a fine turno, mette in `waiting_for_input` con lo schema di
 *     approvazione. È il caso normale, ed è il BLOCCO STRUTTURATO;
 *   · il piano scritto e basta, in prosa, nel formato che l'app stessa chiede
 *     (`planModeContent()`: «## Plan» + passi numerati). Lì di tool non ce n'è
 *     nessuno a cui appendere la domanda.
 *
 * Le due forme finiscono nella STESSA decisione: la barra sopra il composer.
 * Chi risponde non deve sapere in quale delle due il modello ha scritto, e
 * approvare deve fare la stessa cosa — alzare l'autonomia, o il turno che
 * esegue ripartirebbe nella plan mode da cui non può uscire.
 */
import type { AutonomyLevel, ChatMessage } from '../../types';
import { findPendingAsk } from '../../state/pendingAsk';
import { isPlanApprovalSchema, planDecisionFrom } from '../../../../shared/plan-decision';

/**
 * Il piano in prosa, riconosciuto a fiuto.
 *
 * L'euristica non è un indovinello: in plan mode il contesto CHIEDE questo
 * formato esatto (`planModeContent()` in `server/context/assemble.ts`), quindi
 * qui si riconosce ciò che si è ordinato. Resta un'euristica, e per questo vale
 * solo come RIPIEGO — quando un blocco strutturato non c'è.
 */
export function isPlanResponse(content: string): boolean {
  if (!content) return false;
  // Check for plan header (multiple variations) + numbered steps
  const hasPlanHeader = /^##?\s+(?:(?:Implementation|Action|Execution|Development|Migration|Refactoring|Deployment)\s+)?Plan\b/mi.test(content);
  const hasNumberedSteps = (content.match(/^\d+\.\s+/gm) || []).length >= 2;
  return hasPlanHeader && hasNumberedSteps;
}

/** Il piano in attesa. `toolCallId` è la riga a cui rispondere, `null` quando
 *  il piano è solo prosa e la scelta non ha nessun tool da chiudere. */
export interface PendingPlan {
  toolCallId: string | null;
}

/**
 * The decision on a plan, plus the plan as the human rewrote it.
 *
 * The correction is optional and stays optional: a plan nobody touched must
 * restart the turn with the message it has always sent.
 */
export type PlanDecisionHandler = (approved: boolean, editedPlan?: string) => void;

/**
 * The message that restarts the work once a plan is approved.
 *
 * With a correction it is NOT enough to attach the new text: the CLI session
 * that resumes still holds the plan it wrote itself (`~/.claude/plans/`), so a
 * text that arrives without saying what it replaces can be read as an addition
 * and leave the old version running. The message says it replaces, then gives
 * the plan.
 *
 * Without a correction it stays the sentence it always was. Attaching a copy
 * identical to what the model already has adds nothing and doubles the turn.
 */
export function planApprovalMessage(editedPlan?: string): string {
  const edited = editedPlan?.trim();
  if (!edited) return 'Piano approvato. Eseguilo.'; // allow-italian: prompt sent to the model, not UI copy
  const head = 'Piano approvato, con correzioni. Questa versione SOSTITUISCE il piano che avevi scritto: ignora la precedente ed esegui questa.'; // allow-italian: prompt sent to the model, not UI copy
  return `${head}\n\n${edited}`;
}

/**
 * C'è un piano che aspetta la tua approvazione su questa chat?
 *
 * L'ordine conta. Il blocco strutturato vince sempre: se il turno ha una
 * domanda aperta, quella è la verità e la prosa non si guarda nemmeno — e se la
 * domanda aperta è un'ALTRA (un `AskUserQuestion` qualunque), qui non c'è
 * nessun piano: due pannelli che aspettano risposte diverse sono il modo di
 * rispondere alla cosa sbagliata.
 */
export function findPendingPlan(opts: {
  messages: readonly ChatMessage[] | undefined;
  autonomy: AutonomyLevel | null | undefined;
  /** Turno ancora in volo: finché scrive, non ha proposto niente. */
  busy?: boolean;
}): PendingPlan | null {
  const ask = findPendingAsk(opts.messages);
  if (ask) return isPlanApprovalSchema(ask.schema) ? { toolCallId: ask.toolCallId } : null;

  if (opts.busy) return null;
  // Il ripiego vale SOLO in plan mode: altrove un piano scritto è una nota di
  // lavoro, e chiedere di approvarlo sarebbe una domanda inventata.
  if (opts.autonomy !== 'ask') return null;
  const msgs = opts.messages;
  if (!msgs?.length) return null;
  const last = msgs[msgs.length - 1];
  if (last.role !== 'assistant') return null;
  // Su questo turno una decisione è già stata presa: riproporla sarebbe
  // chiedere due volte la stessa cosa.
  const tools = last.blocks?.length
    ? last.blocks.flatMap((b) => (b.kind === 'tool' ? [b.toolCall] : []))
    : (last.toolCalls ?? []);
  if (tools.some((tc) => tc.userResponse && planDecisionFrom(tc.userResponse) !== null)) return null;
  if (!isPlanResponse(last.content ?? '')) return null;
  return { toolCallId: null };
}

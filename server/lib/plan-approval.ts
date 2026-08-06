/**
 * Il turno che propone un piano e non può consegnarlo.
 *
 * ── Il fatto, misurato sul wire ─────────────────────────────────────────────
 * Un topic con autonomia `ask` gira in `--permission-mode plan`. Sulla CLI
 * 2.1.223 quella modalità espone 29 tool e **`ExitPlanMode` non è tra questi**:
 * il modello non può agire («Cannot write while in plan mode») e non può uscire
 * («ExitPlanMode is not enabled in this context»). Ripiega quindi sull'unica
 * cosa che gli resta — scrivere il piano in `~/.claude/plans/<slug>.md` — e il
 * turno si chiude a mani vuote. A schermo restava il cartello «si è chiuso
 * senza produrre niente» sopra una colonna di dodici azioni riuscite.
 *
 * La mappatura `ask → plan` era stata PROVATA sulla 2.1.221 il 4 agosto, e
 * allora funzionava (usciva un piano e la domanda «approvi?»). Fra le due
 * versioni la CLI ha tolto l'uscita: non è una svista di chi l'ha scritta, è
 * un contratto cambiato sotto.
 *
 * ── La via d'uscita la mette Topics ─────────────────────────────────────────
 * Se la CLI non ha più un tool per chiedere l'approvazione, la chiede
 * l'applicazione: a fine turno il piano diventa una domanda a schermo, con lo
 * STESSO pannello di `AskUserQuestion` — che è già il modo in cui questa chat
 * dice «tocca a te».
 */

import type { ContentBlock, UserInputSchema } from "../types";
import { PLAN_APPROVE_LABEL, PLAN_REJECT_LABEL, PLAN_APPROVAL_QUESTION } from "../../shared/plan-decision";

// Etichette e testo della domanda sono un CONTRATTO col client, che li legge
// per capire se far ripartire il lavoro: stanno in `shared/` e si importano,
// perché scritti due volte divergerebbero in silenzio — il pannello
// continuerebbe a comparire e il bottone smetterebbe di fare qualcosa.
export { PLAN_APPROVE_LABEL, PLAN_REJECT_LABEL, PLAN_APPROVAL_QUESTION } from "../../shared/plan-decision";

/**
 * La domanda di approvazione, nella forma che il pannello esistente sa già
 * rendere. Volutamente `kind: "questions"` e non un tipo nuovo: così il form
 * inline, il colore ambra della tab e l'instradamento del composer valgono
 * senza toccarli. È il senso di «standard».
 */
export function planApprovalSchema(): UserInputSchema {
  return {
    kind: "questions",
    questions: [
      {
        question: PLAN_APPROVAL_QUESTION,
        header: "Piano",
        options: [
          {
            label: PLAN_APPROVE_LABEL,
            description:
              "La chat passa ad auto-apply e il piano viene eseguito. L'autonomia resta su auto-apply: la vedi nel selettore e la rimetti su «ask» quando vuoi.",
            recommended: true,
          },
          {
            label: PLAN_REJECT_LABEL,
            description: "Il piano viene scartato e il modello ne propone un altro, sempre senza toccare niente.",
          },
        ],
      },
    ],
  };
}

/**
 * Il piano di questo turno che aspetta una risposta, se c'è.
 *
 * Si guarda la timeline del messaggio e si prende l'ULTIMO blocco di tipo
 * `plan`: se il modello ne ha scritti due (succede — riscrive il file dopo
 * aver letto altro), quello buono è l'ultimo. Torna `null` quando di piani non
 * ce n'è, che è il caso normale di ogni altro turno.
 */
export function findPlanAwaitingApproval(
  blocks: ContentBlock[],
): { toolCallId: string; text: string } | null {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b.kind !== "tool") continue;
    const d = b.toolCall.detail;
    if (d?.type !== "plan") continue;
    // Un piano vuoto non è una domanda: non si chiede di approvare il nulla.
    if (!d.text?.trim()) return null;
    return { toolCallId: b.toolCall.id, text: d.text };
  }
  return null;
}

/**
 * Va chiesta l'approvazione per questo turno?
 *
 * Solo quando il turno è finito NORMALMENTE (un turno interrotto o in errore
 * non ha proposto niente: ha smesso) e solo in plan mode — cioè esattamente
 * dove la CLI non lascia altra strada. In `acceptEdits` o `bypassPermissions`
 * un piano scritto è una nota di lavoro, non una richiesta.
 */
export function shouldAskPlanApproval(opts: {
  reason: string;
  permissionMode: string;
  plan: { toolCallId: string; text: string } | null;
}): boolean {
  return opts.reason === "done" && opts.permissionMode === "plan" && opts.plan !== null;
}

/**
 * Questa risposta è la decisione su un piano?
 *
 * Si riconosce dal TESTO della domanda, che è una costante di questo modulo e
 * viaggia nel `userResponse`. Riconoscerla dal tool sarebbe più elegante ma
 * meno solido: la riga può essere già stata riscritta da un reload, mentre la
 * risposta che arriva porta con sé la domanda a cui risponde.
 */
export function isPlanApprovalAnswer(response: { kind: string; answers?: Record<string, string> }): boolean {
  if (response.kind !== "questions") return false;
  return Object.keys(response.answers ?? {}).some((q) => q.trim() === PLAN_APPROVAL_QUESTION);
}

export { planDecisionFrom } from "../../shared/plan-decision";

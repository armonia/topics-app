/**
 * Il TENTATIVO: una delle N corse parallele dello stesso task (fan-out).
 *
 * Sta in `shared/` perché lo leggono i due lati del filo — il server lo scrive,
 * il drawer della board lo disegna — e la lezione di `shared/board.ts` è già
 * stata pagata una volta: due copie dello stesso tipo divergono, e quella del
 * client resta indietro in silenzio.
 *
 * Un tentativo NON è un sottotask. Un sottotask è un passo della checklist di un
 * task e va completato; i tentativi sono alternative di cui una sola sopravvive.
 */

export const ATTEMPT_STATES = ['running', 'delivered', 'failed', 'selected', 'discarded'] as const;
export type AttemptState = (typeof ATTEMPT_STATES)[number];

export interface TaskAttempt {
  id: string;
  taskId: string;
  /** 1..N — l'ordine di lancio, quello che l'umano legge come "tentativo 2". */
  idx: number;
  /** La chat dell'agente di questo tentativo (deep-link "apri la sessione"). */
  topicId: string | null;
  worktreeId: string | null;
  branch: string | null;
  model: string | null;
  state: AttemptState;
  commit: string | null;
  filesChanged: number | null;
  insertions: number | null;
  deletions: number | null;
  /** L'ultima prosa dell'agente: il "cosa ho fatto" di questo tentativo. */
  summary: string | null;
  error: string | null;
  agentMs: number;
  agentTokens: number;
  createdAt: string;
  endedAt: string | null;
  selectedAt: string | null;
}

/** Ha prodotto qualcosa di guardabile? (un commit con almeno un file toccato) */
export function attemptHasWork(a: TaskAttempt): boolean {
  return !!a.commit && (a.filesChanged ?? 0) > 0;
}

/** `3 file · +120 −8`, oppure il perché non c'è niente da contare. */
export function formatAttemptStat(a: TaskAttempt): string {
  if (a.state === 'running') return 'in corso…';
  if (!attemptHasWork(a)) return a.error ? `nessuna modifica (${a.error})` : 'nessuna modifica';
  // "file" è invariante in italiano: 1 file, 3 file.
  return `${a.filesChanged ?? 0} file · +${a.insertions ?? 0} −${a.deletions ?? 0}`;
}

/**
 * Il confronto che finisce nel thread quando il fan-out chiude.
 *
 * Deliberatamente SENZA punteggio: ordinare per "diff più piccolo" o "più
 * veloce" darebbe a un numero l'autorità di una scelta che è di merito, e la
 * userebbe come se fosse una misura di qualità. Quello che il confronto può
 * dire onestamente è: chi ha prodotto qualcosa, quanto, su che branch e cosa
 * dice di aver fatto. La scelta resta un click umano.
 */
export function formatFanoutComment(attempts: TaskAttempt[]): string {
  const ordered = [...attempts].sort((a, b) => a.idx - b.idx);
  const withWork = ordered.filter(attemptHasWork);
  const lines: string[] = [];

  lines.push(
    withWork.length === 0
      ? `Fan-out chiuso: ${ordered.length} tentativi, **nessuno ha prodotto modifiche**.`
      : `Fan-out chiuso: ${ordered.length} tentativi, ${withWork.length} con modifiche. Scegli quale tenere. Gli altri (worktree e branch) vengono ripuliti.`,
  );

  for (const a of ordered) {
    lines.push('');
    const head = `**Tentativo ${a.idx}** · ${formatAttemptStat(a)}`;
    lines.push(a.branch ? `${head} · \`${a.branch}\`` : head);
    if (a.summary) lines.push(`> ${a.summary.split('\n').join('\n> ')}`);
    else if (a.state === 'failed' && a.error) lines.push(`> _fallito: ${a.error}_`);
  }

  return lines.join('\n');
}

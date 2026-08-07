/**
 * Il permesso su un singolo strumento: le etichette e la forma della domanda.
 *
 * È un CONTRATTO fra tre parti che non si vedono fra loro:
 *   - chi pone la domanda — il server, quando la CLI chiede il permesso
 *     (`server/routes/topics.ts`, rotta `…/permission`);
 *   - chi la mostra — la riga del tool in chat, che la rende con lo STESSO
 *     pannello di `ask_user_question` (`client/…/ToolInputForm.tsx`);
 *   - chi la interpreta — di nuovo il server, che dalla risposta ricava
 *     `allow` / `allow_always` / `deny` e la manda alla CLI.
 *
 * Vive qui, e non tre volte, per lo stesso motivo di `shared/plan-decision.ts`:
 * scritte due volte queste stringhe divergono in silenzio — il pannello
 * continuerebbe a comparire e il bottone smetterebbe di fare qualcosa, senza un
 * solo errore di compilazione.
 *
 * PERCHÉ riusa il pannello delle domande invece di inventarne uno: il pannello
 * inline, l'ambra della tab, la risposta dal composer e la sopravvivenza al
 * reload esistono già e sono collaudati. Una superficie nuova avrebbe dovuto
 * riconquistarli uno per uno.
 */

import type { AskUserQuestionItem, UserInputSchema } from './types';

/** La decisione che la CLI si aspetta indietro dal canale di permesso. */
export type PermissionDecision = 'allow' | 'allow_always' | 'deny';

export const PERMISSION_ALLOW_ONCE_LABEL = 'Consenti';
export const PERMISSION_ALLOW_ALWAYS_LABEL = 'Consenti sempre';
export const PERMISSION_DENY_LABEL = 'Nega';

/**
 * Il prefisso che identifica una domanda di permesso. Il nome dello strumento
 * (e un riassunto degli argomenti) seguono, quindi il riconoscimento è per
 * prefisso — non per uguaglianza come sul piano, dove la domanda è una sola.
 */
export const PERMISSION_QUESTION_PREFIX = 'Permesso richiesto — ';

/** L'intestazione corta del pannello (≤12 caratteri per convenzione SDK). */
export const PERMISSION_HEADER = 'Permesso';

/**
 * Un riassunto di UNA RIGA degli argomenti, perché un permesso concesso senza
 * vedere cosa farà non è un permesso: è un pulsante.
 *
 * Volutamente breve e senza valori lunghi — il pannello sta in una riga di
 * chat, e il dettaglio completo resta negli argomenti del tool, che la riga sa
 * già mostrare quando la apri.
 */
export function summarizeToolInput(input: unknown, maxLen = 160): string {
  if (input === null || input === undefined) return '';
  if (typeof input !== 'object') return clamp(String(input), maxLen);
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length === 0) return '';
  // `file_path`/`command`/`url` per primi: sono quelli che dicono davvero cosa
  // sta per succedere. Il resto segue nell'ordine in cui è arrivato.
  const priority = ['file_path', 'path', 'command', 'url', 'query'];
  entries.sort((a, b) => {
    const ia = priority.indexOf(a[0]);
    const ib = priority.indexOf(b[0]);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
  const parts: string[] = [];
  for (const [k, v] of entries) {
    const rendered = typeof v === 'string' ? v : JSON.stringify(v);
    if (rendered === undefined) continue;
    parts.push(`${k}: ${clamp(rendered, 60)}`);
    if (parts.join(' · ').length >= maxLen) break;
  }
  return clamp(parts.join(' · '), maxLen);
}

function clamp(s: string, n: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length <= n ? flat : `${flat.slice(0, n - 1)}…`;
}

/** Il testo della domanda per uno strumento — la CHIAVE della mappa risposte. */
export function permissionQuestion(toolName: string, input?: unknown): string {
  const summary = summarizeToolInput(input);
  return summary
    ? `${PERMISSION_QUESTION_PREFIX}${toolName}\n${summary}`
    : `${PERMISSION_QUESTION_PREFIX}${toolName}`;
}

/**
 * Il pannello da mostrare. Tre opzioni e NESSUNA consigliata: su tutto il resto
 * un consiglio fa risparmiare tempo, qui deciderebbe al posto di chi deve
 * decidere — ed è l'unica domanda della app in cui la risposta sbagliata la
 * paga chi l'ha premuta.
 */
export function permissionSchemaFor(opts: { toolName: string; input?: unknown }): UserInputSchema {
  const question: AskUserQuestionItem = {
    question: permissionQuestion(opts.toolName, opts.input),
    header: PERMISSION_HEADER,
    options: [
      { label: PERMISSION_ALLOW_ONCE_LABEL, description: 'Solo per questa volta.' },
      {
        label: PERMISSION_ALLOW_ALWAYS_LABEL,
        description: `Non chiedere più per ${opts.toolName}. Si revoca dalle impostazioni.`,
      },
      { label: PERMISSION_DENY_LABEL, description: "L'agente riceve un no e prosegue senza." },
    ],
  };
  return { kind: 'questions', questions: [question] };
}

type AnswerLike = { kind?: string; answers?: Record<string, string> };

/**
 * La decisione contenuta in una risposta, o `null` se non è una risposta a un
 * permesso. Un'etichetta che non riconosciamo vale `deny`: davanti a un
 * permesso, «non ho capito» non può voler dire «sì».
 */
export function permissionDecisionFrom(response: AnswerLike): PermissionDecision | null {
  if (response?.kind !== 'questions') return null;
  const entry = Object.entries(response.answers ?? {}).find(([q]) =>
    q.startsWith(PERMISSION_QUESTION_PREFIX),
  );
  if (!entry) return null;
  const answer = (entry[1] ?? '').trim();
  if (answer === PERMISSION_ALLOW_ONCE_LABEL) return 'allow';
  if (answer === PERMISSION_ALLOW_ALWAYS_LABEL) return 'allow_always';
  return 'deny';
}

/**
 * Questa domanda è un permesso?
 *
 * Serve a `answerFromText` per NON promettere che una riga di prosa possa
 * rispondere: su un ask normale il testo libero passa verbatim al modello, che
 * lo legge per mestiere; qui dall'altra parte non c'è nessun modello, la scelta
 * la interpretiamo noi, e fra tre opzioni esatte «ok», «vai» o «no direi» sono
 * un indovinello — che si risolve concedendo un permesso che volevi negare.
 */
export function isPermissionSchema(schema: unknown): boolean {
  const s = schema as { kind?: string; questions?: { question?: string }[] } | null;
  if (!s || s.kind !== 'questions') return false;
  return (s.questions ?? []).some((q) => q?.question?.startsWith(PERMISSION_QUESTION_PREFIX));
}

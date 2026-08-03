/**
 * La domanda a schermo, vista dal lato di CHI DEVE RISPONDERE.
 *
 * Il guasto che questo modulo chiude. Quando un tool sospende il turno per
 * chiedere qualcosa, il turno resta "in volo": `/api/chat` risponde 409
 * (`server/routes/chat.ts`, un-turno-per-sessione) e il client mette il
 * messaggio IN CODA, dove aspetta la fine del turno. Ma il turno finisce solo
 * quando la domanda riceve risposta — e la risposta, fino a ieri, si poteva
 * dare SOLO dal pannello. Quindi chi rispondeva scrivendo in chat — la cosa
 * più naturale del mondo, tanto che l'agente stesso la suggerisce («rispondi
 * qui in chiaro con il numero») — vedeva il messaggio sparire in una coda che
 * si sarebbe svuotata solo dopo aver fatto la cosa che non stava facendo.
 * Stallo, fino allo scadere dell'ask (90 minuti) o a uno «ferma».
 *
 * Qui si decide, in codice puro e testabile, DUE cose:
 *   - se c'è una domanda aperta su questa sessione (`findPendingAsk`);
 *   - se un testo libero può valere come risposta (`answerFromText`), o se il
 *     pannello resta l'unica strada.
 *
 * Il testo libero NON copre tutto, di proposito: una domanda multipla o una
 * elicitation con schema JSON hanno una forma che una riga di prosa non può
 * riempire senza indovinare. Lì il messaggio torna a comportarsi come sempre.
 */
import type { ChatMessage, ToolCall, ToolUserResponse, UserInputSchema } from '../types';

export interface PendingAsk {
  toolCallId: string;
  schema: UserInputSchema;
  /** Il tool che sta aspettando — utile a chi vuole mostrarne il nome. */
  toolName: string;
}

/**
 * La domanda aperta sull'ULTIMO messaggio assistant, o null.
 *
 * Solo l'ultimo: un `waiting_for_input` rimasto appeso più su nella
 * trascrizione è il fantasma di un turno morto (stream perso, sweeper), e
 * instradarci una risposta significherebbe parlare a un processo che non c'è
 * più. È lo stesso confine che usa la striscia di attività con `isLast`.
 */
export function findPendingAsk(messages: readonly ChatMessage[] | undefined): PendingAsk | null {
  if (!messages?.length) return null;
  const last = messages[messages.length - 1];
  if (last.role !== 'assistant') return null;
  const tools: ToolCall[] = last.blocks?.length
    ? last.blocks.flatMap((b) => (b.kind === 'tool' ? [b.toolCall] : []))
    : (last.toolCalls ?? []);
  // Dal fondo: se per assurdo ce ne fossero due aperte, quella viva è l'ultima.
  for (let i = tools.length - 1; i >= 0; i--) {
    const tc = tools[i];
    if (tc.status === 'waiting_for_input' && tc.userInputSchema) {
      return { toolCallId: tc.id, schema: tc.userInputSchema, toolName: tc.name };
    }
  }
  return null;
}

/**
 * Il testo scritto in chat, tradotto nella risposta che il tool si aspetta —
 * o null se questa domanda non si può rispondere a parole.
 *
 * `questions` con UNA domanda: il testo è la risposta, verbatim. Non si prova
 * ad agganciarlo a un'opzione per somiglianza: «il secondo» o «bug fix» sono
 * entrambi legittimi, e indovinare quale opzione intendesse è esattamente il
 * modo di rispondere una cosa per un'altra. Il modello dall'altra parte legge
 * prosa per mestiere; è lui il posto giusto dove interpretarla.
 */
export function answerFromText(ask: PendingAsk, text: string): ToolUserResponse | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const submittedAt = new Date().toISOString();
  if (ask.schema.kind === 'raw') return { kind: 'raw', text: trimmed, submittedAt };
  if (ask.schema.kind === 'questions') {
    const questions = ask.schema.questions ?? [];
    // Più di una domanda ⇒ il pannello. Mettere lo stesso testo su tutte
    // risponderebbe a caso a quelle che non hai nemmeno letto.
    if (questions.length !== 1) return null;
    return { kind: 'questions', answers: { [questions[0].question]: trimmed }, submittedAt };
  }
  // elicitation: la forma è uno schema JSON, la prosa non la riempie.
  return null;
}

/**
 * Questa domanda si può rispondere scrivendo? Serve alla UI (il bottone del
 * composer, il segnaposto del campo) per promettere solo ciò che l'invio farà
 * davvero — la regola sta in `answerFromText` e resta una sola.
 */
export function canAnswerWithText(ask: PendingAsk | null | undefined): boolean {
  return !!ask && answerFromText(ask, 'x') !== null;
}

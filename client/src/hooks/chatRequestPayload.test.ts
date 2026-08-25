/**
 * QUANTO PESA UN INVIO — il gemello, sul lato RICHIESTA, di
 * `tests/integration/history-payload-weight.test.ts`.
 *
 * Quel gate misura i byte che `/api/history` mette sul filo quando si APRE una
 * chat. Nessuno misurava quelli che il client mette sul filo quando ne MANDA
 * una: l'intero trascritto, a ogni turno, più una copia in coda dell'ultimo
 * messaggio dell'utente. E il server, sul ramo legato a una topic — cioè ogni
 * chat vera — di quell'array legge `messages[messages.length - 1]` e butta il
 * resto (`server/routes/chat.ts`; la storia se la ricostruisce dal DB con
 * `assembleTopicContext`).
 *
 * Due misure, e la prima è quella che conta:
 *
 *  1. INVARIANTE: l'ultimo elemento è il messaggio che si sta inviando, e c'è
 *     UNA volta sola. È strutturale — il ramo senza topic usa
 *     `filter(user|assistant).slice(0, -1)` come storia, quindi il doppione
 *     faceva rientrare lo stesso turno anche lì dentro.
 *  2. BUDGET: il carico non cresce con la conversazione. Su un trascritto
 *     realistico (100 turni, 4 KB per risposta) il corpo passava da centinaia di
 *     KB a una coda limitata.
 *
 * @covers CHAT-QUEUE-02
 */
import { describe, expect, test } from 'bun:test';
import { buildRequestMessages, REQUEST_TAIL_BUDGET_CHARS } from './chatRequestPayload';
import type { ChatMessage } from '../types';

const NOW = '2026-08-15T10:00:00.000Z';

const bolla = (role: ChatMessage['role'], content: string, over: Partial<ChatMessage> = {}): ChatMessage =>
  ({ id: `m_${role}_${content.slice(0, 8)}_${Math.random()}`, role, content, timestamp: NOW, ...over } as ChatMessage);

/** Un trascritto come quelli veri: n turni, risposte da `kb` kilobyte. */
function trascritto(turni: number, kb: number): ChatMessage[] {
  const riga = 'la riga di una risposta lunga come quelle vere\n';
  const risposta = riga.repeat(Math.ceil((kb * 1024) / riga.length));
  const out: ChatMessage[] = [];
  for (let i = 0; i < turni; i++) {
    out.push(bolla('user', `domanda ${i}`));
    out.push(bolla('assistant', `${i} ${risposta}`));
  }
  return out;
}

const pesa = (msgs: Array<{ content: string }>): number =>
  msgs.reduce((n, m) => n + m.content.length, 0);

describe('buildRequestMessages — invariante: il messaggio inviato viaggia UNA volta', () => {
  test('la coda è il messaggio che si sta inviando', () => {
    const stato = [bolla('user', 'ciao'), bolla('assistant', 'ehilà'), bolla('user', 'e adesso?')];
    const out = buildRequestMessages(stato, 'e adesso?');
    expect(out[out.length - 1]).toEqual({ role: 'user', content: 'e adesso?' });
  });

  test('non lo manda due volte, anche se lo stato locale lo contiene già', () => {
    // `performSend` chiama `addMessage` PRIMA di costruire il corpo, quindi lo
    // stato finisce già con questo stesso messaggio. Prima quella copia veniva
    // riappesa in fondo: due righe identiche, e sul ramo senza topic il turno
    // rientrava anche nella storia.
    const stato = [bolla('user', 'ciao'), bolla('assistant', 'ehilà'), bolla('user', 'e adesso?')];
    const out = buildRequestMessages(stato, 'e adesso?');
    expect(out.filter((m) => m.content === 'e adesso?')).toHaveLength(1);
    // Ed è esattamente ciò che il ramo senza topic userebbe come storia.
    expect(out.slice(0, -1).map((m) => m.content)).toEqual(['ciao', 'ehilà']);
  });

  test('se lo stato NON lo contiene (corsa fra due invii) lo aggiunge lo stesso', () => {
    const stato = [bolla('user', 'ciao'), bolla('assistant', 'ehilà')];
    const out = buildRequestMessages(stato, 'e adesso?');
    expect(out[out.length - 1].content).toBe('e adesso?');
    expect(out).toHaveLength(3);
  });

  test('stato vuoto: parte solo il messaggio', () => {
    expect(buildRequestMessages([], 'primo')).toEqual([{ role: 'user', content: 'primo' }]);
  });
});

describe('buildRequestMessages — il carico non cresce con la conversazione', () => {
  test('cento turni da 4 KB stanno dentro il tetto', () => {
    const stato = trascritto(100, 4);
    const contenuto = 'e adesso?';
    stato.push(bolla('user', contenuto));

    const prima = pesa([
      ...stato.map((m) => ({ content: m.content })),
      { content: contenuto },
    ]);
    const dopo = pesa(buildRequestMessages(stato, contenuto));

    expect(prima).toBeGreaterThan(400 * 1024);
    expect(dopo).toBeLessThanOrEqual(REQUEST_TAIL_BUDGET_CHARS + contenuto.length);
    expect(dopo).toBeLessThan(prima / 4);
  });

  test('la coda tenuta è la PIÙ RECENTE, in ordine', () => {
    const stato = trascritto(100, 4);
    const out = buildRequestMessages(stato, 'ultima');
    const ultimaTenuta = out[out.length - 2].content;
    expect(ultimaTenuta.startsWith('99 ')).toBe(true);
    // Ordine cronologico: chi arriva prima sta prima.
    const indici = out.slice(0, -1)
      .filter((m) => m.role === 'assistant')
      .map((m) => Number(m.content.split(' ')[0]));
    expect(indici).toEqual([...indici].sort((a, b) => a - b));
  });

  test('un messaggio più grande del tetto passa comunque: meglio uno che zero', () => {
    const enorme = 'x'.repeat(REQUEST_TAIL_BUDGET_CHARS * 2);
    const stato = [bolla('assistant', enorme), bolla('user', 'e allora?')];
    const out = buildRequestMessages(stato, 'e allora?');
    expect(out).toHaveLength(2);
    expect(out[0].content).toBe(enorme);
  });

  test('le bolle senza testo non occupano una riga: non portano contesto', () => {
    const stato = [
      bolla('assistant', '', { toolCalls: [{ id: 't1', name: 'Read', args: {}, status: 'success' }] }),
      bolla('assistant', '   '),
      bolla('assistant', 'la risposta'),
      bolla('user', 'ok'),
    ];
    const out = buildRequestMessages(stato, 'ok');
    expect(out.map((m) => m.content)).toEqual(['la risposta', 'ok']);
  });
});

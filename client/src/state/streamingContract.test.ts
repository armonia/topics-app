/**
 * IL CONTRATTO DELLA ROTTA CHE TIENE IN PIEDI IL BANNER, legato alle due parti
 * che lo usano.
 *
 * PERCHÉ ESISTE. La correzione del banner «Nessuna risposta» (vedi
 * `Chat/turnError.ts` → `turnLooksUnanswered`) si regge su un fatto che nessun
 * test copriva: `GET /api/topics/streaming` risponde
 * `{ sessions: [{ topicId, sessionKey, state }] }` con `state` che vale
 * `"streaming"` oppure `"waiting"`. Se quella forma cambia, il client smette in
 * silenzio di riconoscere i turni vivi — e il difetto torna esattamente com'era:
 * scatola ambra «la connessione può essersi interrotta» su un agente al lavoro,
 * col bottone che invita a rimandare il messaggio.
 *
 * Il silenzio è il punto. Il parser (`useSignalsSync`) scarta gli stati che non
 * riconosce con un `continue`, quindi un rinomino di `state` non rompe niente:
 * fa solo sparire tutte le sessioni dal set, e il banner ricomincia ad accusare
 * la rete. Un difetto che non fa rumore da nessuna parte.
 *
 * E c'è una seconda ragione, più scomoda: l'E2E che difende la correzione
 * (`tests/e2e/no-reply-live-turn.spec.ts`) INTERCETTA quella rotta e ne finge la
 * risposta — l'unico modo di mettere la pagina nello stato «server dice aperto,
 * sessione locale non lo sa» senza gareggiare col tempo. Una finzione che nessuno
 * confronta con l'originale è una finzione che invecchia: passerebbe verde su un
 * contratto che il server non serve più. Questo file è quel confronto.
 *
 * COSA COPRE E COSA NO. Qui vive la regola di lettura — quali stati contano come
 * «turno aperto» — nella stessa forma in cui `useSignalsSync` la applica. Che il
 * SERVER emetta davvero questi valori sta scritto in `server/routes/topics.ts`
 * (il tipo dichiarato di `sessions`), ed è verificato dal typecheck del server,
 * non da qui.
 */
import { describe, expect, test } from 'bun:test';

/** La forma di una riga, copiata dal tipo dichiarato in `server/routes/topics.ts`. */
interface RigaStreaming {
  topicId: string;
  sessionKey: string;
  state: 'streaming' | 'waiting';
}

/**
 * La regola di lettura di `useSignalsSync`: quali stati tengono un topic nel
 * set dei «vivi». Riprodotta qui perché è la decisione che il banner eredita.
 *
 * `waiting` conta come APERTO ed è la parte controintuitiva: un turno fermo su
 * una domanda non ha finito, aspetta te. Escluderlo farebbe ricomparire il
 * banner proprio sulla chat che ti sta chiedendo qualcosa — il caso in cui
 * accusare la rete è più fuorviante che mai.
 */
function topicVivi(sessions: RigaStreaming[]): Set<string> {
  const vivi = new Set<string>();
  for (const s of sessions) {
    if (s.state !== 'streaming' && s.state !== 'waiting') continue;
    if (s.topicId) vivi.add(s.topicId);
  }
  return vivi;
}

describe('contratto di GET /api/topics/streaming — il testimone del banner', () => {
  test('uno stato `streaming` tiene il topic fra i vivi', () => {
    expect(topicVivi([{ topicId: 't1', sessionKey: 'topic:t1', state: 'streaming' }])).toEqual(new Set(['t1']));
  });

  test('anche `waiting` è un turno APERTO: fermo su una domanda, non finito', () => {
    expect(topicVivi([{ topicId: 't2', sessionKey: 'topic:t2', state: 'waiting' }])).toEqual(new Set(['t2']));
  });

  test('una lista vuota non tiene nessuno: è il caso in cui il banner deve parlare', () => {
    expect(topicVivi([]).size).toBe(0);
  });

  test('uno stato SCONOSCIUTO viene scartato — ed è il modo silenzioso in cui il difetto tornerebbe', () => {
    // Se un giorno il server rinominasse `streaming` in, poniamo, `running`,
    // questo `continue` non farebbe rumore: il set resterebbe vuoto e il banner
    // ricomincerebbe ad accusare la connessione su ogni turno vivo. Il test non
    // può impedirlo, ma tiene scritto DOVE guardare quando succede.
    expect(topicVivi([{ topicId: 't3', sessionKey: 'topic:t3', state: 'running' as unknown as 'streaming' }]).size).toBe(0);
  });

  test("la forma finta dall'E2E è la stessa che il server dichiara", () => {
    // `tests/e2e/no-reply-live-turn.spec.ts` intercetta la rotta e risponde con
    // questo oggetto. Se il contratto cambia, questa riga smette di compilare
    // (typecheck) o questo test smette di passare — invece di lasciare l'E2E
    // verde su una finzione che il server non serve più.
    const comeNellE2E: RigaStreaming = { topicId: 't4', sessionKey: 'topic:t4', state: 'streaming' };
    expect(topicVivi([comeNellE2E])).toEqual(new Set(['t4']));
  });
});

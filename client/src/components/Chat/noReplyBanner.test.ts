/**
 * IL CANCELLO DEL BANNER «NESSUNA RISPOSTA», sul caso che l'ha motivato.
 *
 * Il referto del 19/08: messaggio inviato, finestra ricaricata, e la scatola
 * ambra «La connessione può essersi interrotta» compariva su un turno che
 * l'agente stava servendo. Due bugie in fila — la prima è che il messaggio
 * sembra sparito, la seconda che il turno sembra morto — e la seconda invita a
 * premere «Riprova», cioè a far partire un SECONDO turno a pagamento mentre il
 * primo è ancora in corso.
 *
 * PERCHÉ QUI E NON IN UN E2E. La condizione da riprodurre è «il server dichiara
 * il turno aperto MENTRE la sessione locale non lo sa», che in un browser vero
 * si ottiene solo cronometrando un reload dentro la finestra di un turno vivo:
 * un test che ci prova diventa un test sul tempismo, cioè rosso a caso il
 * giorno che la macchina è carica (già visto oggi con i frame e con la prima
 * card). Qui la condizione si dichiara, e ciò che si verifica è la DECISIONE,
 * che è la parte che era sbagliata.
 *
 * La copertura end-to-end esiste già ed è quella giusta per l'altro caso:
 * `empty-turn-on-stop.spec.ts` prova che dopo uno STOP il banner compare e dice
 * la cosa giusta.
 */
import { describe, expect, test } from 'bun:test';
import { turnLooksUnanswered } from './turnError';

/** Le quattro combinazioni dei due testimoni, con l'ultimo messaggio utente. */
const casi: Array<{ nome: string; local: boolean; server: boolean; atteso: boolean }> = [
  { nome: 'nessuno dei due lo dice vivo → il banner PARLA', local: false, server: false, atteso: true },
  { nome: 'lo dice il server (il caso del reload) → il banner TACE', local: false, server: true, atteso: false },
  { nome: 'lo dice la sessione locale (turno appena inviato) → TACE', local: true, server: false, atteso: false },
  { nome: 'lo dicono entrambi → TACE', local: true, server: true, atteso: false },
];

describe('banner «Nessuna risposta» — la tabella di verità completa', () => {
  for (const c of casi) {
    test(c.nome, () => {
      expect(turnLooksUnanswered({
        lastMessageIsUser: true,
        locallyStreaming: c.local,
        serverSaysOpen: c.server,
      })).toBe(c.atteso);
    });
  }

  test('con l\'ultimo messaggio NON dell\'utente il banner tace sempre', () => {
    // Nessuna attesa da dichiarare: è già arrivata una risposta, qualunque cosa
    // dicano i due testimoni.
    for (const c of casi) {
      expect(turnLooksUnanswered({
        lastMessageIsUser: false,
        locallyStreaming: c.local,
        serverSaysOpen: c.server,
      })).toBe(false);
    }
  });
});

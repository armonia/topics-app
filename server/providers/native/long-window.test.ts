import { describe, test, expect } from 'bun:test';
import { splitLongWindow, betaHeader, spiegaErrore } from './long-window';

/**
 * LA FINESTRA DA 1M SUL RUNTIME NATIVO.
 *
 * Gli id `claude-opus-5[1m]` e `claude-sonnet-5[1m]` sono una convenzione
 * NOSTRA, non nomi che l'API conosce: il suffisso dice «questo modello con la
 * finestra lunga», che sull'API si chiede con l'header beta
 * `context-1m-2025-08-07`.
 *
 * La CLI lo sa fare. Il loop nativo no: manda un solo beta
 * (`oauth-2025-04-20`) e il modello grezzo, suffisso compreso. Due conseguenze,
 * e la seconda è quella che si vede:
 *
 *   1. l'API riceve un id che non esiste;
 *   2. chi sceglie la finestra lunga nel picker si porta dietro la CLI intera —
 *      ~206 MB per topic — senza che nessuno gliel'abbia detto.
 *
 * Qui si prova la traduzione, che è la parte pura: id → (modello vero, beta da
 * aggiungere). Il resto è passare l'esito alle intestazioni.
 */
describe('la finestra lunga si chiede con un header, non col nome', () => {
  test("il suffisso esce dall'id e diventa una richiesta di finestra lunga", () => {
    expect(splitLongWindow('claude-opus-5[1m]')).toEqual({ model: 'claude-opus-5', longWindow: true });
    expect(splitLongWindow('claude-sonnet-5[1m]')).toEqual({ model: 'claude-sonnet-5', longWindow: true });
  });

  test('un id normale resta identico: non si tocca ciò che non ha il suffisso', () => {
    expect(splitLongWindow('claude-opus-5')).toEqual({ model: 'claude-opus-5', longWindow: false });
    expect(splitLongWindow('claude-haiku-4')).toEqual({ model: 'claude-haiku-4', longWindow: false });
  });

  test('il suffisso vale solo in CODA: `[1m]` in mezzo non è una variante', () => {
    // Difensivo, ma il costo è una riga: un id che contiene `[1m]` altrove è
    // un id sconosciuto, e trattarlo come finestra lunga manderebbe all'API un
    // modello inventato invece di farla fallire con chiarezza.
    expect(splitLongWindow('claude[1m]-opus')).toEqual({ model: 'claude[1m]-opus', longWindow: false });
  });

  test("l'header beta porta l'oauth SEMPRE, e la finestra solo quando serve", () => {
    // `oauth-2025-04-20` non è opzionale: senza, la richiesta non è nemmeno
    // autorizzata. La finestra lunga si AGGIUNGE, non sostituisce.
    expect(betaHeader(false)).toBe('oauth-2025-04-20');
    expect(betaHeader(true)).toBe('oauth-2025-04-20,context-1m-2025-08-07');
  });

  test('un 400 sulla finestra lunga diventa una frase, non un errore grezzo', () => {
    // Il caso: una famiglia che il beta non copre (haiku). Il picker non offre
    // quell'id - `longVariantOf` guarda cosa l'host annuncia - ma un topic
    // vecchio o un pin scritto a mano ci arriva lo stesso, e allora Anthropic
    // risponde «The long context beta is not yet available for this
    // subscription» a turno GIA' PARTITO. Quel testo, cosi' com'e', non dice a
    // chi legge ne' perche' ne' cosa fare.
    const m = spiegaErrore(400, 'The long context beta is not yet available for this subscription', 'claude-haiku-4-5[1m]');
    expect(m).toContain('claude-haiku-4-5');
    expect(m).toMatch(/finestra lunga|1M/i);
    // Dice la VIA D'USCITA, non solo il divieto.
    expect(m).toMatch(/senza|normale|togli/i);
  });

  test('gli altri errori restano intatti: non si traveste cio che non si capisce', () => {
    // Un 500, o un 400 per un'altra ragione, deve arrivare come sta scritto:
    // riscriverlo con una frase nostra nasconderebbe la causa vera.
    expect(spiegaErrore(500, 'internal error', 'claude-opus-5')).toContain('internal error');
    expect(spiegaErrore(400, 'max_tokens too large', 'claude-opus-5[1m]')).toContain('max_tokens too large');
  });

  test('i due beta stanno in UNA intestazione separati da virgola', () => {
    // È il formato che l'API accetta: due header `anthropic-beta` separati
    // verrebbero collassati dal fetch, e l'ultimo vincerebbe in silenzio.
    const h = betaHeader(true);
    expect(h.split(',')).toHaveLength(2);
    expect(h).not.toContain(' '); // niente spazi: la lista è compatta
  });
});

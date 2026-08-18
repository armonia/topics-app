/**
 * authorDisplay — dall'identità sul disco al nome sullo schermo.
 *
 * Le tre righe che questo modulo esiste per correggere sono le tre che questo
 * file presidia: «user» dove l'app sa il tuo nome, «dispatcher» dove ha agito
 * l'app, e otto caratteri di uuid dove va un nome. La regola sotto è una sola:
 * il NOME sta sullo schermo, l'IDENTITÀ sta nel `detail` (che il chiamante
 * mette nel tooltip), e niente si perde per strada.
 */
import { describe, test, expect } from 'bun:test';
import { commentAuthorLabel } from '../../../shared/comment-author';
import { authorDisplay, AUTHOR_NAME_KEYS } from './authorDisplay';
import { t } from './i18n';

/** Il traduttore vero, non un finto: se una chiave non è nel dizionario il
 *  test deve accorgersene qui, non su una scheda aperta. `t` ripiega sulla
 *  chiave stessa quando non la trova, quindi «tradotto» qui vuol dire
 *  «diverso dalla chiave». */
const tr = (k: string) => {
  const v = t(k, 'it');
  if (v === k) throw new Error(`chiave i18n mancante: ${k}`);
  return v;
};

const show = (author: string | null | undefined, owner?: string | null) =>
  authorDisplay(commentAuthorLabel(author), tr, owner);

describe('authorDisplay', () => {
  test('ogni chiave di nome esiste nel dizionario italiano', () => {
    for (const key of Object.values(AUTHOR_NAME_KEYS)) expect(tr(key)).toBeTruthy();
  });

  test('le TUE righe portano il tuo nome, non «user»', () => {
    // Un nome INVENTATO, e non è pignoleria: questo repo è pubblico e
    // `tests/unit/no-personal-data-tracked.test.ts` fa cadere il build quando un
    // file tracciato guadagna un termine personale. Ci era caduto il nome vero
    // del proprietario, che è esattamente ciò che quel cancello esiste per
    // fermare — e il valore di prova qui è identico con qualunque stringa.
    const r = show('user', 'Nome Cognome');
    expect(r.name).toBe('Nome Cognome');
    expect(r.self).toBe(true);
    // L'identità sul disco non si perde: resta per il tooltip.
    expect(r.detail).toBe('user');
  });

  test('senza un proprietario noto resta una PERSONA, non un ruolo di sistema', () => {
    expect(show('user', null).name).toBe(tr('board.task.author.you'));
    expect(show('user', '   ').name).toBe(tr('board.task.author.you'));
    expect(show('user').self).toBe(true);
  });

  test('«dispatcher» e «system» sono la stessa cosa per chi legge: l\'app', () => {
    const d = show('dispatcher');
    const s = show('system');
    expect(d.name).toBe(tr('board.task.author.app'));
    expect(s.name).toBe(d.name);
    // …ma il ruolo esatto resta distinguibile, che è il motivo per cui il
    // tooltip lo porta: se un giorno serve sapere QUALE dei due, è lì.
    expect(d.detail).toBe('dispatcher');
    expect(s.detail).toBe('system');
    expect(d.self).toBe(false);
  });

  test('un agent NON mostra il suo esadecimale, ma lo tiene per intero nel tooltip', () => {
    const r = show('agent:9f3a2c1d-4b5e-6789-abcd-ef0123456789');
    expect(r.name).toBe(tr('board.task.author.agent'));
    expect(r.name).not.toContain('9f3a');
    // Intero, non tagliato a otto: chi cerca la riga nel database ha bisogno
    // dell'id vero, ed è l'unico posto dove esiste ancora.
    expect(r.detail).toBe('9f3a2c1d-4b5e-6789-abcd-ef0123456789');
  });

  test('un NOME vero scritto dall\'agent resta suo', () => {
    // `looksLikeName` l'ha già promosso a nome: tradurlo in «Agent» butterebbe
    // via l'unica informazione che quella riga aveva in più delle altre.
    const r = show('Claude Code');
    expect(r.name).toBe('Claude Code');
    expect(r.self).toBe(false);
  });

  test('una FRASE non è un nome: ricade sul generico, non si stampa mezza', () => {
    // È il difetto che `comment-author.ts` esiste per contenere: il topic di un
    // agent dispatchato si chiama come il task tagliato a 60 caratteri.
    const r = show('Girare la barra viva della soglia di compattazione: due brac');
    expect(r.name).toBe(tr('board.task.author.agent'));
  });

  test('la verifica ha un nome suo: non è né te né l\'app', () => {
    const r = show('verifier');
    expect(r.name).toBe(tr('board.task.author.verifier'));
    expect(r.name).not.toBe(tr('board.task.author.app'));
    expect(r.self).toBe(false);
  });

  test('nessun nome è mai vuoto, per qualunque schifezza arrivi dal disco', () => {
    for (const a of [null, undefined, '', '   ', 'agent:', 'AGENT:  ', '\n\n']) {
      expect(show(a).name.trim().length).toBeGreaterThan(0);
    }
  });
});

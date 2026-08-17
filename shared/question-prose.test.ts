/**
 * UNA DOMANDA NON DEVE MAI ARRIVARE AL MARKDOWN COME CODICE.
 *
 * Misurato guardando la board il 17/08: la card di `63bcc31b` mostrava la
 * domanda sui sottotask fermi come blocco ```question, e `COMPACT_MD_CLS` la
 * disegna con `[&_pre]:overflow-x-auto` — 300 caratteri di italiano su una riga
 * sola, da leggere scorrendo di lato dentro una colonna stretta. Segnalato:
 * «vedo lo scroll orizzontale invece di vedere in verticale».
 */
import { describe, test, expect } from 'bun:test';
import { questionToProse } from './question-prose';
import { parseQuestionBlock } from './board';

/** La domanda esattamente come `askParkedChildren` la scrive nel thread. */
const DOMANDA = '```question\n'
  + 'Fermo su 2 sottotask che non lavorera nessuno («Costruisce UIMockup: piano 3D inclinato con sidebar, '
  + "contenuto, camera slide»): uno step lo muove solo l'agente di questa card dentro il proprio turno. "
  + "Li rimetto in coda, o archivio cio' che non serve piu'?\n"
  + '- Rimetti in coda i sottotask\n'
  + '- Archivia i sottotask\n'
  + '```';

describe('questionToProse', () => {
  test('il recinto sparisce: niente ``` significa niente blocco di codice', () => {
    const out = questionToProse(DOMANDA);
    expect(out).not.toContain('```');
    // ...e la domanda resta tutta: si cambia come si legge, non cosa si legge.
    expect(out).toContain('Fermo su 2 sottotask');
    expect(out).toContain("archivio cio' che non serve piu'?");
  });

  test('le opzioni diventano un elenco markdown vero, che va a capo da solo', () => {
    const out = questionToProse(DOMANDA);
    expect(out).toContain('- Rimetti in coda i sottotask');
    expect(out).toContain('- Archivia i sottotask');
    // Un elenco puntato sta in un <ul>, che in COMPACT_MD_CLS ha `break-words`:
    // e' esattamente la differenza fra andare a capo e scorrere di lato.
  });

  test('ogni altro commento passa IDENTICO: nessun rischio sulla stragrande maggioranza', () => {
    const normale = 'Fatto. Ho spostato il bottone e ora regge a 320px.';
    expect(questionToProse(normale)).toBe(normale);
    // Un blocco di codice VERO resta codice: li' lo scroll orizzontale e' giusto.
    const codice = 'Ecco la riga:\n\n```ts\nconst x = 1;\n```';
    expect(questionToProse(codice)).toBe(codice);
  });

  test('un recinto rotto non si tocca: meglio brutto che mangiato', () => {
    // Aperto e mai chiuso: `parseQuestionBlock` non lo legge, e una regex
    // avida qui mangerebbe il resto del commento.
    const rotto = '```question\nDomanda senza chiusura';
    expect(questionToProse(rotto)).toBe(rotto);
    // Corpo vuoto: stessa prudenza.
    const vuoto = '```question\n```';
    expect(questionToProse(vuoto)).toBe(vuoto);
  });

  test('il testo attorno al recinto resta al suo posto', () => {
    const con = 'Ho finito il primo pezzo.\n\n```question\nProseguo col secondo?\n- Si\n- No\n```';
    const out = questionToProse(con);
    expect(out).toContain('Ho finito il primo pezzo.');
    expect(out).toContain('Proseguo col secondo?');
    expect(out).not.toContain('```');
  });

  test('non cambia cosa il PARSER legge: i bottoni restano quelli', () => {
    // La prosa e' per gli occhi. Le risposte rapide continuano a nascere dal
    // testo originale, che questo modulo non riscrive mai sul disco.
    const q = parseQuestionBlock(DOMANDA);
    expect(q!.options).toEqual(['Rimetti in coda i sottotask', 'Archivia i sottotask']);
  });
});

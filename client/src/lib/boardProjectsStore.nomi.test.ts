import { describe, test, expect } from 'bun:test';
import { projectNameFromId, resolveProjectRefs, UNKNOWN_PROJECT_NAME } from './boardProjectsStore';

/**
 * «Vedo nei filtri un progetto con un codice strano. Non dovrei mai vedere un
 * codice, perché è incomprensibile.»
 *
 * Il ripiego per un progetto che l'indice non conosce toglieva l'ultimo pezzo
 * dell'id e chiamava nome quel che restava. Su un id di board funziona
 * (`acquapub-oz86j7` → `acquapub`), su un UUID no: usciva
 * `405fbb0d-6fdd-4874-b52d`, lo stesso codice con quattro cifre in meno.
 *
 * Misurato sui dati veri prima di toccare il codice: quindici `projectId` nei
 * task, uno dei quali un UUID assente dall'indice dei progetti. Non un caso di
 * scuola, il progetto che si vedeva a schermo.
 *
 * @covers KANBAN-02
 */
describe('un id non è un nome', () => {
  test('un id di board perde il suffisso: quello un nome ce l\'ha dentro', () => {
    expect(projectNameFromId('acquapub-oz86j7')).toBe('acquapub');
    expect(projectNameFromId('armonia-site-rr0tuo')).toBe('armonia-site');
    expect(projectNameFromId('fase2-i18n-unit-pts9bf')).toBe('fase2-i18n-unit');
  });

  test('un UUID non ha un nome dentro: torna null, non un frammento', () => {
    // L'id vero visto nei filtri il giorno della segnalazione.
    expect(projectNameFromId('405fbb0d-6fdd-4874-b52d-ce96180f9e2a')).toBeNull();
    expect(projectNameFromId('D9F1A2B3-0000-4C1D-8E2F-1234567890AB')).toBeNull();
  });

  test('nessun output contiene un pezzo di esadecimale spacciato per nome', () => {
    const uuid = '405fbb0d-6fdd-4874-b52d-ce96180f9e2a';
    const [ref] = resolveProjectRefs([uuid], []);
    expect(ref.name).toBe(UNKNOWN_PROJECT_NAME);
    // La falsificazione vera: qualunque cosa esca, non deve essere l'id
    // accorciato. Se un domani il ripiego torna a tagliare, questo morde.
    expect(ref.name).not.toContain('405fbb0d');
    expect(uuid.startsWith(ref.name)).toBe(false);
  });

  test('il progetto sconosciuto resta FILTRABILE: sparire nasconde i suoi task', () => {
    const uuid = '405fbb0d-6fdd-4874-b52d-ce96180f9e2a';
    const refs = resolveProjectRefs([uuid, 'acquapub-oz86j7'], []);
    expect(refs).toHaveLength(2);
    // L'id resta intatto: è la chiave con cui il filtro seleziona i task.
    expect(refs.map((r) => r.projectId)).toContain(uuid);
  });

  test('se l\'indice il progetto lo conosce, vince il nome vero', () => {
    const uuid = '405fbb0d-6fdd-4874-b52d-ce96180f9e2a';
    const [ref] = resolveProjectRefs([uuid], [
      { projectId: uuid, name: 'Arm Tracker', path: '/Users/x/arm-tracker' },
    ]);
    expect(ref.name).toBe('Arm Tracker');
  });

  test('la frase di ripiego è una frase, non un codice', () => {
    // Deve leggersi. Se qualcuno la cambia in 'unknown' o in un id, qui rompe.
    expect(UNKNOWN_PROJECT_NAME).toMatch(/^[A-Z][a-zà-ù ]+$/);
  });
});

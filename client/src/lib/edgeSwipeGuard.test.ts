/**
 * @covers GESTURE-01
 */
import { describe, expect, it } from 'bun:test';
import { edgeSwipeVerdict } from './edgeSwipeGuard';

/**
 * LA REGOLA DEL BORDO, senza un iPhone in mano.
 *
 * Il guardiano vero vive di `touchstart` non passivi dentro una PWA installata
 * su iOS: nessuna suite lo può eseguire. Ciò che si può isolare è la DECISIONE —
 * dato un punto e cosa c'è sotto, blocchiamo? e c'è un clic da rimettere? — ed è
 * lì che stava il difetto del 12/08: col cassetto aperto ogni pixel del bordo ha
 * un `<button>` sotto, e la vecchia regola («i comandi passano») regalava
 * l'intero gesto di chiusura al «indietro» di Safari.
 *
 * Il finto elemento espone solo `closest`, che è tutto ciò che la funzione
 * guarda. Il selettore si spezza sulle virgole e si confronta per intero: un
 * `includes` avrebbe fatto passare `input` per `input[type="file"]`, cioè
 * avrebbe risposto sì alla domanda sbagliata.
 */
function elemento(ruolo: string): Element {
  const finto = {
    closest: (sel: string) =>
      (sel.split(',').map((s) => s.trim()).includes(ruolo) ? finto : null),
  };
  return finto as unknown as Element;
}

const LARGHEZZA = 390;

describe('il bordo è nostro, ma il tocco torna a chi lo aspettava', () => {
  it('in mezzo allo schermo non si tocca niente', () => {
    expect(edgeSwipeVerdict(195, LARGHEZZA, elemento('div'))).toEqual({ blocca: false, comando: null });
  });

  it('sul bordo, superficie inerte: blocca e non ha nessun clic da rimettere', () => {
    expect(edgeSwipeVerdict(4, LARGHEZZA, elemento('div'))).toEqual({ blocca: true, comando: null });
    expect(edgeSwipeVerdict(LARGHEZZA - 4, LARGHEZZA, elemento('div'))).toEqual({ blocca: true, comando: null });
  });

  it('IL CASO DEL 12/08: sul bordo sopra un bottone blocca lo stesso, e si segna il comando', () => {
    const bottone = elemento('button');
    expect(edgeSwipeVerdict(4, LARGHEZZA, bottone)).toEqual({ blocca: true, comando: bottone });
    // È la riga della sidebar aperta a 100vw: il bordo destro è un comando
    // quanto il sinistro.
    expect(edgeSwipeVerdict(LARGHEZZA - 2, LARGHEZZA, bottone)).toEqual({ blocca: true, comando: bottone });
  });

  it('un campo di testo si blocca e si ricorda: il fuoco glielo rimette la guardia', () => {
    const campo = elemento('textarea');
    expect(edgeSwipeVerdict(2, LARGHEZZA, campo)).toEqual({ blocca: true, comando: campo });
  });

  it('i comandi di SISTEMA restano fuori: un clic sintetico non apre un menu nativo', () => {
    expect(edgeSwipeVerdict(2, LARGHEZZA, elemento('select'))).toEqual({ blocca: false, comando: null });
    expect(edgeSwipeVerdict(2, LARGHEZZA, elemento('input[type="file"]'))).toEqual({ blocca: false, comando: null });
  });

  it('niente sotto il dito è comunque bordo: si blocca', () => {
    expect(edgeSwipeVerdict(0, LARGHEZZA, null)).toEqual({ blocca: true, comando: null });
  });
});

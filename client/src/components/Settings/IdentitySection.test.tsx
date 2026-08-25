/**
 * La coda dei TOLTI, fissata dai due lati.
 *
 * Il gesto «cancella davvero questa persona» esiste per una ragione precisa:
 * `people.revoked_at` era una colonna letta in cinque punti che nessuna
 * schermata poteva scrivere, quindi una persona invitata per sbaglio restava
 * nel database per sempre, fuori da ogni elenco.
 *
 * Prima, quel gesto viveva DENTRO il JSX di `IdentitySection`: la separazione
 * fra chi c'è e chi è stato tolto era un `membri.filter(...)` in mezzo al
 * corpo del componente, e la coda un blocco di markup sotto. Cancellare la
 * separazione — rimettere `tolti = []`, o rimettere il filtro che buttava via i
 * bloccati appena arrivavano dal server — non faceva fallire NIENTE. È la
 * stessa famiglia di difetto che `TopicSettingsModal.test.tsx` presidia per il
 * carve-out sulle bozze, e la tecnica è la stessa: funzioni pure di props,
 * chiamate e ispezionate.
 *
 * Niente renderer e niente DOM: jsdom/happy-dom non sono dipendenze del
 * progetto (stessa scelta di `lib/haptics.test.ts` e di
 * `Modals/TopicSettingsModal.test.tsx`). `splitMembri` e `membriDaRisposta`
 * stanno in `./membri` e sono funzioni; `TolliQueue` non usa hook e riceve `t`
 * come prop, quindi la si chiama e si guarda l'albero che restituisce.
  * @covers PROFILE-07
 */
import { describe, test, expect } from 'bun:test';
import type { ReactElement, ReactNode } from 'react';

import { TolliQueue } from './IdentitySection';
import { splitMembri, membriDaRisposta, type Membro } from './membri';

function persona(id: string, blocked: boolean): Membro {
  return { id, name: `Nome ${id}`, email: null, role: 'member', devices: 0, owner: false, blocked };
}

/** Appiattisce l'albero restituito da un componente in un elenco di elementi. */
function elementi(nodo: ReactNode, dentro: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(nodo)) {
    for (const n of nodo) elementi(n as ReactNode, dentro);
    return dentro;
  }
  if (!nodo || typeof nodo !== 'object' || !('type' in nodo)) return dentro;
  const el = nodo as ReactElement<{ children?: ReactNode }>;
  dentro.push(el);
  elementi(el.props?.children, dentro);
  return dentro;
}

/** I bottoni di cancellazione della coda: quelli con un `onClick` proprio. */
function bottoniCancella(albero: ReactNode): ReactElement<{ onClick: () => void }>[] {
  return elementi(albero).filter(
    (e): e is ReactElement<{ onClick: () => void }> =>
      e.type === 'button' && typeof (e.props as { onClick?: unknown }).onClick === 'function',
  );
}

describe('splitMembri', () => {
  // Le DUE direzioni. Con una sola («i bloccati stanno in `tolti`») un
  // `presenti = membri` passerebbe lo stesso: la persona comparirebbe due
  // volte, nell'elenco vivo e nella coda dei cancellabili.
  test('un tolto sta SOLO fra i tolti, uno presente SOLO fra i presenti', () => {
    const dentro = persona('a', false);
    const fuori = persona('b', true);

    const { presenti, tolti } = splitMembri([dentro, fuori]);

    expect(presenti.map((m) => m.id)).toEqual(['a']);
    expect(tolti.map((m) => m.id)).toEqual(['b']);
  });

  test('nessuno è tolto: la coda è vuota e l’elenco vivo ha tutti', () => {
    const { presenti, tolti } = splitMembri([persona('a', false), persona('b', false)]);

    expect(presenti.map((m) => m.id)).toEqual(['a', 'b']);
    expect(tolti).toEqual([]);
  });

  test('sono tutti tolti: l’elenco vivo è vuoto, nessuno sparisce', () => {
    const { presenti, tolti } = splitMembri([persona('a', true), persona('b', true)]);

    expect(presenti).toEqual([]);
    expect(tolti.map((m) => m.id)).toEqual(['a', 'b']);
  });
});

describe('membriDaRisposta', () => {
  // Qui c'era un `.filter((m) => !m.blocked)`: i tolti non arrivavano proprio,
  // e la coda sotto non poteva esistere. Rimetterlo deve essere rosso.
  test('i tolti SOPRAVVIVONO alla risposta del server', () => {
    const membri = membriDaRisposta({ members: [persona('a', false), persona('b', true)] });

    expect(membri.map((m) => m.id)).toEqual(['a', 'b']);
    expect(membri.filter((m) => m.blocked).map((m) => m.id)).toEqual(['b']);
  });

  test('una risposta senza `members` — o assente — non è un errore: è un elenco vuoto', () => {
    expect(membriDaRisposta({})).toEqual([]);
    expect(membriDaRisposta(null)).toEqual([]);
  });
});

describe('TolliQueue', () => {
  const t = (chiave: string) => chiave;

  // CONTROLLO POSITIVO del canale di osservazione: senza, «non rende nulla»
  // sotto passerebbe anche con un componente che non rende MAI nulla.
  test('un gesto di cancellazione per ogni persona tolta, sulla persona giusta', () => {
    const tolti = [persona('a', true), persona('b', true), persona('c', true)];
    const cancellate: string[] = [];

    const reso = TolliQueue({ tolti, onDelete: (m) => cancellate.push(m.id), inCorso: false, rifiuto: null, t });

    const bottoni = bottoniCancella(reso);
    expect(bottoni).toHaveLength(3);
    for (const b of bottoni) b.props.onClick();
    expect(cancellate).toEqual(['a', 'b', 'c']);
  });

  test('nessun tolto: nessuna coda, e nessun titolo che annuncia una sezione vuota', () => {
    expect(TolliQueue({ tolti: [], onDelete: () => {}, inCorso: false, rifiuto: null, t })).toBeNull();
  });

  // Il rifiuto del server DICE cosa fare prima («ha ancora un dispositivo»): se
  // la frase non arriva, la cancellazione sembra un clic che non ha fatto
  // niente — il difetto originale, spostato di un passo.
  test('il motivo del rifiuto compare, e la sua chiave è quella che arriva', () => {
    const reso = TolliQueue({
      tolti: [persona('a', true)],
      onDelete: () => {},
      inCorso: false,
      rifiuto: 'auth.err.still_has_devices',
      t,
    });

    const frasi = elementi(reso).filter((e) => e.type === 'p');
    expect(frasi).toHaveLength(1);
    expect((frasi[0].props as { children?: unknown }).children).toBe('auth.err.still_has_devices');

    // Controllo negativo con il canale già dimostrato vivo: senza rifiuto,
    // nessuna frase.
    const senza = TolliQueue({ tolti: [persona('a', true)], onDelete: () => {}, inCorso: false, rifiuto: null, t });
    expect(elementi(senza).filter((e) => e.type === 'p')).toHaveLength(0);
  });

  // Mentre una cancellazione è in volo i bottoni non si ripremono: due DELETE
  // sulla stessa persona sono un 404 che l'interfaccia legge come un guasto.
  test('durante un’operazione i gesti sono disabilitati', () => {
    const reso = TolliQueue({ tolti: [persona('a', true)], onDelete: () => {}, inCorso: true, rifiuto: null, t });

    const bottoni = bottoniCancella(reso);
    expect(bottoni).toHaveLength(1);
    expect((bottoni[0].props as { disabled?: boolean }).disabled).toBe(true);
  });
});

import { useCallback, useEffect, useState } from 'react';
import { peopleApi, type PersonaConProfilo } from '@/lib/api';

/**
 * WHO AM I, as the profile surface needs to know it: the whole record, not just
 * a name and a face.
 *
 * `useProfileIdentity` already answers "what do I draw in the corner" and it
 * deliberately returns only a name and an avatar. The profile pages need the
 * id (to ask for their own followers and their own privacy), the counters and
 * the privacy block, so widening that hook would have made every caller of it
 * pay for a shape they do not read. Two hooks, one fetch each, and neither one
 * pretends to be the other.
 *
 * `null` means "not yet" and `pronto` means "the round trip is back". The two
 * are not the same thing: a page that treats "not yet" as "nobody" flashes an
 * empty state at every mount, which reads as data loss.
 */
export interface StatoIo {
  io: PersonaConProfilo | null;
  /** Everybody the server is willing to show me, me included. */
  rubrica: PersonaConProfilo[];
  pronto: boolean;
  ricarica: () => void;
  /** Puts a freshly returned record back in place, without a round trip. */
  aggiorna: (p: PersonaConProfilo) => void;
}

export function useIo(): StatoIo {
  const [rubrica, setRubrica] = useState<PersonaConProfilo[]>([]);
  const [pronto, setPronto] = useState(false);
  const [giro, setGiro] = useState(0);

  useEffect(() => {
    let annullato = false;
    peopleApi.list().then(
      ({ people }) => { if (!annullato) { setRubrica(people); setPronto(true); } },
      () => { if (!annullato) { setRubrica([]); setPronto(true); } },
    );
    return () => { annullato = true; };
  }, [giro]);

  const aggiorna = useCallback((p: PersonaConProfilo) => {
    setRubrica((cur) => cur.map((x) => (x.id === p.id ? p : x)));
  }, []);

  return {
    io: rubrica.find((p) => p.isMe) ?? null,
    rubrica,
    pronto,
    ricarica: useCallback(() => setGiro((n) => n + 1), []),
    aggiorna,
  };
}

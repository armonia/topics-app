/**
 * IO, come persona. Una fonte sola per tutte le superfici che dicono chi sei.
 *
 * La rubrica (`GET /api/people`) marca con `isMe` la riga di chi agisce: il
 * server la risolve da `devices.person_id` e, quando non c'è un dispositivo da
 * cui partire — il loopback, cioè la macchina davanti a cui sei seduto —
 * ripiega sul proprietario dell'installazione. È la stessa persona che
 * amministra account e organizzazioni, quindi la faccia in fondo alla sidebar e
 * il nome in Impostazioni non possono divergere.
 *
 * Un secondo posto da cui prendere l'avatar sarebbe un secondo avatar che un
 * giorno mostra un'altra persona: per questo la fetch sta qui e non nei due
 * componenti che la usavano.
 */
import { useCallback, useEffect, useState } from 'react';
import { peopleApi, type PersonaConProfilo } from '@/lib/api';

export function usePersonaCorrente(): PersonaConProfilo | null {
  const [io, setIo] = useState<PersonaConProfilo | null>(null);

  const carica = useCallback(async () => {
    try {
      const { people } = await peopleApi.list();
      setIo(people.find((p) => p.isMe) ?? null);
    } catch {
      // Transitorio: resta il nome del dispositivo, che arriva dalla sessione e
      // non dalla rete. Meglio di un nome sbagliato.
    }
  }, []);

  // La rubrica si chiede DOPO il primo paint, non durante: una scrittura di
  // stato sincrona in montaggio è ciò che `set-state-in-effect` marca, e ha
  // ragione. Un rinvio a zero millisecondi la toglie dal percorso critico
  // davvero, non la nasconde.
  useEffect(() => {
    const primo = setTimeout(() => { void carica(); }, 0);
    return () => clearTimeout(primo);
  }, [carica]);

  return io;
}

import { useCallback, useEffect, useState } from 'react';
import { peopleApi, type PersonWithProfile } from '@/lib/api';
import { subscribeSession, type SessionState } from '@/lib/auth/session';

/**
 * CHI SEI — una fonte sola, per chiunque debba disegnarti.
 *
 * La faccia arriva da `peopleApi.list()` (`isMe`), la stessa fonte della
 * rubrica: un secondo posto da cui prendere l'avatar sarebbe un secondo avatar
 * che un giorno mostra un'altra persona. Il nome ripiega sul nome della
 * sessione appaiata, e se non c'è nemmeno quello restano le iniziali di nulla:
 * chi disegna decide cosa scrivere al posto del nome, ma non inventa un nome.
 *
 * Sta in un file suo perché adesso i posti che chiedono «chi sei» sono due — la
 * porta del profilo in fondo allo schermo e il menu «Topics» — e la stessa
 * domanda fatta due volte con due copie di codice diverge alla prima modifica.
 */
export interface ProfiloIdentita {
  /** Il nome da mostrare, o stringa vuota se non lo sa ancora nessuno. */
  nome: string;
  /** L'avatar GitHub, se il profilo c'è. */
  avatarUrl: string | null;
  /** Lo stato della sessione: serve a dire QUALE dispositivo sei. */
  sessione: SessionState;
}

/** Le iniziali del nome, al massimo due. Il ripiego quando l'avatar non c'è. */
export function iniziali(nome: string): string {
  return nome
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');
}

export function useProfileIdentity(): ProfiloIdentita {
  const [io, setIo] = useState<PersonWithProfile | null>(null);
  const [sessione, setSessione] = useState<SessionState>({ status: 'loading' });

  useEffect(() => subscribeSession(setSessione), []);

  const caricaIo = useCallback(async () => {
    try {
      const { people } = await peopleApi.list();
      setIo(people.find((p) => p.isMe) ?? null);
    } catch {
      // Transitorio: resta il nome del dispositivo, che arriva dalla sessione e
      // non dalla rete.
    }
  }, []);

  // La rubrica si chiede DOPO il primo paint, non durante: una scrittura di
  // stato sincrona in montaggio è ciò che `set-state-in-effect` marca, e ha
  // ragione. Un rinvio a zero millisecondi la toglie dal percorso critico
  // davvero, non la nasconde.
  useEffect(() => {
    const primo = setTimeout(() => { void caricaIo(); }, 0);
    return () => clearTimeout(primo);
  }, [caricaIo]);

  const nome = io?.displayName
    ?? (sessione.status === 'paired' ? sessione.name : '')
    ?? '';

  return { nome, avatarUrl: io?.github?.avatarUrl ?? null, sessione };
}

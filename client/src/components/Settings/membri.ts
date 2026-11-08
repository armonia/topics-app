/**
 * Chi c'è in un gruppo, e chi ne è stato tolto.
 *
 * Sta in un modulo suo e non dentro `IdentitySection.tsx` per due ragioni che
 * puntano nella stessa direzione. La prima è la regola di Fast Refresh — un
 * file che esporta componenti non esporta anche funzioni — e vale quanto vale.
 * La seconda è quella vera: finché la separazione fra presenti e tolti era un
 * `membri.filter(...)` in mezzo al corpo del componente, cancellarla non faceva
 * fallire niente. Qui è una funzione pura con il suo test
 * (`IdentitySection.test.tsx`), e le due direzioni sono fissate.
 */

export type Ruolo = 'owner' | 'admin' | 'member';

export interface Membro {
  id: string;
  name: string;
  email: string | null;
  role: Ruolo;
  devices: number;
  owner: boolean;
  blocked: boolean;
}

/**
 * La risposta di `GET /api/auth/orgs/:id/members` così com'è, TOLTI COMPRESI.
 *
 * Nel componente qui c'era un `.filter((m) => !m.blocked)`, ed era il motivo
 * per cui una persona invitata per sbaglio diventava irraggiungibile: fuori da
 * ogni schermata e dentro il database per sempre. I tolti servono proprio dopo,
 * per l'unico gesto che li cancella davvero — cioè per scrivere
 * `people.revoked_at`, che senza quella coda resta una colonna letta in cinque
 * punti e scrivibile da nessuno.
 */
export function membriDaRisposta(corpo: { members?: Membro[] } | null | undefined): Membro[] {
  return corpo?.members ?? [];
}

/** I due elenchi: chi c'è, e chi è stato tolto. Ognuno sta in uno solo. */
export function splitMembri(membri: Membro[]): { presenti: Membro[]; tolti: Membro[] } {
  return {
    presenti: membri.filter((m) => !m.blocked),
    tolti: membri.filter((m) => m.blocked),
  };
}

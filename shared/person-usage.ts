/**
 * Le forme di `GET /api/usage/people` e `GET /api/usage/people/:personId`,
 * una volta sola per server e client (`tests/unit/no-type-mirrors.test.ts`).
 */

/** Una persona e quanto ha consumato nella finestra. */
export interface PersonUsageRow {
  /** null = le chiamate senza autore. */
  personId: string | null;
  name: string;
  /** Token pesati (input + 5·output + 1,25·cache scritta + 0,1·cache letta). */
  weighted: number;
  /** % di un account settimanale; null senza storico della quota. */
  accountPct: number | null;
  /** Quota del totale attribuito, in %. */
  sharePct: number;
}

export interface PeopleUsageMeta {
  days: number;
  since: string;
  until: string;
  /** false = storico della quota assente: ci sono solo i token pesati. */
  quotaHistory: boolean;
  /** Punti spesi da tutti gli account nell'intervallo (100 = un account settimanale). */
  totalPoints: number | null;
  /** Punti assegnati a una chiamata vista da Topics (il resto non ha chiamate nell'ora). */
  attributedPoints: number | null;
}

export interface PeopleUsage extends PeopleUsageMeta {
  people: PersonUsageRow[];
}

/** Una richiesta (il messaggio che ha avviato il lavoro) e quanto è costata. */
export interface PersonRequestRow {
  chatKey: string;
  chatName: string;
  requestId: string | null;
  request: string;
  at: string;
  calls: number;
  weighted: number;
  accountPct: number | null;
}

export interface PersonUsageDetail extends PeopleUsageMeta {
  personId: string | null;
  name: string;
  requests: PersonRequestRow[];
}

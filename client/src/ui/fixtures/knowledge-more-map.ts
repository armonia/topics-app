/**
 * The map of who knows what (o03). The numbers are the ones of the mockup, a
 * declared example: «Attività trovate» is the sum of the offices, «Scritte» (allow-italian: quotes the Italian interface)
 * their weighted share, «Una sola persona» their sum, so the headline cells (allow-italian: quotes the Italian interface)
 * are computed from the table and cannot drift from it. Roles are codes of
 * the example organization (RU, TEC, ...), never invented names. Activities
 * that have a written procedure point to it; the interview of Ruoli e
 * riscossione is the chat `intervista-catasto`.
 */
export interface MapActivitySeed {
  id: string;
  label: string;
  /** Who knows it, as role codes. */
  holders: string[];
  /** The procedure that writes it down, when there is one. */
  procedure?: string;
  /** The article that grounds it, `<item>/<article>`. */
  norm?: string;
  /** The interview chat that collects what is not written. */
  interview?: string;
}

export interface MapOfficeSeed {
  id: string;
  label: string;
  activities: number;
  /** Share of the activities that are written and approved, 0-100. */
  written: number;
  /** Activities that one person only knows. */
  singles: number;
  /** The riskiest one, in words. */
  riskiest: string;
  holder: { code: string; label: string };
  listed: MapActivitySeed[];
}

export const MAP_OFFICES: MapOfficeSeed[] = [
  {
    id: 'personale', label: 'Personale', activities: 21, written: 38, singles: 7, // allow-italian: fixture data, shown as written
    riskiest: 'Conteggio giornate stagionali', // allow-italian: fixture data, shown as written
    holder: { code: 'RPE', label: 'Responsabile del personale' }, // allow-italian: fixture data, shown as written
    listed: [
      { id: 'p-stagionali', label: 'Conteggio giornate stagionali', holders: ['RPE'] }, // allow-italian: fixture data, shown as written
      { id: 'p-tempo-det', label: 'Scadenze dei contratti a tempo determinato', holders: ['RPE'] }, // allow-italian: fixture data, shown as written
      { id: 'p-paghe', label: 'Invio dei dati delle paghe a Publisys', holders: ['RPE', 'RR'] }, // allow-italian: fixture data, shown as written
    ],
  },
  {
    id: 'ruoli', label: 'Ruoli e riscossione', activities: 26, written: 54, singles: 6, // allow-italian: fixture data, shown as written
    riskiest: 'Emissione del ruolo in Prunes', // allow-italian: fixture data, shown as written
    holder: { code: 'RU', label: 'Responsabile ruoli e riscossione' }, // allow-italian: fixture data, shown as written
    listed: [
      { id: 'r-ruolo', label: 'Emissione del ruolo in Prunes', holders: ['RU'], interview: 'intervista-catasto' }, // allow-italian: fixture data, shown as written
      { id: 'r-rimborso', label: 'Rimborso di un contributo pagato due volte', holders: ['RU', 'RR'], procedure: 'rimborso-contributo-doppio' }, // allow-italian: fixture data, shown as written
      { id: 'r-sgravio', label: 'Istanza di sgravio', holders: ['RU'], interview: 'intervista-catasto' }, // allow-italian: fixture data, shown as written
      { id: 'r-classifica', label: 'Classifica degli immobili', holders: ['RU', 'TEC'], norm: 'piano-classifica-1996/riparto' }, // allow-italian: fixture data, shown as written
    ],
  },
  {
    id: 'tecnico', label: 'Tecnico', activities: 31, written: 61, singles: 4, // allow-italian: fixture data, shown as written
    riskiest: 'Manovre idrovore in piena', // allow-italian: fixture data, shown as written
    holder: { code: 'TEC', label: 'Tecnico' }, // allow-italian: fixture data, shown as written
    listed: [
      { id: 't-idrovore', label: 'Manovre idrovore in piena', holders: ['TEC'] }, // allow-italian: fixture data, shown as written
      { id: 't-verbale', label: 'Verbale di polizia idraulica', holders: ['TEC', 'RP'], procedure: 'verbale-polizia-idraulica', norm: 'lr-7-2025/a10c2' }, // allow-italian: fixture data, shown as written
      { id: 't-concessione', label: 'Concessione di attraversamento', holders: ['TEC', 'RP'], procedure: 'concessione-attraversamento', norm: 'rd-368/a134' }, // allow-italian: fixture data, shown as written
      { id: 't-turno', label: "Turno irriguo d'emergenza", holders: ['TEC', 'OP'], procedure: 'turno-irriguo-emergenza', norm: 'piano-classifica-1996/irrigazione' }, // allow-italian: fixture data, shown as written
    ],
  },
  {
    id: 'ragioneria', label: 'Ragioneria', activities: 24, written: 79, singles: 2, // allow-italian: fixture data, shown as written
    riskiest: 'Chiusura di bilancio', // allow-italian: fixture data, shown as written
    holder: { code: 'RR', label: 'Responsabile della ragioneria' }, // allow-italian: fixture data, shown as written
    listed: [
      { id: 'g-bilancio', label: 'Chiusura di bilancio', holders: ['RR'] }, // allow-italian: fixture data, shown as written
      { id: 'g-fattura', label: 'Pagamento di una fattura passiva', holders: ['RR', 'RP'], procedure: 'pagamento-fattura-passiva', norm: 'dlgs-231-2002/a4c2' }, // allow-italian: fixture data, shown as written
      { id: 'g-proventi', label: 'Destinazione dei proventi delle sanzioni', holders: ['RR', 'TEC'], norm: 'lr-7-2025/a10c2' }, // allow-italian: fixture data, shown as written
    ],
  },
  {
    id: 'protocollo', label: 'Protocollo', activities: 18, written: 89, singles: 1, // allow-italian: fixture data, shown as written
    riskiest: 'Albo pretorio', // allow-italian: fixture data, shown as written
    holder: { code: 'RP', label: 'Responsabile del protocollo' }, // allow-italian: fixture data, shown as written
    listed: [
      { id: 'o-albo', label: 'Albo pretorio', holders: ['OP'] }, // allow-italian: fixture data, shown as written
      { id: 'o-accesso', label: 'Accesso agli atti e accesso civico', holders: ['RP', 'OP'], procedure: 'accesso-agli-atti', norm: 'dlgs-33-2013/a5c6' }, // allow-italian: fixture data, shown as written
      { id: 'o-pec', label: 'Smistamento della PEC in arrivo', holders: ['RP', 'OP'] }, // allow-italian: fixture data, shown as written
    ],
  },
  {
    id: 'legale', label: 'Legale', activities: 22, written: 68, singles: 3, // allow-italian: fixture data, shown as written
    riskiest: 'Gare sotto soglia su Traspare', // allow-italian: fixture data, shown as written
    holder: { code: 'AVV', label: 'Avvocato interno' }, // allow-italian: fixture data, shown as written
    listed: [
      { id: 'l-gare', label: 'Gare sotto soglia su Traspare', holders: ['AVV'] }, // allow-italian: fixture data, shown as written
      { id: 'l-giudizio', label: 'Costituzione in giudizio contro un ricorso', holders: ['AVV', 'RU'], procedure: 'costituzione-in-giudizio', norm: 'dlgs-546-1992/a23c1' }, // allow-italian: fixture data, shown as written
      { id: 'l-contenzioso', label: 'Aggiornamento del fascicolo in PA Legal', holders: ['AVV'] }, // allow-italian: fixture data, shown as written
    ],
  },
];

/** The role codes, and who they are. */
export const MAP_ROLES: Array<{ code: string; label: string }> = [
  { code: 'RPE', label: 'Responsabile del personale' }, // allow-italian: fixture data, shown as written
  { code: 'RU', label: 'Responsabile ruoli e riscossione' }, // allow-italian: fixture data, shown as written
  { code: 'TEC', label: 'Tecnico' }, // allow-italian: fixture data, shown as written
  { code: 'RR', label: 'Responsabile della ragioneria' }, // allow-italian: fixture data, shown as written
  { code: 'RP', label: 'Responsabile del protocollo' }, // allow-italian: fixture data, shown as written
  { code: 'AVV', label: 'Avvocato interno' }, // allow-italian: fixture data, shown as written
  { code: 'OP', label: 'Operatore del protocollo' }, // allow-italian: fixture data, shown as written
];

/** Activities and sole-owned activities per role, as the mockup's «Chi sa più cose non scritte». (allow-italian: quotes the Italian interface) */
export const MAP_PEOPLE: Array<{ code: string; activities: number; only: number; nearRetirement?: boolean }> = [
  { code: 'RU', activities: 11, only: 5, nearRetirement: true },
  { code: 'TEC', activities: 8, only: 3, nearRetirement: true },
  { code: 'RPE', activities: 9, only: 7 },
  { code: 'AVV', activities: 8, only: 3 },
  { code: 'RR', activities: 7, only: 2 },
  { code: 'OP', activities: 6, only: 1 },
  { code: 'RP', activities: 5, only: 0 },
];

/** Of the single-person activities, those known to two people close to retirement (declared example). */
export const MAP_NEAR_RETIREMENT = 9;
/** Where the activities were found (declared example, as the mockup says). */
export const MAP_BASE = { interviews: 19, pecWeeks: 4, goal: 90, goalBy: 'gennaio', nearRetirement: MAP_NEAR_RETIREMENT }; // allow-italian: fixture data, shown as written

/** People who could take over an activity held by one person, by role. */
export const MAP_SUBSTITUTES = ['RR', 'RP', 'OP'];

/** The people who know the most that is not written, as the mockup lists them. */
export const MAP_MOST_UNWRITTEN = ['RU', 'TEC', 'OP'];

/** The activity that needs a handover when the person who knows it retires: its substitute is chosen among these roles. */
export const MAP_HANDOVER = { activity: 'Conteggio giornate stagionali', role: 'RPE' }; // allow-italian: fixture data, shown as written

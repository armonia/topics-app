/**
 * Who uses the Consorzio edition of the preview, and what each of them may see
 * and do. The teams are the ones of the Consorzio di Bonifica Integrale
 * Comprensorio Sarno as the old preview drew them (`../org/people.ts`):
 * Direzione, Protocollo e segreteria, Ragioneria, Catasto e ruoli, Tecnico e
 * manutenzione, Polizia idraulica, Irrigazione, Legale e gare, Personale.
 * Nobody here is a real person: every one is a role marked as an example
 * (`DATI-VERI.md`: «Nomi di dipendenti: ruoli, non nomi inventati»). allow-italian: quotes the words on screen
 *
 * The agents are the workers of Topics that prepare and check: they never sign,
 * send or approve for a person. Same shape as `../sarim-org/people.ts`.
 */
import type { Permission, RoleDef } from '../org/people';
import type { SarimAgent, SarimPersona, SarimTeam } from '../sarim-org/people';

/** The areas of the Consorzio, as the cards, the team page and the filters name them (the same ids as the teams). */
export const NOCERA_AREA_LABEL: Record<string, string> = {
  direzione: 'Direzione', // allow-italian: fixture data, shown as written
  protocollo: 'Protocollo e segreteria', // allow-italian: fixture data, shown as written
  ragioneria: 'Ragioneria', // allow-italian: fixture data, shown as written
  catasto: 'Catasto e ruoli', // allow-italian: fixture data, shown as written
  tecnica: 'Tecnico e manutenzione', // allow-italian: fixture data, shown as written
  polizia: 'Polizia idraulica', // allow-italian: fixture data, shown as written
  irrigazione: 'Irrigazione', // allow-italian: fixture data, shown as written
  legale: 'Legale e gare', // allow-italian: fixture data, shown as written
  personale: 'Personale', // allow-italian: fixture data, shown as written
};

/** Every permission the Consorzio edition knows, in the order the team page lists them. */
export const NOCERA_PERMISSIONS: Permission[] = [
  'view:inbox', 'view:flows', 'view:contracts', 'view:data', 'view:knowledge', 'view:programs', 'view:team', 'view:settings',
  'edit:data', 'edit:contracts', 'approve:contracts', 'sign:contracts', 'edit:structure', 'approve', 'run:tests', 'admin', 'export',
];

const WORK: Permission[] = ['view:inbox', 'view:flows', 'view:data', 'view:knowledge', 'view:programs', 'view:team', 'edit:data'];

export const NOCERA_ROLES: RoleDef[] = [
  {
    id: 'nocera-direzione', label: 'Direzione', // allow-italian: fixture data, shown as written
    description: 'Vede tutto, approva e firma provvedimenti, concessioni e pagamenti, decide chi può fare cosa.', // allow-italian: fixture data, shown as written
    permissions: NOCERA_PERMISSIONS,
  },
  {
    id: 'nocera-protocollo', label: 'Protocollo e segreteria', // allow-italian: fixture data, shown as written
    description: 'Conferma cosa arriva in PEC, lo protocolla e lo smista ai team.', // allow-italian: fixture data, shown as written
    permissions: [...WORK, 'export'],
  },
  {
    id: 'nocera-ragioneria', label: 'Ragioneria', // allow-italian: fixture data, shown as written
    description: 'Fatture passive, liquidazioni e pagamenti; vede i contratti con i fornitori.', // allow-italian: fixture data, shown as written
    permissions: [...WORK, 'view:contracts', 'export'],
  },
  {
    id: 'nocera-catasto', label: 'Catasto e ruoli', // allow-italian: fixture data, shown as written
    description: 'Catasto consortile, avvisi di contributo, sgravi e rimborsi.', // allow-italian: fixture data, shown as written
    permissions: WORK,
  },
  {
    id: 'nocera-tecnica', label: 'Tecnico e manutenzione', // allow-italian: fixture data, shown as written
    description: 'Segnalazioni dal territorio, sopralluoghi, interventi e concessioni idrauliche.', // allow-italian: fixture data, shown as written
    permissions: [...WORK, 'view:contracts'],
  },
  {
    id: 'nocera-polizia', label: 'Polizia idraulica', // allow-italian: fixture data, shown as written
    description: 'Accertamenti, verbali e notifiche di polizia idraulica.', // allow-italian: fixture data, shown as written
    permissions: WORK,
  },
  {
    id: 'nocera-irrigazione', label: 'Irrigazione', // allow-italian: fixture data, shown as written
    description: 'Richieste di turno nei bacini di irrigazione collettiva.', // allow-italian: fixture data, shown as written
    permissions: WORK,
  },
  {
    id: 'nocera-legale', label: 'Legale e gare', // allow-italian: fixture data, shown as written
    description: 'Ricorsi, accessi agli atti, gare, contratti e incarichi ai legali; approva prima della firma.', // allow-italian: fixture data, shown as written
    permissions: [...WORK, 'view:contracts', 'view:settings', 'edit:contracts', 'approve:contracts', 'approve', 'export'],
  },
  {
    id: 'nocera-personale', label: 'Personale', // allow-italian: fixture data, shown as written
    description: 'Contratti a termine, visite mediche, certificati e comunicazioni obbligatorie.', // allow-italian: fixture data, shown as written
    permissions: [...WORK, 'view:contracts', 'edit:contracts'],
  },
];

export const NOCERA_PERSONAS: SarimPersona[] = [
  { id: 'cn-dg', name: 'Direttore generale (esempio)', short: 'Direttore gen.', monogram: 'DG', color: '#0f766e', role: 'nocera-direzione', area: 'direzione', orgs: ['nocera'], offices: [], home: '/da-fare', example: true }, // allow-italian: fixture data, shown as written
  { id: 'cn-protocollo', name: 'Responsabile del protocollo (esempio)', short: 'Resp. protocollo', monogram: 'PR', color: '#15803d', role: 'nocera-protocollo', area: 'protocollo', orgs: ['nocera'], offices: [], home: '/da-fare', example: true }, // allow-italian: fixture data, shown as written
  { id: 'cn-ragioneria', name: 'Responsabile della ragioneria (esempio)', short: 'Resp. ragioneria', monogram: 'RA', color: '#1d4ed8', role: 'nocera-ragioneria', area: 'ragioneria', orgs: ['nocera'], offices: [], home: '/da-fare', example: true }, // allow-italian: fixture data, shown as written
  { id: 'cn-catasto', name: 'Responsabile catasto e ruoli (esempio)', short: 'Resp. catasto', monogram: 'CA', color: '#92400e', role: 'nocera-catasto', area: 'catasto', orgs: ['nocera'], offices: [], home: '/da-fare', example: true }, // allow-italian: fixture data, shown as written
  { id: 'cn-tecnico', name: 'Responsabile tecnico (esempio)', short: 'Resp. tecnico', monogram: 'TE', color: '#0369a1', role: 'nocera-tecnica', area: 'tecnica', orgs: ['nocera'], offices: [], home: '/da-fare', example: true }, // allow-italian: fixture data, shown as written
  { id: 'cn-polizia', name: 'Ufficiale idraulico (esempio)', short: 'Uff. idraulico', monogram: 'UI', color: '#b45309', role: 'nocera-polizia', area: 'polizia', orgs: ['nocera'], offices: [], home: '/da-fare', example: true }, // allow-italian: fixture data, shown as written
  { id: 'cn-irrigazione', name: 'Responsabile irrigazione (esempio)', short: 'Resp. irrigazione', monogram: 'IR', color: '#0e7490', role: 'nocera-irrigazione', area: 'irrigazione', orgs: ['nocera'], offices: [], home: '/da-fare', example: true }, // allow-italian: fixture data, shown as written
  { id: 'cn-legale', name: 'Avvocato interno (esempio)', short: 'Avv. interno', monogram: 'AV', color: '#7c3aed', role: 'nocera-legale', area: 'legale', orgs: ['nocera'], offices: [], home: '/da-fare', example: true }, // allow-italian: fixture data, shown as written
  { id: 'cn-personale', name: 'Responsabile del personale (esempio)', short: 'Resp. personale', monogram: 'PE', color: '#be185d', role: 'nocera-personale', area: 'personale', orgs: ['nocera'], offices: [], home: '/da-fare', example: true }, // allow-italian: fixture data, shown as written
];

/** The teams in the order of the old preview; the nine agents are a team of their own (`NOCERA_AGENTS_TEAM`). */
export const NOCERA_TEAMS: SarimTeam[] = [
  { id: 'direzione', label: 'Direzione', lead: 'cn-dg', does: 'Vede tutto, approva e firma provvedimenti, concessioni e pagamenti, decide chi può fare cosa.' }, // allow-italian: fixture data, shown as written
  { id: 'protocollo', label: 'Protocollo e segreteria', lead: 'cn-protocollo', does: 'PEC in arrivo, protocollo e smistamento ai team, albo.' }, // allow-italian: fixture data, shown as written
  { id: 'ragioneria', label: 'Ragioneria', lead: 'cn-ragioneria', does: 'Fatture passive, liquidazioni e pagamenti.' }, // allow-italian: fixture data, shown as written
  { id: 'catasto', label: 'Catasto e ruoli', lead: 'cn-catasto', does: 'Catasto consortile, avvisi di contributo, sgravi e rimborsi.' }, // allow-italian: fixture data, shown as written
  { id: 'tecnica', label: 'Tecnico e manutenzione', lead: 'cn-tecnico', does: 'Manutenzione dei canali e delle vasche, segnalazioni dal territorio, concessioni idrauliche.' }, // allow-italian: fixture data, shown as written
  { id: 'polizia', label: 'Polizia idraulica', lead: 'cn-polizia', does: 'Vigilanza sui canali, verbali e sanzioni di polizia idraulica.' }, // allow-italian: fixture data, shown as written
  { id: 'irrigazione', label: 'Irrigazione', lead: 'cn-irrigazione', does: 'Turni irrigui nei bacini di irrigazione collettiva, pozzi e vasche di accumulo.' }, // allow-italian: fixture data, shown as written
  { id: 'legale', label: 'Legale e gare', lead: 'cn-legale', does: 'Ricorsi, accessi agli atti, gare, contratti e incarichi ai legali.' }, // allow-italian: fixture data, shown as written
  { id: 'personale', label: 'Personale', lead: 'cn-personale', does: 'Contratti a termine, visite mediche, certificati e comunicazioni obbligatorie.' }, // allow-italian: fixture data, shown as written
];

/** The team the nine agents of Topics form: no leader, no permissions to give. */
export const NOCERA_AGENTS_TEAM = { id: 'agenti', label: 'Agenti' } as const; // allow-italian: fixture data, shown as written

export const NOCERA_DEFAULT_PERSONA = 'cn-dg';

export const NOCERA_AGENTS: SarimAgent[] = [
  { id: 'ag-pec', name: 'Agente PEC e protocollo', does: 'legge la PEC, riconosce il tipo, propone il team e calcola le scadenze', area: 'protocollo' }, // allow-italian: fixture data, shown as written
  { id: 'ag-fatture', name: 'Agente fatture passive', does: 'legge la fattura, la abbina a ordine e determina, prepara la liquidazione', area: 'ragioneria' }, // allow-italian: fixture data, shown as written
  { id: 'ag-irrigazione', name: 'Agente turni irrigui', does: 'legge la richiesta, verifica bacino e particella, propone giorno e ora', area: 'irrigazione' }, // allow-italian: fixture data, shown as written
  { id: 'ag-segnalazioni', name: 'Agente segnalazioni', does: 'legge la segnalazione, localizza il canale, propone squadra e priorità', area: 'tecnica' }, // allow-italian: fixture data, shown as written
  { id: 'ag-concessioni', name: 'Agente concessioni idrauliche', does: 'legge la richiesta, verifica la completezza, prepara disciplinare e canone', area: 'tecnica' }, // allow-italian: fixture data, shown as written
  { id: 'ag-polizia', name: 'Agente polizia idraulica', does: 'legge il verbale, localizza il tratto, prepara la notifica e i termini', area: 'polizia' }, // allow-italian: fixture data, shown as written
  { id: 'ag-contributi', name: 'Agente contributi e sgravi', does: 'legge l\'istanza, trova il contribuente, prepara conteggio e provvedimento', area: 'catasto' }, // allow-italian: fixture data, shown as written
  { id: 'ag-personale', name: 'Agente personale', does: 'legge contratti, visite e certificati in scadenza, prepara scheda e lettera', area: 'personale' }, // allow-italian: fixture data, shown as written
  { id: 'ag-contratti', name: 'Agente contratti e gare', does: 'legge capitolato e bando, estrae importo, CIG e requisiti, prepara la determina', area: 'legale' }, // allow-italian: fixture data, shown as written
];

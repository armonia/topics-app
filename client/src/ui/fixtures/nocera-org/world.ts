/**
 * The Consorzio di Bonifica Integrale Comprensorio Sarno as a world: the data
 * of this folder assembled in the shape the screens of
 * `client/src/ui-gallery/orbit/` read (`../world-types.ts`), plus the words,
 * ids and samples that belong to the Consorzio and not to the screens. Same
 * job as `../orbit-org/world.ts`; `consorzio-main.tsx` hands this to
 * `setWorld()` before it imports the app.
 *
 * Words of the Consorzio that are facts (the figures, the laws, the comuni)
 * come from the public sources named in `organization.ts`; what is an example
 * (people, amounts, dates of the cases) is marked as such where it is written.
 */
import type { OrgWords } from '../../copy/org-words';
import type { OrgWorld } from '../world-types';
import { NOCERA_CARDS, NOCERA_STAGES } from './cards';
import { NOCERA_CONTRACTS } from './contracts';
import { NOCERA_TOWNS } from './data';
import { NOCERA_OPS_FLOWS, NOCERA_SPLITS } from './flows';
import { NOCERA_KNOWLEDGE_COLLECTIONS, NOCERA_KNOWLEDGE_DOCS, NOCERA_KNOWLEDGE_QUESTIONS } from './knowledge';
import {
  NOCERA_CERTIFICATIONS, NOCERA_CERTIFICATIONS_SOURCE, NOCERA_IDENTITY, NOCERA_NUMBERS, NOCERA_NUMBERS_SOURCE, NOCERA_SERVED_SOURCE,
} from './organization';
import {
  NOCERA_AGENTS, NOCERA_AGENTS_TEAM, NOCERA_AREA_LABEL, NOCERA_DEFAULT_PERSONA, NOCERA_PERMISSIONS, NOCERA_PERSONAS, NOCERA_ROLES, NOCERA_TEAMS,
} from './people';
import { NOCERA_PROGRAMS } from './programs';
import { NOCERA_STEP_DATA } from './step-data';

export const NOCERA_WORDS: OrgWords = {
  name: 'Consorzio di Nocera', // allow-italian: fixture data, shown as written
  articled: { the: 'il Consorzio di Nocera', of: 'del Consorzio di Nocera', from: 'dal Consorzio di Nocera', for: 'per il Consorzio di Nocera', inAll: 'in tutto il Consorzio' }, // allow-italian: fixture data, shown as written
  legalName: 'Consorzio di Bonifica Integrale Comprensorio Sarno', // allow-italian: fixture data, shown as written
  slug: 'consorzio', // allow-italian: file name prefix, shown as written
  refPrefix: 'CONS',
  registryName: 'Halley',
  it: {
    townsLabel: 'Comuni del comprensorio', // allow-italian: fixture data, shown as written
    townsAbout: "I comuni del comprensorio Alto e Basso, dal Libro dell'anno 2025", // allow-italian: fixture data, shown as written
    servedTitle: (n) => `${n} comuni del comprensorio`, // allow-italian: fixture data, shown as written
    servedBody: "Sono quelli del Libro dell'anno 2025: 11 del comprensorio Alto e 10 del Basso. Il Libro non dice dal quando né quale servizio per comune.", // allow-italian: fixture data, shown as written
    numbersBody: "Le cifre del Libro dell'anno 2025 e del conto economico 2024, ciascuna con la sua fonte.", // allow-italian: fixture data, shown as written
    organizationKeywords: 'codice fiscale sede nocera inferiore pec telefono comprensorio bacini comuni ettari rete idraulica pozzi vasche dipendenti', // allow-italian: fixture data, shown as written
    sendExamples: 'ai Comuni, ai consorziati, ai fornitori, alla Regione', // allow-italian: fixture data, shown as written
    programsExamples: 'una registrazione in TeamSystem, un protocollo in Halley, un avviso in Prunes', // allow-italian: fixture data, shown as written
    flowEditExample: 'al passo 4 aggiungi chi avvisa il tecnico del bacino se il turno slitta', // allow-italian: fixture data, shown as written
    approveExamples: 'pagamenti con differenze, proroghe dei contratti a termine, determine', // allow-italian: fixture data, shown as written
    variantReasonExample: 'Es. proroga del noleggio degli escavatori fino a dicembre', // allow-italian: fixture data, shown as written
    variantFlow: 'Contratti, gare e incarichi', // allow-italian: fixture data, shown as written
    views: {
      stuckReports: 'Segnalazioni ferme', // allow-italian: fixture data, shown as written
      pecToCheck: 'PEC da verificare', // allow-italian: fixture data, shown as written
      invoicesToCheck: 'Fatture da verificare', // allow-italian: fixture data, shown as written
      recordsToSign: 'Verbali da firmare', // allow-italian: fixture data, shown as written
      staffDue: 'Personale in scadenza entro 30 giorni', // allow-italian: fixture data, shown as written
    },
    tables: {
      pec: { label: 'PEC e protocollo', about: 'Una riga per card del flusso PEC da protocollare: la PEC, il tipo, il team a cui va, la scadenza' }, // allow-italian: fixture data, shown as written
      fatture: { label: 'Fatture passive', about: 'Una riga per fattura del flusso Fattura passiva' }, // allow-italian: fixture data, shown as written
      irrigazione: { label: 'Turni irrigui', about: 'Una riga per richiesta del flusso Turno irriguo: bacino, particella, coltura' }, // allow-italian: fixture data, shown as written
      segnalazioni: { label: 'Segnalazioni e concessioni', about: 'Le segnalazioni dal territorio e le richieste di concessione idraulica, una riga per card' }, // allow-italian: fixture data, shown as written
      verbali: { label: 'Verbali', about: 'Una riga per verbale del flusso Polizia idraulica' }, // allow-italian: fixture data, shown as written
      contributi: { label: 'Contributi e sgravi', about: 'Una riga per istanza del flusso Istanza di sgravio' }, // allow-italian: fixture data, shown as written
      personale: { label: 'Personale', about: 'Contratti a termine, visite mediche, certificati e comunicazioni obbligatorie' }, // allow-italian: fixture data, shown as written
      gare: { label: 'Gare e incarichi', about: 'Una riga per gara, determina o incarico del flusso Contratti, gare e incarichi' }, // allow-italian: fixture data, shown as written
      contratti: { label: 'Contratti', about: 'Ogni contratto con la versione in vigore, il valore e le scadenze' }, // allow-italian: fixture data, shown as written
      comuni: { label: 'Comuni del comprensorio', about: "I comuni del comprensorio Alto e Basso, dal Libro dell'anno 2025" }, // allow-italian: fixture data, shown as written
    },
  },
  en: {
    townsLabel: 'Towns of the district',
    townsAbout: "The towns of the Alto and Basso districts, from the Libro dell'anno 2025", // allow-italian: quotes the title of the book
    servedTitle: (n) => `${n} towns of the district`,
    servedBody: "These are the ones in the Libro dell'anno 2025: 11 of the Alto district and 10 of the Basso. The book gives neither a start date nor the service for each town.", // allow-italian: quotes the title of the book
    numbersBody: "The figures of the Libro dell'anno 2025 and of the 2024 income statement, each with its source.", // allow-italian: quotes the title of the book
    organizationKeywords: 'tax code registered office nocera inferiore certified mail phone district basins towns hectares hydraulic network wells tanks staff',
    sendExamples: 'to the towns, the members, suppliers, the Region',
    programsExamples: 'a registration in TeamSystem, a protocol entry in Halley, a notice in Prunes',
    flowEditExample: 'at step 4 add who tells the basin technician when the turn slips',
    approveExamples: 'payments with differences, extensions of fixed-term contracts, determinations',
    variantReasonExample: 'E.g. excavator rental extended to December',
    variantFlow: 'Contracts, tenders and appointments',
    views: {
      stuckReports: 'Stopped reports',
      pecToCheck: 'Certified mail to check',
      invoicesToCheck: 'Invoices to check',
      recordsToSign: 'Records to sign',
      staffDue: 'Staff due within 30 days',
    },
    tables: {
      pec: { label: 'Certified mail and registry', about: 'One row per card of the certified mail and registry flow: the mail, its type, the team it goes to, the deadline' },
      fatture: { label: 'Supplier invoices', about: 'One row per invoice of the supplier invoices flow' },
      irrigazione: { label: 'Irrigation turns', about: 'One row per request of the irrigation turns flow: basin, parcel, crop' },
      segnalazioni: { label: 'Reports and permits', about: 'The reports from the territory and the requests for a hydraulic permit, one row per card' },
      verbali: { label: 'Records', about: 'One row per record of the hydraulic police flow' },
      contributi: { label: 'Contributions and relief', about: 'One row per request of the contributions and relief flow' },
      personale: { label: 'Staff', about: 'Fixed-term contracts, medical visits, certificates and compulsory notices' },
      gare: { label: 'Tenders and appointments', about: 'One row per tender, determination or appointment of the contracts, tenders and appointments flow' },
      contratti: { label: 'Contracts', about: 'Every contract with the version in force, its value and its dates' },
      comuni: { label: 'Towns of the district', about: "The towns of the Alto and Basso districts, from the Libro dell'anno 2025" }, // allow-italian: quotes the title of the book
    },
  },
};

export const NOCERA_WORLD: OrgWorld = {
  key: 'nocera',
  name: 'Consorzio di Nocera', // allow-italian: fixture data, shown as written
  shortName: 'Consorzio di Nocera', // allow-italian: fixture data, shown as written
  monogram: 'CN',
  color: '#15803d',
  words: NOCERA_WORDS,

  stages: NOCERA_STAGES,
  cards: NOCERA_CARDS,
  opsFlows: NOCERA_OPS_FLOWS,
  contracts: NOCERA_CONTRACTS,
  towns: NOCERA_TOWNS,
  programs: NOCERA_PROGRAMS,
  stepData: NOCERA_STEP_DATA,
  flowSplits: NOCERA_SPLITS,
  knowledge: {
    collections: NOCERA_KNOWLEDGE_COLLECTIONS,
    docs: NOCERA_KNOWLEDGE_DOCS,
    questions: NOCERA_KNOWLEDGE_QUESTIONS,
    /* The day each fixed document was last loaded or updated in Topics; the book is the PDF of March 2026. */
    updated: {
      'lr-7-2025': '2025-06-06',
      'rd-368-1904': '2026-09-25',
      'rd-523-1904': '2026-09-25',
      'lr-13-1983': '2026-09-25',
      'regolamento-polizia-idraulica': '2026-09-25',
      'piano-classifica-1996': '2026-09-30',
      'dlgs-546-1992': '2026-09-25',
      'dlgs-33-2013': '2026-09-25',
      'libro-anno-2025': '2026-03-31',
      'send-2026': '2026-10-20',
      'albo-legali-2026': '2026-10-02',
      'accordo-quadro-ingegneria-2026': '2026-10-30',
    },
  },
  organization: {
    identity: NOCERA_IDENTITY,
    certifications: NOCERA_CERTIFICATIONS,
    certificationsSource: NOCERA_CERTIFICATIONS_SOURCE,
    numbers: NOCERA_NUMBERS,
    numbersSource: NOCERA_NUMBERS_SOURCE,
    servedSource: NOCERA_SERVED_SOURCE,
  },
  people: {
    areaLabel: NOCERA_AREA_LABEL,
    permissions: NOCERA_PERMISSIONS,
    roles: NOCERA_ROLES,
    personas: NOCERA_PERSONAS,
    teams: NOCERA_TEAMS,
    agentsTeam: NOCERA_AGENTS_TEAM,
    defaultPersona: NOCERA_DEFAULT_PERSONA,
    agents: NOCERA_AGENTS,
    managerRole: 'nocera-direzione', // allow-italian: role id, compared by value
    /* The Consorzio has no read-only role: no person has this one and no team is called so. */
    viewerRole: 'nocera-lettura', // allow-italian: role id, compared by value
    managerTeam: 'direzione', // allow-italian: team id, compared by value
    viewerTeam: 'lettura', // allow-italian: team id, compared by value
    directorId: 'cn-dg',
    legalLeadId: 'cn-legale',
    contractsAgentId: 'ag-contratti',
  },

  /* The Consorzio publishes its own tenders: there is no «take part in a tender» rule, so no `tender` role. */
  flowRoles: { variants: 'nocera-contratti', reports: 'nocera-segnalazioni' },
  flowIcons: {
    'nocera-pec': 'file-text',
    'nocera-fatture': 'receipt',
    'nocera-irrigazione': 'droplets',
    'nocera-segnalazioni': 'wrench',
    'nocera-concessioni': 'map',
    'nocera-polizia': 'gavel',
    'nocera-contributi': 'wallet',
    'nocera-personale': 'users',
    'nocera-contratti': 'file-pen',
  },
  programRoles: {
    send: ['send', 'pec-aruba'],
    registry: ['halley'],
    writes: ['halley', 'prunes', 'teamsystem', 'publisys', 'palegal', 'traspare', 'm365'],
  },
  dataTables: [
    { id: 'pec', flows: ['nocera-pec'] }, // allow-italian: address segment and flow id, compared by value
    { id: 'fatture', flows: ['nocera-fatture'] }, // allow-italian: address segment and flow id, compared by value
    { id: 'irrigazione', flows: ['nocera-irrigazione'] }, // allow-italian: address segment and flow id, compared by value
    { id: 'segnalazioni', flows: ['nocera-segnalazioni', 'nocera-concessioni'] }, // allow-italian: address segment and flow ids, compared by value
    { id: 'verbali', flows: ['nocera-polizia'] }, // allow-italian: address segment and flow id, compared by value
    { id: 'contributi', flows: ['nocera-contributi'] }, // allow-italian: address segment and flow id, compared by value
    { id: 'personale', flows: ['nocera-personale'] }, // allow-italian: address segment and flow id, compared by value
    { id: 'gare', flows: ['nocera-contratti'] }, // allow-italian: address segment and flow id, compared by value
  ],
  dataViews: [
    { id: 'stuckReports', table: 'segnalazioni', stopped: true }, // allow-italian: address segment, compared by value
    { id: 'pecToCheck', table: 'pec', stage: 'verifica' }, // allow-italian: address segment and stage id, compared by value
    { id: 'invoicesToCheck', table: 'fatture', stage: 'verifica' }, // allow-italian: address segment and stage id, compared by value
    { id: 'recordsToSign', table: 'verbali', stage: 'approvazione' }, // allow-italian: address segment and stage id, compared by value
    { id: 'staffDue', table: 'personale', dueWithin: 30 }, // allow-italian: address segment, compared by value
  ],
  /* No contract hangs from another: the two lots of the framework agreement are two contracts of their own. */
  contractFamily: [],
  legacyGroupFlows: {},
  samples: {
    cards: ['PEC-2418', 'SG-2420', 'CT-2398', 'VP-2395'],
    cardOriginals: [['PEC-2418', 'pec'], ['CT-2398', 'schema']], // allow-italian: original ids, compared by value
    persons: ['cn-legale', 'ag-contratti', 'cn-protocollo', 'ag-segnalazioni'],
    flows: ['nocera-pec', 'nocera-contratti', 'nocera-fatture'],
    flowSteps: [['nocera-pec', 's3'], ['nocera-contratti', 's6']],
    programs: ['halley', 'prunes', 'teamsystem', 'qgis'],
    contracts: ['ct-ingegneria-lotto1', 'ct-energia-pozzi', 'ct-albo-legali', 'ct-noleggio-escavatori'],
    clauses: [['ct-ingegneria-lotto1', 'art-1'], ['ct-energia-pozzi', 'art-8']],
    contractObligations: ['ct-ingegneria-lotto1', 'ct-albo-legali'],
    contractComments: ['ct-ingegneria-lotto1'],
    contractVersions: ['ct-ingegneria-lotto1', 'ct-energia-pozzi'],
    contractAttachments: ['ct-ingegneria-lotto1'],
    contractLinks: ['ct-ingegneria-lotto1'],
    signatures: ['ct-ingegneria-lotto1', 'ct-energia-pozzi'],
    compares: [['ct-ingegneria-lotto1', 1, 2], ['ct-albo-legali', 1, 2], ['ct-energia-pozzi', 1, 2]],
    attachments: [['ct-ingegneria-lotto1', 'at-ing1-v2'], ['ct-ingegneria-lotto1', 'at-ing1-lotto'], ['ct-energia-pozzi', 'at-en-v2']],
    rules: ['lr-7-2025', 'dlgs-546-1992', 'proc-pec'],
    ruleParts: [['lr-7-2025', 'art-10-c2-b'], ['proc-pec', 's4']],
    ruleVersions: ['lr-7-2025', 'proc-pec'],
    ruleUsage: ['lr-7-2025'],
    documents: ['libro-anno-2025', 'send-2026'],
    documentVersions: ['libro-anno-2025'],
    documentUsage: ['libro-anno-2025'],
    dataTables: ['segnalazioni', 'contratti', 'comuni', 'fatture'], // allow-italian: address segments, not shown
    dataBoards: ['segnalazioni', 'contratti'], // allow-italian: address segments, not shown
    dataCharts: ['segnalazioni', 'contratti'], // allow-italian: address segments, not shown
    dataRows: [['segnalazioni', 'SG-2420'], ['contratti', 'ct-ingegneria-lotto1'], ['comuni', 'siano'], ['verbali', 'VP-2395']], // allow-italian: address segments, not shown
  },
};

/**
 * SARIM as a world: the data of this folder assembled in the shape the screens
 * of `client/src/ui-gallery/sarim/` read (`../world-types.ts`), plus the words,
 * ids and samples that used to be written in those screens. Nothing here
 * changes a datum; it only gives each one its place.
 */
import type { OrgWorld } from '../world-types';
import { SARIM_CARDS, SARIM_STAGES } from './cards';
import { SARIM_CONTRACTS } from './contracts';
import { SARIM_TOWNS } from './data';
import { SARIM_OPS_FLOWS, SARIM_SPLITS } from './flows';
import { SARIM_KNOWLEDGE_COLLECTIONS, SARIM_KNOWLEDGE_DOCS, SARIM_KNOWLEDGE_QUESTIONS } from './knowledge';
import {
  SARIM_CERTIFICATIONS, SARIM_CERTIFICATIONS_SOURCE, SARIM_IDENTITY, SARIM_NUMBERS, SARIM_NUMBERS_SOURCE, SARIM_SERVED_SOURCE,
} from './organization';
import {
  SARIM_AGENTS, SARIM_AGENTS_TEAM, SARIM_AREA_LABEL, SARIM_DEFAULT_PERSONA, SARIM_PERMISSIONS, SARIM_PERSONAS, SARIM_ROLES, SARIM_TEAMS,
} from './people';
import { SARIM_PROGRAMS } from './programs';
import { SARIM_STEP_DATA } from './step-data';
import { SARIM_WORDS } from './words';

export const SARIM_WORLD: OrgWorld = {
  key: 'sarim',
  name: 'SARIM',
  shortName: 'SARIM',
  monogram: 'SA',
  color: '#b45309',
  words: SARIM_WORDS,

  stages: SARIM_STAGES,
  cards: SARIM_CARDS,
  opsFlows: SARIM_OPS_FLOWS,
  contracts: SARIM_CONTRACTS,
  towns: SARIM_TOWNS,
  programs: SARIM_PROGRAMS,
  stepData: SARIM_STEP_DATA,
  knowledge: {
    collections: SARIM_KNOWLEDGE_COLLECTIONS,
    docs: SARIM_KNOWLEDGE_DOCS,
    questions: SARIM_KNOWLEDGE_QUESTIONS,
    updated: {
      'dlgs-152-2006': '2026-01-01',
      'dm-59-2023': '2023-06-15',
      'dlgs-36-2023': '2024-12-31',
      'arera-titr': '2023-12-31',
      'arera-tqrif': '2025-12-31',
      'ccnl-servizi-ambientali': '2024-07-10',
      'carta-qualita-agropoli': '2024-11-30',
      certificazioni: '2026-11-01',
      'albo-gestori': '2026-06-29',
      'portale-arera': '2026-11-06',
    },
  },
  organization: {
    identity: SARIM_IDENTITY,
    certifications: SARIM_CERTIFICATIONS,
    certificationsSource: SARIM_CERTIFICATIONS_SOURCE,
    numbers: SARIM_NUMBERS,
    numbersSource: SARIM_NUMBERS_SOURCE,
    servedSource: SARIM_SERVED_SOURCE,
    clientTown: 'roma',
  },
  people: {
    areaLabel: SARIM_AREA_LABEL,
    permissions: SARIM_PERMISSIONS,
    roles: SARIM_ROLES,
    personas: SARIM_PERSONAS,
    teams: SARIM_TEAMS,
    agentsTeam: SARIM_AGENTS_TEAM,
    defaultPersona: SARIM_DEFAULT_PERSONA,
    agents: SARIM_AGENTS,
    managerRole: 'sarim-direzione',
    viewerRole: 'sarim-lettura',
    managerTeam: 'direzione', // allow-italian: team id, compared by value
    viewerTeam: 'sindaci', // allow-italian: team id, compared by value
    directorId: 'sarim-dg',
    legalLeadId: 'sarim-bruno',
    contractsAgentId: 'ag-contratti',
  },

  flowRoles: { variants: 'sarim-varianti', reports: 'sarim-segnalazioni', tender: 'sarim-gara' },
  flowIcons: {
    'sarim-segnalazioni': 'headset',
    'sarim-foglie': 'leaf',
    'sarim-fir': 'truck',
    'sarim-fatture': 'receipt',
    'sarim-gara': 'gavel',
    'sarim-scadenze': 'calendar-clock',
    'sarim-turni': 'clock',
    'sarim-varianti': 'file-pen',
  },
  programRoles: { send: ['posta'], registry: ['rentri'], writes: ['sap', 'enviro', 'winwaste', 'zucchetti', 'excel', 'word'] },
  flowSplits: SARIM_SPLITS,
  dataTables: [
    { id: 'segnalazioni', flows: ['sarim-segnalazioni', 'sarim-foglie'] }, // allow-italian: address segment and flow ids, compared by value
    { id: 'fir', flows: ['sarim-fir'] }, // allow-italian: address segment and flow id, compared by value
    { id: 'fatture', flows: ['sarim-fatture'] }, // allow-italian: address segment and flow id, compared by value
    { id: 'gare', flows: ['sarim-gara'] }, // allow-italian: address segment and flow id, compared by value
    { id: 'personale', flows: ['sarim-scadenze', 'sarim-turni'] }, // allow-italian: address segment and flow ids, compared by value
    { id: 'varianti', flows: ['sarim-varianti'] }, // allow-italian: address segment and flow id, compared by value
  ],
  dataViews: [
    { id: 'stuckReports', table: 'segnalazioni', stopped: true }, // allow-italian: address segment, compared by value
    { id: 'formsToCheck', table: 'fir', stage: 'verifica' }, // allow-italian: address segment and stage id, compared by value
    { id: 'invoicesToCheck', table: 'fatture', stage: 'verifica' }, // allow-italian: address segment and stage id, compared by value
    { id: 'staffDue', table: 'personale', dueWithin: 30 }, // allow-italian: address segment, compared by value
  ],
  contractFamily: [
    { child: 'c-sub-lavaggio', parent: 'c-castellabate', relation: 'subcontract', clause: 'art-11' },
    { child: 'c-accordo-castellabate', parent: 'c-castellabate', relation: 'agreement', clause: 'art-12' },
    { child: 'c-td-castellabate', parent: 'c-castellabate', relation: 'staff', clause: 'art-12' },
  ],
  legacyGroupFlows: {
    segnalazioni: 'sarim-segnalazioni', // allow-italian: old address segment, compared by value
    fir: 'sarim-fir', // allow-italian: old address segment, compared by value
    fatture: 'sarim-fatture', // allow-italian: old address segment, compared by value
    gare: 'sarim-gara', // allow-italian: old address segment, compared by value
    personale: 'sarim-scadenze', // allow-italian: old address segment, compared by value
    contratti: 'sarim-varianti', // allow-italian: old address segment, compared by value
  },
  samples: {
    cards: ['SG-4128', 'FT-2609', 'CT-V07', 'FIR-0931'],
    cardOriginals: [['SG-4129', 'mail'], ['CT-V07', 'variante']], // allow-italian: original ids, compared by value
    persons: ['sarim-bruno', 'ag-contratti', 'sarim-callcenter', 'ag-segnalazioni'],
    flows: ['sarim-segnalazioni', 'sarim-varianti', 'sarim-fatture'],
    flowSteps: [['sarim-segnalazioni', 's3'], ['sarim-varianti', 's6']],
    programs: ['sap', 'enviro', 'zucchetti', 'excel'],
    contracts: ['c-castellabate', 'c-carburante', 'c-vallo', 'c-accordo-turni'],
    clauses: [['c-castellabate', 'art-9'], ['c-carburante', 'art-5']],
    contractObligations: ['c-castellabate', 'c-smart-leaf'],
    contractComments: ['c-castellabate'],
    contractVersions: ['c-castellabate', 'c-accordo-turni'],
    contractAttachments: ['c-castellabate'],
    contractLinks: ['c-castellabate'],
    signatures: ['c-castellabate', 'c-accordo-turni'],
    compares: [['c-castellabate', 2, 3], ['c-carburante', 1, 2], ['c-accordo-turni', 1, 2]],
    attachments: [['c-castellabate', 'at-cast-v2'], ['c-castellabate', 'at-cast-variante'], ['c-carburante', 'at-car-v2']],
    rules: ['dlgs-36-2023', 'arera-tqrif', 'proc-segnalazioni'],
    ruleParts: [['dlgs-36-2023', 'art-120-c3'], ['proc-fir', 's4']],
    ruleVersions: ['dlgs-36-2023', 'proc-fir'],
    ruleUsage: ['dlgs-36-2023'],
    documents: ['carta-qualita-agropoli', 'certificazioni'],
    documentVersions: ['carta-qualita-agropoli'],
    documentUsage: ['carta-qualita-agropoli'],
    dataTables: ['segnalazioni', 'contratti', 'comuni', 'fatture'], // allow-italian: address segments, not shown
    dataBoards: ['segnalazioni', 'contratti'], // allow-italian: address segments, not shown
    dataCharts: ['segnalazioni', 'contratti'], // allow-italian: address segments, not shown
    dataRows: [['segnalazioni', 'SG-4131'], ['contratti', 'c-castellabate'], ['comuni', 'castellabate'], ['fir', 'FIR-0936']], // allow-italian: address segments, not shown
  },
};

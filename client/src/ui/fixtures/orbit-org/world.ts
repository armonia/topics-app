/**
 * ORBIT as a world: the data of this folder assembled in the shape the screens
 * of `client/src/ui-gallery/orbit/` read (`../world-types.ts`), plus the words,
 * ids and samples that used to be written in those screens. Nothing here
 * changes a datum; it only gives each one its place.
 */
import type { OrgWorld } from '../world-types';
import { ORBIT_CARDS, ORBIT_STAGES } from './cards';
import { ORBIT_CONTRACTS } from './contracts';
import { ORBIT_TOWNS } from './data';
import { ORBIT_OPS_FLOWS, ORBIT_SPLITS } from './flows';
import { ORBIT_KNOWLEDGE_COLLECTIONS, ORBIT_KNOWLEDGE_DOCS, ORBIT_KNOWLEDGE_QUESTIONS } from './knowledge';
import {
  ORBIT_CERTIFICATIONS, ORBIT_CERTIFICATIONS_SOURCE, ORBIT_IDENTITY, ORBIT_NUMBERS, ORBIT_NUMBERS_SOURCE, ORBIT_SERVED_SOURCE,
} from './organization';
import {
  ORBIT_AGENTS, ORBIT_AGENTS_TEAM, ORBIT_AREA_LABEL, ORBIT_DEFAULT_PERSONA, ORBIT_PERMISSIONS, ORBIT_PERSONAS, ORBIT_ROLES, ORBIT_TEAMS,
} from './people';
import { ORBIT_PROGRAMS } from './programs';
import { ORBIT_STEP_DATA } from './step-data';
import { ORBIT_WORDS } from './words';

export const ORBIT_WORLD: OrgWorld = {
  key: 'orbit',
  name: 'ORBIT',
  shortName: 'ORBIT',
  monogram: 'SA',
  color: '#b45309',
  words: ORBIT_WORDS,

  stages: ORBIT_STAGES,
  cards: ORBIT_CARDS,
  opsFlows: ORBIT_OPS_FLOWS,
  contracts: ORBIT_CONTRACTS,
  towns: ORBIT_TOWNS,
  programs: ORBIT_PROGRAMS,
  stepData: ORBIT_STEP_DATA,
  knowledge: {
    collections: ORBIT_KNOWLEDGE_COLLECTIONS,
    docs: ORBIT_KNOWLEDGE_DOCS,
    questions: ORBIT_KNOWLEDGE_QUESTIONS,
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
    identity: ORBIT_IDENTITY,
    certifications: ORBIT_CERTIFICATIONS,
    certificationsSource: ORBIT_CERTIFICATIONS_SOURCE,
    numbers: ORBIT_NUMBERS,
    numbersSource: ORBIT_NUMBERS_SOURCE,
    servedSource: ORBIT_SERVED_SOURCE,
    clientTown: 'roma',
  },
  people: {
    areaLabel: ORBIT_AREA_LABEL,
    permissions: ORBIT_PERMISSIONS,
    roles: ORBIT_ROLES,
    personas: ORBIT_PERSONAS,
    teams: ORBIT_TEAMS,
    agentsTeam: ORBIT_AGENTS_TEAM,
    defaultPersona: ORBIT_DEFAULT_PERSONA,
    agents: ORBIT_AGENTS,
    managerRole: 'orbit-direzione',
    viewerRole: 'orbit-lettura',
    managerTeam: 'direzione', // allow-italian: team id, compared by value
    viewerTeam: 'sindaci', // allow-italian: team id, compared by value
    directorId: 'orbit-dg',
    legalLeadId: 'orbit-bruno',
    contractsAgentId: 'ag-contratti',
  },

  flowRoles: { variants: 'orbit-varianti', reports: 'orbit-segnalazioni', tender: 'orbit-gara' },
  flowIcons: {
    'orbit-segnalazioni': 'headset',
    'orbit-foglie': 'leaf',
    'orbit-fir': 'truck',
    'orbit-fatture': 'receipt',
    'orbit-gara': 'gavel',
    'orbit-scadenze': 'calendar-clock',
    'orbit-turni': 'clock',
    'orbit-varianti': 'file-pen',
  },
  programRoles: { send: ['posta'], registry: ['rentri'], writes: ['sap', 'enviro', 'winwaste', 'zucchetti', 'excel', 'word'] },
  flowSplits: ORBIT_SPLITS,
  dataTables: [
    { id: 'segnalazioni', flows: ['orbit-segnalazioni', 'orbit-foglie'] }, // allow-italian: address segment and flow ids, compared by value
    { id: 'fir', flows: ['orbit-fir'] }, // allow-italian: address segment and flow id, compared by value
    { id: 'fatture', flows: ['orbit-fatture'] }, // allow-italian: address segment and flow id, compared by value
    { id: 'gare', flows: ['orbit-gara'] }, // allow-italian: address segment and flow id, compared by value
    { id: 'personale', flows: ['orbit-scadenze', 'orbit-turni'] }, // allow-italian: address segment and flow ids, compared by value
    { id: 'varianti', flows: ['orbit-varianti'] }, // allow-italian: address segment and flow id, compared by value
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
    segnalazioni: 'orbit-segnalazioni', // allow-italian: old address segment, compared by value
    fir: 'orbit-fir', // allow-italian: old address segment, compared by value
    fatture: 'orbit-fatture', // allow-italian: old address segment, compared by value
    gare: 'orbit-gara', // allow-italian: old address segment, compared by value
    personale: 'orbit-scadenze', // allow-italian: old address segment, compared by value
    contratti: 'orbit-varianti', // allow-italian: old address segment, compared by value
  },
  samples: {
    cards: ['SG-4128', 'FT-2609', 'CT-V07', 'FIR-0931'],
    cardOriginals: [['SG-4129', 'mail'], ['CT-V07', 'variante']], // allow-italian: original ids, compared by value
    persons: ['orbit-bruno', 'ag-contratti', 'orbit-callcenter', 'ag-segnalazioni'],
    flows: ['orbit-segnalazioni', 'orbit-varianti', 'orbit-fatture'],
    flowSteps: [['orbit-segnalazioni', 's3'], ['orbit-varianti', 's6']],
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

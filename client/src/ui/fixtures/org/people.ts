/**
 * Who uses the preview, and what each of them may see and do. People are
 * roles, never invented names: the only real person is the Armonia operator
 * (Attilio, who runs the preview). The selector at the foot of the sidebar
 * switches between them, and the container hides surfaces and disables
 * actions from these tables, so permissions are something you can try.
 */
import type { OrgKey, Office } from './types';

/** What a surface or an action needs. `view:*` decides what is in the sidebar. */
export type Permission =
  | 'view:today' | 'view:inbox' | 'view:flows' | 'view:data' | 'view:knowledge' | 'view:views'
  | 'view:channels' | 'view:programs' | 'view:overview' | 'view:settings' | 'view:board'
  | 'view:callcenter'
  /** The SARIM edition: contracts and the team page have their own surface. */
  | 'view:contracts' | 'view:team'
  /** Write a contract: a new version, a comment on a clause, a variation. */
  | 'edit:contracts'
  /** Approve a version or a variation of a contract before it is signed. */
  | 'approve:contracts'
  /** Sign a contract for the company (the legal representative). */
  | 'sign:contracts'
  /** Confirm, correct, write drafts, send: work on cases. */
  | 'edit:data'
  /** Change flows, fields, views, channels: the structure. */
  | 'edit:structure'
  /** Approve a procedure or a version of a flow. */
  | 'approve'
  /** Run tests of flows. */
  | 'run:tests'
  /** People, roles, sharing, security settings. */
  | 'admin'
  | 'export';

export const ALL_PERMISSIONS: Permission[] = [
  'view:today', 'view:inbox', 'view:flows', 'view:data', 'view:knowledge', 'view:views',
  'view:channels', 'view:programs', 'view:overview', 'view:settings', 'view:board', 'view:callcenter',
  'edit:data', 'edit:structure', 'approve', 'run:tests', 'admin', 'export',
];

export interface RoleDef {
  id: string;
  label: string;
  /** One line: what this role is for. */
  description: string;
  permissions: Permission[];
}

export interface Persona {
  id: string;
  /** How the persona is named everywhere: a role, marked as an example. */
  name: string;
  monogram: string;
  color: string;
  role: string;
  orgs: OrgKey[];
  /** The offices whose queue this persona works; empty = every office. */
  offices: Office[];
  /** The place the app opens on for this persona. */
  home: string;
  example: boolean;
}

export const ROLES: RoleDef[] = [
  {
    id: 'operatore', label: 'Operatore Armonia', // allow-italian: fixture data, shown as written
    description: 'Configura e collauda flussi, dati e programmi per i clienti.', // allow-italian: fixture data, shown as written
    permissions: ALL_PERMISSIONS,
  },
  {
    id: 'direzione', label: 'Direzione', // allow-italian: fixture data, shown as written
    description: 'Vede tutto, approva procedure e versioni, non cambia la struttura.', // allow-italian: fixture data, shown as written
    permissions: [
      'view:today', 'view:inbox', 'view:flows', 'view:data', 'view:knowledge', 'view:views', 'view:channels',
      'view:programs', 'view:overview', 'view:settings', 'view:board', 'edit:data', 'approve', 'export',
    ],
  },
  {
    id: 'legale', label: 'Ufficio legale', // allow-italian: fixture data, shown as written
    description: 'Lavora ricorsi e accessi agli atti, scrive e deposita.', // allow-italian: fixture data, shown as written
    permissions: ['view:today', 'view:inbox', 'view:data', 'view:knowledge', 'view:views', 'view:board', 'edit:data'],
  },
  {
    id: 'protocollo', label: 'Protocollo', // allow-italian: fixture data, shown as written
    description: 'Conferma cosa arriva e lo smista agli uffici.', // allow-italian: fixture data, shown as written
    permissions: ['view:today', 'view:inbox', 'view:data', 'view:knowledge', 'edit:data'],
  },
  {
    id: 'lettura', label: 'Sola lettura', // allow-italian: fixture data, shown as written
    description: 'Vede numeri, dati e documenti; non cambia niente.', // allow-italian: fixture data, shown as written
    permissions: ['view:overview', 'view:data', 'view:knowledge', 'view:views', 'view:board'],
  },
  {
    id: 'call-center', label: 'Call center', // allow-italian: fixture data, shown as written
    description: 'Riceve chiamate e segnalazioni, apre e segue i ticket.', // allow-italian: fixture data, shown as written
    permissions: ['view:today', 'view:inbox', 'view:callcenter', 'view:flows', 'view:data', 'view:knowledge', 'edit:data'],
  },
];

export const PERSONAS: Persona[] = [
  { id: 'attilio', name: 'Attilio', monogram: 'A', color: '#1f2937', role: 'operatore', orgs: ['nocera', 'sarim', 'armonia', 'euro'], offices: [], home: '/panoramica', example: false },
  { id: 'direzione', name: 'Direttore generale (esempio)', monogram: 'DG', color: '#0f766e', role: 'direzione', orgs: ['nocera'], offices: [], home: '/panoramica', example: true }, // allow-italian: fixture data, shown as written
  { id: 'legale', name: 'Avvocato dell\'ente (esempio)', monogram: 'AV', color: '#7c3aed', role: 'legale', orgs: ['nocera'], offices: ['legale'], home: '/oggi', example: true }, // allow-italian: fixture data, shown as written
  { id: 'protocollo', name: 'Operatore del protocollo (esempio)', monogram: 'OP', color: '#15803d', role: 'protocollo', orgs: ['nocera'], offices: ['protocollo'], home: '/da-fare', example: true }, // allow-italian: fixture data, shown as written
  { id: 'lettura', name: 'Revisore dei conti (esempio)', monogram: 'RC', color: '#64748b', role: 'lettura', orgs: ['nocera'], offices: [], home: '/panoramica', example: true }, // allow-italian: fixture data, shown as written
  { id: 'sarim-cc', name: 'Operatrice call center SARIM (esempio)', monogram: 'CC', color: '#b45309', role: 'call-center', orgs: ['sarim'], offices: ['call-center'], home: '/sarim/call-center', example: true }, // allow-italian: fixture data, shown as written
];

export const DEFAULT_PERSONA = 'attilio';

export const OFFICE_LABEL: Record<Office, string> = {
  protocollo: 'Protocollo', // allow-italian: fixture data, shown as written
  legale: 'Legale',
  catasto: 'Catasto e ruoli', // allow-italian: fixture data, shown as written
  tecnico: 'Tecnico', // allow-italian: fixture data, shown as written
  manutenzione: 'Manutenzione', // allow-italian: fixture data, shown as written
  ragioneria: 'Ragioneria', // allow-italian: fixture data, shown as written
  segreteria: 'Segreteria', // allow-italian: fixture data, shown as written
  irrigazione: 'Irrigazione', // allow-italian: fixture data, shown as written
  direzione: 'Direzione', // allow-italian: fixture data, shown as written
  'call-center': 'Call center',
  amministrazione: 'Amministrazione', // allow-italian: fixture data, shown as written
  servizi: 'Servizi sul territorio', // allow-italian: fixture data, shown as written
};

/** The organizations, as the sidebar groups them (they add up, there is no switcher). */
export const ORGS: Array<{ id: OrgKey; name: string; monogram: string; color: string }> = [
  { id: 'nocera', name: 'Consorzio di Nocera', monogram: 'CN', color: '#15803d' },
  { id: 'sarim', name: 'SARIM', monogram: 'SA', color: '#b45309' },
  { id: 'armonia', name: 'Armonia', monogram: 'A', color: '#1f2937' },
  { id: 'euro', name: 'Euro Impianti', monogram: 'EI', color: '#c53030' },
];

/**
 * The shape of an organization's example world, as the screens of
 * `client/src/ui-gallery/sarim/` read it: the work on «Da fare» (stages, cards, allow-italian: quotes the words on screen
 * flows), contracts, towns, knowledge, programs and people, and the words and
 * ids that belong to that organization and not to the screens. SARIM fills it
 * (`sarim-org/world.ts`), another organization does the same
 * (`nocera-org/`), and the gallery picks one with `setWorld()`.
 *
 * Types only. The entity types still live next to the SARIM data they were
 * written for (`sarim-org/*`); they carry no SARIM fact.
 */
import type { FlowPathModel } from '../flows/model';
import type { OrgWords } from '../copy/org-words';
import type { OrgKey } from './org/types';
import type { Permission, RoleDef } from './org/people';
import type { Contract, OpsFlow, SarimCard, Stage, StageId } from './sarim-org/types';
import type { SarimTown } from './sarim-org/data';
import type { KnowledgeCollectionDef, KnowledgeDoc, KnowledgeQuestion } from './sarim-org/knowledge';
import type { SarimCertification, SarimFact, SourceLink } from './sarim-org/organization';
import type { SarimAgent, SarimPersona, SarimTeam } from './sarim-org/people';
import type { SarimProgram } from './sarim-org/programs';
import type { StepData } from './sarim-org/step-data';

/** The icons a flow can wear; the gallery maps each name to a drawing. */
export type FlowIconName =
  | 'headset' | 'leaf' | 'truck' | 'receipt' | 'gavel' | 'calendar-clock' | 'clock' | 'file-pen'
  | 'workflow' | 'users' | 'landmark' | 'file-text' | 'wallet' | 'map' | 'droplets' | 'wrench';

/** A table of «Dati» that lists the cards of some flows; `contratti` and `comuni` are always there, after these. */
export interface DataTableDef {
  /** Address segment: `/dati/<id>`. The words of the table are `words.<lang>.tables[id]`. */
  id: string;
  /** The flows whose cards it lists; the first is the main one. */
  flows: string[];
}

/** A saved filter that ships with a table of cards: its name is `words.<lang>.views[id]`. */
export interface DataViewDef {
  id: string;
  /** The table it filters: one of `dataTables`. */
  table: string;
  /** Keeps the cards in this stage. */
  stage?: StageId;
  /** Keeps the stopped cards. */
  stopped?: boolean;
  /** Keeps the cards due within this many days. */
  dueWithin?: number;
}

/** Which contract hangs from which, and how. */
export interface ContractFamilyLink {
  child: string;
  parent: string;
  relation: 'subcontract' | 'staff' | 'agreement';
  clause?: string;
}

/** One case of a split: the path as the fixture of the flow writes it, and where it hands over. */
export interface FlowSplitLane extends FlowPathModel {
  /** The step of the lane a case at the split's step stands at; the first one when absent. */
  at?: string;
  /** The case goes on in another flow as well: «avvia «Fattura passiva»». (allow-italian: quotes the Italian interface) */
  handoff?: string;
}

/**
 * Where a flow splits into cases side by side: one step of the flow (`step`)
 * is done in a different way for each case, and the cases meet again at the
 * next step. The lanes take the place of that step in the drawing; cards keep
 * standing at the step itself, and `lane` on a card says which case it is.
 */
export interface FlowSplitDef {
  flow: string;
  step: string;
  /** What decides the case, in plain words: «tipo di segnalazione». (allow-italian: quotes the Italian interface) */
  by: string;
  /** The agent of that flow, named on the lane steps an agent does. */
  agent: string;
  lanes: FlowSplitLane[];
}

/** The entities the route definitions list as samples for the crawler and the walk: ids of this world. */
export interface WorldSamples {
  cards: string[];
  /** `[card id, original id]`. */
  cardOriginals: Array<[string, string]>;
  persons: string[];
  flows: string[];
  /** `[flow id, step id]`. */
  flowSteps: Array<[string, string]>;
  programs: string[];
  contracts: string[];
  /** `[contract id, clause id]`. */
  clauses: Array<[string, string]>;
  /** Contracts for the tabs of a contract. */
  contractObligations: string[];
  contractComments: string[];
  contractVersions: string[];
  contractAttachments: string[];
  contractLinks: string[];
  signatures: string[];
  /** `[contract id, from version, to version]`. */
  compares: Array<[string, number, number]>;
  /** `[contract id, attachment id]`. */
  attachments: Array<[string, string]>;
  /** Documents of the `norme` collection (the rules), and of the `azienda` collection (the documents). */
  rules: string[];
  /** `[document id, part id]` of a rule. */
  ruleParts: Array<[string, string]>;
  ruleVersions: string[];
  ruleUsage: string[];
  documents: string[];
  documentVersions: string[];
  documentUsage: string[];
  /** Tables of «Dati» to open as a table, as a board, as a chart. */
  dataTables: string[];
  dataBoards: string[];
  dataCharts: string[];
  /** `[table id, row id]`. */
  dataRows: Array<[string, string]>;
}

export interface OrgPeopleWorld {
  /** The label of every area (a team of the questionnaire), by area id. */
  areaLabel: Record<string, string>;
  permissions: Permission[];
  roles: RoleDef[];
  personas: SarimPersona[];
  teams: SarimTeam[];
  /** The team the agents form: no leader, no permissions to give. */
  agentsTeam: { id: string; label: string };
  defaultPersona: string;
  agents: SarimAgent[];
  /** The role that sees and manages everything, and the one that sees everything and changes nothing. */
  managerRole: string;
  viewerRole: string;
  /** The team of the people with the manager role, and the team of those with the viewer role. */
  managerTeam: string;
  viewerTeam: string;
  /** The person who approves and signs (the manager), and the one who counter-signs (legal). */
  directorId: string;
  legalLeadId: string;
  /** The agent that prepares the contracts and their variants. */
  contractsAgentId: string;
}

export interface OrgKnowledgeWorld {
  collections: KnowledgeCollectionDef[];
  docs: KnowledgeDoc[];
  questions: KnowledgeQuestion[];
  /** When each fixed document was last updated (`YYYY-MM-DD`); a procedure carries its own dates. */
  updated: Record<string, string>;
}

export interface OrgFactsWorld {
  identity: SarimFact[];
  certifications: SarimCertification[];
  certificationsSource: SourceLink;
  numbers: Array<{ id: string; label: string; value: string }>;
  numbersSource: SourceLink;
  servedSource: SourceLink;
  /** The town whose client is another body (its row is left out of the count of towns served), when there is one. */
  clientTown?: string;
}

export interface OrgWorld {
  /** The key the container, the routes and the sidebar know the organization by. */
  key: OrgKey;
  name: string;
  shortName: string;
  monogram: string;
  color: string;
  /** The words and phrases of the copy that name this organization. */
  words: OrgWords;

  stages: Stage[];
  cards: SarimCard[];
  opsFlows: OpsFlow[];
  contracts: Contract[];
  towns: SarimTown[];
  programs: SarimProgram[];
  /** What each step reads and produces, by flow id and step id. */
  stepData: Record<string, Record<string, StepData>>;
  knowledge: OrgKnowledgeWorld;
  organization: OrgFactsWorld;
  people: OrgPeopleWorld;

  /** The flow that carries the variations of contracts, the flow of the reports, the flow of the tenders (when the organization has them). */
  flowRoles: { variants: string; reports?: string; tender?: string };
  flowIcons: Record<string, FlowIconName>;
  /** The programs (ids) through which the organization sends outside, files its register, and writes. */
  programRoles: { send: string[]; registry: string[]; writes: string[] };
  /** The flows that split into cases side by side (none for a world without). */
  flowSplits: FlowSplitDef[];
  dataTables: DataTableDef[];
  /** The saved filters that come with the tables of cards. */
  dataViews: DataViewDef[];
  contractFamily: ContractFamilyLink[];
  /** The old groups of the list of cards and the main flow each stood for; `{}` for an organization that never had them. */
  legacyGroupFlows: Record<string, string>;
  samples: WorldSamples;
}


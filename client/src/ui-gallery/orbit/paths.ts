/**
 * Every address of the ORBIT edition (`orbit.html`), in one place: its areas
 * link to each other only through these builders. ORBIT is the only
 * organization here, so nothing has a prefix; slugs are Italian because the
 * address is read by the people who share it. The old addresses (`/oggi`,
 * `/contratti/…`, `/dati/…`, `/da-fare/<group>/…`) are answered by (allow-italian: quotes the Italian interface)
 * `redirects.ts`, not built here.
 */
import { knowledgeDocById } from './world';

const e = encodeURIComponent;

/** The pages of a document besides its text: its versions, and where it is used. */
export type DocPage = 'versions' | 'usage';
const DOC_PAGE: Record<DocPage, string> = { versions: 'versioni', usage: 'dove-si-usa' }; // allow-italian: address segments, not shown

export const SP = {
  home: () => '/da-fare',
  newTab: () => '/nuova', // allow-italian: address segment, not shown
  search: (q: string) => `/cerca/${e(q)}`, // allow-italian: address segment, not shown

  /* «Da fare»: the list (first), the kanban, the cards per stage, one card and one of its originals. Which flow or stage is on show is a filter, not an address. (allow-italian: quotes the Italian interface) */
  inbox: () => '/da-fare', // allow-italian: address segment, not shown
  inboxKanban: () => '/da-fare/kanban', // allow-italian: address segment, not shown
  inboxStages: () => '/da-fare/per-stato', // allow-italian: address segment, not shown
  card: (card: string) => `/da-fare/card/${e(card)}`, // allow-italian: address segment, not shown
  cardOriginal: (card: string, doc: string) => `/da-fare/card/${e(card)}/originale/${e(doc)}`, // allow-italian: address segment, not shown
  /** The flow of a card read beside it: the card stays on show. */
  cardFlow: (card: string) => `/da-fare/card/${e(card)}/flusso`, // allow-italian: address segment, not shown

  /* The chat with the AI: every chat, a new one, one conversation. */
  chats: () => '/chat',
  chatNew: () => '/chat/nuova', // allow-italian: address segment, not shown
  chat: (id: string) => `/chat/${e(id)}`,

  flows: () => '/flussi',
  flow: (flow: string) => `/flussi/${e(flow)}`,
  flowStep: (flow: string, step: string) => `/flussi/${e(flow)}/passo/${e(step)}`,

  /* «Conoscenza»: documents, contracts, data and rules sit under one address. (allow-italian: quotes the Italian interface) */
  knowledge: () => '/conoscenza/documenti', // allow-italian: address segment, not shown
  documents: () => '/conoscenza/documenti', // allow-italian: address segment, not shown
  document: (doc: string, part?: string) => (part ? `/conoscenza/documenti/${e(doc)}/${e(part)}` : `/conoscenza/documenti/${e(doc)}`), // allow-italian: address segment, not shown
  rules: () => '/conoscenza/regole', // allow-italian: address segment, not shown
  rule: (doc: string, part?: string) => (part ? `/conoscenza/regole/${e(doc)}/${e(part)}` : `/conoscenza/regole/${e(doc)}`), // allow-italian: address segment, not shown
  /** The versions or the uses of a document (`/conoscenza/documenti/:doc/versioni`), or of a rule. */
  documentPage: (doc: string, page: DocPage) => `/conoscenza/documenti/${e(doc)}/${DOC_PAGE[page]}`, // allow-italian: address segment, not shown
  rulePage: (doc: string, page: DocPage) => `/conoscenza/regole/${e(doc)}/${DOC_PAGE[page]}`, // allow-italian: address segment, not shown
  knowledgeDocPage: (doc: string, page: DocPage) => (knowledgeDocById(doc)?.collection === 'azienda' ? SP.documentPage(doc, page) : SP.rulePage(doc, page)), // allow-italian: collection id, compared by value
  /** A document or a rule by the collection it belongs to: the papers of the company are documents, laws and procedures are rules. */
  knowledgeDoc: (doc: string, part?: string) => (knowledgeDocById(doc)?.collection === 'azienda' ? SP.document(doc, part) : SP.rule(doc, part)), // allow-italian: collection id, compared by value

  /* Contracts: the list, the deadlines of all of them, one contract, a clause, versions, a compare, an attachment, signatures. */
  contracts: () => '/conoscenza/contratti', // allow-italian: address segment, not shown
  contractDeadlines: () => '/conoscenza/contratti/scadenze', // allow-italian: address segment, not shown
  contractDeadlinesMonth: () => '/conoscenza/contratti/scadenze/mese', // allow-italian: address segment, not shown
  contract: (id: string) => `/conoscenza/contratti/${e(id)}`, // allow-italian: address segment, not shown
  clause: (id: string, clause: string) => `/conoscenza/contratti/${e(id)}/clausola/${e(clause)}`, // allow-italian: address segment, not shown
  contractObligations: (id: string) => `/conoscenza/contratti/${e(id)}/obblighi`, // allow-italian: address segment, not shown
  contractComments: (id: string) => `/conoscenza/contratti/${e(id)}/commenti`, // allow-italian: address segment, not shown
  contractAttachments: (id: string) => `/conoscenza/contratti/${e(id)}/allegati`, // allow-italian: address segment, not shown
  contractLinks: (id: string) => `/conoscenza/contratti/${e(id)}/collegamenti`, // allow-italian: address segment, not shown
  versions: (id: string) => `/conoscenza/contratti/${e(id)}/versioni`, // allow-italian: address segment, not shown
  compare: (id: string, from: number, to: number) => `/conoscenza/contratti/${e(id)}/confronto/${from}/${to}`, // allow-italian: address segment, not shown
  attachment: (id: string, doc: string) => `/conoscenza/contratti/${e(id)}/allegati/${e(doc)}`, // allow-italian: address segment, not shown
  signatures: (id: string) => `/conoscenza/contratti/${e(id)}/firme`, // allow-italian: address segment, not shown

  data: (table?: string) => (table ? `/conoscenza/dati/${e(table)}` : '/conoscenza/dati'), // allow-italian: address segment, not shown
  /** One table as a board or a chart (the table itself is `data(table)`). */
  dataView: (table: string, view: 'board' | 'chart') => `/conoscenza/dati/${e(table)}/${view === 'board' ? 'bacheca' : 'grafico'}`, // allow-italian: address segments, not shown
  dataRow: (table: string, row: string) => `/conoscenza/dati/${e(table)}/${e(row)}`, // allow-italian: address segment, not shown
  deadlines: () => '/conoscenza/dati/scadenzario', // allow-italian: address segment, not shown
  deadlinesMonth: () => '/conoscenza/dati/scadenzario/mese', // allow-italian: address segment, not shown

  programs: () => '/programmi',
  program: (id: string) => `/programmi/${e(id)}`,

  /* The team: the teams, one team, the permissions, one person. */
  team: () => '/squadra', // allow-italian: address segment, not shown
  teamOf: (team: string) => `/squadra/team/${e(team)}`, // allow-italian: address segment, not shown
  teamPermissions: () => '/squadra/permessi', // allow-italian: address segment, not shown
  person: (id: string) => `/squadra/${e(id)}`, // allow-italian: address segment, not shown

  /* Settings of the organization (`organizzazione`, `agenti`, `registro`) and preferences of the person (`aspetto`, `notifiche`). */
  settings: (section = 'organizzazione') => `/impostazioni/${e(section)}`, // allow-italian: address segment, not shown
  prefs: (section = 'aspetto') => `/preferenze/${e(section)}`, // allow-italian: address segment, not shown
  signedOut: () => '/uscito', // allow-italian: address segment, not shown
} as const;

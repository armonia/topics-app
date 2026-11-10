/**
 * Every address of the preview, in one place: areas link to each other only
 * through these builders, so a link and the place it opens cannot drift
 * apart. Slugs are Italian because the address is read by the people who
 * share it. The Consorzio di Nocera is the organization without a prefix;
 * the others live under their own (`/sarim/...`).
 */
const e = encodeURIComponent;

export const P = {
  home: () => '/panoramica',
  newTab: () => '/nuova', // allow-italian: address segment, not shown
  search: (q: string) => `/cerca/${e(q)}`, // allow-italian: address segment, not shown

  /* Where people work (x05, n12, v02, x06, v01, w05). */
  today: () => '/oggi',
  inbox: (item?: string) => (item ? `/da-fare/${e(item)}` : '/da-fare'),
  inboxOrigin: (item: string, field: string) => `/da-fare/${e(item)}/origine/${e(field)}`,
  record: (id: string) => `/pratiche/${e(id)}`,
  recordDoc: (id: string, doc: string) => `/pratiche/${e(id)}/documenti/${e(doc)}`,
  recordOrigin: (id: string, field: string) => `/pratiche/${e(id)}/origine/${e(field)}`,
  recordSheet: (id: string) => `/pratiche/${e(id)}/scheda`, // allow-italian: address segment, not shown

  /* Flows (n01, n02, n03, w01, w02, w03, n05, n06, n07, n09, n10, n11, c01, c02, g03). */
  flows: () => '/flussi',
  flowNew: () => '/flussi/nuovo', // allow-italian: address segment, not shown
  flow: (flow: string) => `/flussi/${e(flow)}`,
  flowStep: (flow: string, step: string) => `/flussi/${e(flow)}/passo/${e(step)}`,
  flowOffices: (flow: string) => `/flussi/${e(flow)}/uffici`,
  flowRuns: (flow: string) => `/flussi/${e(flow)}/esecuzioni`,
  flowRun: (flow: string, run: string) => `/flussi/${e(flow)}/esecuzioni/${e(run)}`,
  flowVersions: (flow: string) => `/flussi/${e(flow)}/versioni`,
  flowTest: (flow: string) => `/flussi/${e(flow)}/collaudo`,
  flowDecides: (flow: string) => `/flussi/${e(flow)}/come-decide`,
  testAll: () => '/collaudo',
  chat: (id: string) => `/chat/${e(id)}`,

  /* Data (x01, x02, w04, n14, q01, q02). */
  data: (table?: string) => (table ? `/dati/${e(table)}` : '/dati'),
  dataView: (view: string) => `/dati/vista/${e(view)}`,
  dataFields: (table: string) => `/dati/${e(table)}/campi`,
  dataSchema: () => '/dati/schema',
  deadlines: () => '/dati/scadenzario',
  quality: () => '/dati/qualita',
  qualityItem: (id: string) => `/dati/qualita/${e(id)}`,

  /* Knowledge (n13, x03, v03, x04, o03). */
  knowledge: () => '/conoscenza',
  knowledgeSearch: (q: string) => `/conoscenza/cerca/${e(q)}`, // allow-italian: address segment, not shown
  knowledgeDoc: (item: string, article?: string) => (article ? `/conoscenza/doc/${e(item)}/${e(article)}` : `/conoscenza/doc/${e(item)}`),
  knowledgeOriginal: (item: string) => `/conoscenza/doc/${e(item)}/originale`,
  procedure: (id: string) => `/conoscenza/procedure/${e(id)}`,
  knowledgeMap: () => '/conoscenza/mappa',

  /* Views and channels (a01, a02, a03, a04, a05, ch01). */
  views: () => '/viste',
  parcel: (record: string) => `/viste/particella/${e(record)}`,
  cad: (record: string) => `/viste/tavola/${e(record)}`,
  presentation: (id: string) => `/viste/presentazione/${e(id)}`,
  viewWhere: (view: string) => `/viste/dove/${e(view)}`,
  channels: (channel?: string) => (channel ? `/canali/${e(channel)}` : '/canali'),

  /* Programs and agents (w06, p02, p03, p04, e01, e02). */
  programs: () => '/programmi',
  program: (id: string) => `/programmi/app/${e(id)}`,
  pcAgent: () => '/programmi/agente',
  remoteControl: () => '/programmi/agente/controllo', // allow-italian: address segment, not shown
  programSearch: () => '/programmi/ricerca', // allow-italian: address segment, not shown
  migration: () => '/programmi/migrazione',
  agents: () => '/programmi/dove-girano',

  /* Settings (g01, k01, g02, g04, s06, q03, d02, n15, n16, t01, t02, c03, o01, o02). */
  settings: (section?: string) => `/impostazioni/${e(section ?? 'generale')}`, // allow-italian: address segment, not shown

  /* Direction and the Board (n18, n17). */
  overview: () => '/panoramica',
  board: (org?: string) => (org ? `/board/${e(org)}` : '/board'),

  /* SARIM (w07, s03, s04). */
  sarimCallCenter: (call?: string) => (call ? `/sarim/call-center/${e(call)}` : '/sarim/call-center'),
  sarimFlows: () => '/sarim/flussi',
  sarimFlow: (flow: string) => `/sarim/flussi/${e(flow)}`,
  sarimOverview: () => '/sarim/panoramica',
  sarimRecord: (id: string) => `/sarim/pratiche/${e(id)}`,

  /* Armonia and Euro Impianti: their organization page. */
  org: (org: string) => `/org/${e(org)}`,
} as const;

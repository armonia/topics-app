/**
 * The towns and clients ORBIT serves, as the table «Comuni serviti» of «Dati» (allow-italian: quotes the Italian interface)
 * shows them. Every row comes from the public sources read on 8/11/2026 and
 * listed in `DATI-VERI-ORBIT.md` of the mockup: the service and the start are
 * written as the source says them, and `source` is the page that says it
 * (opened as an external link). Two rows are past services.
 *
 * `contracts` names the contracts of `contracts.ts` signed with that town (or
 * that run there); `place` is how the cards of `cards.ts` name the place, when
 * it is not the town's name.
 */

export interface OrbitTown {
  /** Address segment: `/dati/comuni/castellabate`. (allow-italian: address segment, not shown) */
  id: string;
  name: string;
  province: string;
  service: string;
  since: string;
  source: { host: string; url: string };
  /** A service ORBIT no longer runs. */
  past?: boolean;
  /** Ids of the contracts of `contracts.ts` that belong to it. */
  contracts: string[];
  /** How a card's `place` starts for it, when not with `name`. */
  place?: string;
}

const PORTAL_HOST = 'orbitambiente-arera.com';
const SITE = 'orbitambiente.it';
const portal = (slug: string) => `https://orbitambiente-arera.com/home/comuni/${slug}/`;

export const ORBIT_TOWNS: OrbitTown[] = [
  { id: 'agropoli', name: 'Agropoli', province: 'SA', service: 'Servizio integrato di raccolta e smaltimento RSU porta a porta, lavaggio strade; spazzamento e servizi complementari', since: '2018 (contratto 8.2.2018); rinnovato nel 2022 per 5 anni', source: { host: PORTAL_HOST, url: portal('agropoli') }, contracts: ['c-agropoli'] }, // allow-italian: fixture data, shown as written
  { id: 'albanella', name: 'Albanella', province: 'SA', service: 'Raccolta e trasporto rifiuti urbani e altri servizi di igiene urbana, spazzamento meccanizzato, isole ecologiche informatizzate', since: 'Già servito nel 2023; nuovo appalto di 7 anni aggiudicato il 13.05.2025', source: { host: SITE, url: 'https://orbitambiente.it/igiene-urbana-albanella-orbit/' }, contracts: ['c-albanella'] }, // allow-italian: fixture data, shown as written
  { id: 'bellizzi', name: 'Bellizzi', province: 'SA', service: 'Gestione integrata RSU e igiene urbana, porta a porta, lavaggio strade', since: '1997 (raccolta a cassonetto); 2001 porta a porta spinto; nuovo contratto nel 2021', source: { host: PORTAL_HOST, url: portal('bellizzisa') }, contracts: [] }, // allow-italian: fixture data, shown as written
  { id: 'camerota', name: 'Camerota', province: 'SA', service: 'Raccolta e smaltimento RSU porta a porta, lavaggio strade', since: "30/06/2017 (affidamento d'urgenza per 3 mesi)", source: { host: PORTAL_HOST, url: portal('camerotasa') }, contracts: [] }, // allow-italian: fixture data, shown as written
  { id: 'capaccio-paestum', name: 'Capaccio Paestum', province: 'SA', service: 'Spazzamento, raccolta, trasporto e smaltimento rifiuti urbani e servizi complementari', since: '03/11/2020 (contratto)', source: { host: PORTAL_HOST, url: portal('capaccio-paestumsa') }, contracts: [] }, // allow-italian: fixture data, shown as written
  { id: 'castel-san-giorgio', name: 'Castel San Giorgio', province: 'SA', service: 'Igiene urbana: raccolta porta a porta, spazzamento e lavaggio strade, ingombranti e RAEE', since: 'Almeno dal 2023; nuovo piano a luglio 2026', source: { host: PORTAL_HOST, url: portal('castel-san-giorgiosa') }, contracts: [] }, // allow-italian: fixture data, shown as written
  { id: 'castellabate', name: 'Castellabate', province: 'SA', service: 'Gestione integrata rifiuti e spazzamento stradale', since: 'Contratto triennale del 2018; nuovo appalto di 4 anni dal 01/04/2026', source: { host: SITE, url: 'https://orbitambiente.it/castellabate-al-via-il-nuovo-servizio-di-gestione-integrata-dei-rifiuti-e-di-spazzamento-stradale/' }, contracts: ['c-castellabate', 'c-sub-lavaggio', 'c-td-castellabate', 'c-accordo-castellabate'] }, // allow-italian: fixture data, shown as written
  { id: 'eboli', name: 'Eboli', province: 'SA', service: 'Piano di gestione dei rifiuti, porta a porta, centro di raccolta comunale; sede della direzione di ORBIT', since: 'Contratto 23/04/2020; gestore uscente', source: { host: PORTAL_HOST, url: portal('ebolisa') }, contracts: ['c-accordo-turni'] }, // allow-italian: fixture data, shown as written
  { id: 'grottaferrata', name: 'Grottaferrata', province: 'RM', service: 'Raccolta porta a porta, spazzamento, centri di raccolta comunali', since: '01/06/2021 (contratto Rep. 6841 del 04.08.2021)', source: { host: PORTAL_HOST, url: portal('grottaferratasa') }, contracts: [] }, // allow-italian: fixture data, shown as written
  { id: 'montecorvino-pugliano', name: 'Montecorvino Pugliano', province: 'SA', service: 'Raccolta integrata porta a porta e trasporto, lavaggio strade', since: '2021 (aggiudicazione del 25/06/2021)', source: { host: PORTAL_HOST, url: portal('m-puglianosa') }, contracts: [] }, // allow-italian: fixture data, shown as written
  { id: 'montecorvino-rovella', name: 'Montecorvino Rovella', province: 'SA', service: 'Raccolta e smaltimento RSU porta a porta, lavaggio strade', since: '1989/1990 (primo comune servito); nuovo servizio da gennaio 2026', source: { host: PORTAL_HOST, url: portal('m-rovellasa') }, contracts: [] }, // allow-italian: fixture data, shown as written
  { id: 'pollica', name: 'Pollica', province: 'SA', service: 'Raccolta e smaltimento RSU porta a porta, lavaggio strade', since: 'non indicato', source: { host: PORTAL_HOST, url: portal('pollicasa') }, contracts: [] }, // allow-italian: fixture data, shown as written
  { id: 'pontecagnano-faiano', name: 'Pontecagnano Faiano', province: 'SA', service: 'Spazzamento, raccolta, trasporto e smaltimento o recupero rifiuti urbani e servizi complementari', since: '2020; nuova aggiudicazione nel 2022', source: { host: PORTAL_HOST, url: portal('pontecagnano-faianosa') }, contracts: [] }, // allow-italian: fixture data, shown as written
  { id: 'rocca-priora', name: 'Rocca Priora', province: 'RM', service: 'Igiene urbana, raccolta e trasporto rifiuti con domiciliare differenziata', since: '2013 (primo comune nel Lazio); appalto di 8 anni aggiudicato il 02/11/2022', source: { host: PORTAL_HOST, url: portal('rocca-priorasa') }, contracts: ['c-rocca-priora'] }, // allow-italian: fixture data, shown as written
  { id: 'san-gianni-a-piro', name: 'San Gianni a Piro', province: 'SA', service: 'Gestione integrata RSU e igiene urbana', since: 'Già servito nel 2017; contratto del 22/09/2022', source: { host: PORTAL_HOST, url: portal('san-gianni-a-pirosa') }, contracts: [] }, // allow-italian: fixture data, shown as written
  { id: 'sarno', name: 'Sarno', province: 'SA', service: 'Servizio integrato di igiene urbana: raccolta domiciliare, spazzamento, servizi complementari', since: '1992 (primo appalto di igiene urbana); contratto del 30/09/2022', source: { host: PORTAL_HOST, url: portal('sarnosa') }, contracts: ['c-sarno'] }, // allow-italian: fixture data, shown as written
  { id: 'serre', name: 'Serre', province: 'SA', service: 'Raccolta, trasporto e recupero o smaltimento rifiuti urbani, spazzamento, servizi accessori', since: '05/12/2022 (contratto)', source: { host: PORTAL_HOST, url: portal('serresa') }, contracts: [] }, // allow-italian: fixture data, shown as written
  { id: 'sicignano-degli-alburni', name: 'Sicignano degli Alburni', province: 'SA', service: 'Servizio triennale di raccolta, trasporto, smaltimento RSU e igiene urbana', since: '11/10/2022 (contratto)', source: { host: PORTAL_HOST, url: portal('sicignano-degli-alburnisa') }, contracts: [] }, // allow-italian: fixture data, shown as written
  { id: 'vallo-della-lucania', name: 'Vallo della Lucania', province: 'SA', service: 'Igiene urbana e servizi complementari', since: '05/12/2017 (contratto); scaduto il 14/03/2025, servizio proseguito', source: { host: PORTAL_HOST, url: portal('vallo-della-lucaniasa') }, contracts: ['c-vallo'] }, // allow-italian: fixture data, shown as written
  { id: 'roma', name: 'Roma Capitale (committente AMA S.p.A.)', province: 'RM', service: 'Raccolta porta a porta delle utenze non domestiche, raccolta foglie e diserbo, Smart Leaf (spazzamento foglie in project financing)', since: '2013 (prime gare AMA); Smart Leaf da ottobre 2024', source: { host: PORTAL_HOST, url: 'https://orbitambiente-arera.com/chi-siamo/' }, contracts: ['c-smart-leaf'], place: 'Roma' }, // allow-italian: fixture data, shown as written
  { id: 'ostuni', name: 'Ostuni', province: 'BR', service: 'Igiene urbana', since: '2007', source: { host: SITE, url: 'https://orbitambiente.it/chi-siamo/' }, past: true, contracts: [] }, // allow-italian: fixture data, shown as written
  { id: 'frascati', name: 'Frascati', province: 'RM', service: 'Igiene urbana: spazzamento, raccolta e trasporto RU (proroga tecnica 2019)', since: 'Fino al 31/05/2021', source: { host: 'trasparenza.comune.frascati.rm.it', url: 'https://trasparenza.comune.frascati.rm.it/archivio11_bandi-gare-e-contratti-fino-al-31122023_0_506117_876_1.html' }, past: true, contracts: [] }, // allow-italian: fixture data, shown as written
];

/**
 * The facts of S.A.R.I.M. SRL that Settings > Organization prints, each with
 * its public source, copied from `DATI-VERI-ORBIT.md` (the round on public
 * sources of 08/11/2026, every link reopened by a second reader). Nothing here
 * is an example: a fact without a source in that file does not go in.
 *
 * The towns are not here: they are the table «Comuni serviti» of «Dati» (allow-italian: quotes the Italian interface)
 * (`data.ts`, `ORBIT_TOWNS`), so the two pages count the same list. The
 * sources disagree on the number (19 on the home page counter, 20 in the
 * Environmental Statement, 25 in a news item): the screen says so.
 */

export interface SourceLink {
  label: string;
  url: string;
  /** The words of the page that support the fact, verbatim. */
  quote: string;
}

export interface OrbitFact {
  id: string;
  label: string;
  value: string;
  source: SourceLink;
}

const HOME: Omit<SourceLink, 'quote'> = { label: 'orbitambiente.it', url: 'https://orbitambiente.it/' };
const DECLARATION: Omit<SourceLink, 'quote'> = { label: 'Dichiarazione ambientale EMAS, RINA 29/06/2026', url: 'https://orbitambiente.it/wp-content/uploads/2026/07/DA-ORBIT-convalidato-RINA_29.06.2026.pdf' }; // allow-italian: fixture data, shown as written
const CERTIFICATIONS: Omit<SourceLink, 'quote'> = { label: 'orbitambiente.it, certificazioni', url: 'https://orbitambiente.it/certificazioni/' }; // allow-italian: fixture data, shown as written
const REGULATOR_PORTAL: Omit<SourceLink, 'quote'> = { label: 'portale ARERA di ORBIT', url: 'https://orbitambiente-arera.com/' }; // allow-italian: fixture data, shown as written

/** Who ORBIT is: name, tax numbers, offices, certified mail, toll-free number, register. */
export const ORBIT_IDENTITY: OrbitFact[] = [
  { id: 'name', label: 'Denominazione', value: 'S.A.R.I.M. SRL, Società Attiva Rifiuti Industriali Meridionali', source: { label: 'orbitambiente.it, chi siamo', url: 'https://orbitambiente.it/chi-siamo/', quote: 'Orbit: acronimo di Società Attiva Rifiuti Industriali Meridionali' } }, // allow-italian: fixture data, shown as written
  { id: 'vat', label: 'Partita IVA', value: '02596800652', source: { ...HOME, quote: 'p.iva: 02596800652' } }, // allow-italian: fixture data, shown as written
  { id: 'tax', label: 'Codice fiscale', value: '04089200630', source: { label: 'avviso TED 235015-2025', url: 'https://ted.europa.eu/it/notice/235015-2025/pdf', quote: 'Numero di registrazione: 04089200630' } }, // allow-italian: fixture data, shown as written
  { id: 'legal', label: 'Sede legale', value: 'Corso Vittorio Emanuele 171, 84122 Salerno (SA)', source: { ...HOME, quote: 'Corso Vittorio Emanuele, 171' } }, // allow-italian: fixture data, shown as written
  { id: 'operations', label: 'Sede amministrativa e operativa', value: 'Eboli, Via Maestri del Lavoro, Area PIP: uffici, deposito automezzi, officina', source: { ...DECLARATION, quote: 'la sede amministrativa è ad Eboli in Via Maestri del Lavoro in Area PIP' } }, // allow-italian: fixture data, shown as written
  { id: 'pec', label: 'PEC', value: 'info@x.example.it', source: { ...DECLARATION, quote: 'info@x.example.it' } }, // allow-italian: fixture data, shown as written
  { id: 'freephone', label: 'Numero verde', value: '800.983850, dalle 08:00 alle 19:00', source: { ...REGULATOR_PORTAL, quote: '800.983850' } }, // allow-italian: fixture data, shown as written
  { id: 'register', label: 'Albo Nazionale Gestori Ambientali', value: 'NA00165, sezione Campania: cat. 1 classe A, 2bis, 4 classe B, 5 classe D, 8 classe C', source: { ...DECLARATION, quote: 'n° iscrizione NA00165' } }, // allow-italian: fixture data, shown as written
  { id: 'holding', label: 'Controllata da', value: 'Bardascino Holding', source: { label: 'orbitambiente.it, chi siamo', url: 'https://orbitambiente.it/chi-siamo/', quote: 'Siamo Orbit, società controllata dalla Bardascino Holding' } }, // allow-italian: fixture data, shown as written
];

export interface OrbitCertification {
  id: string;
  name: string;
  /** What it certifies, in plain words. */
  what: string;
  /** The expiry printed on the PDF on the site, when the source gives one (`YYYY-MM-DD`). */
  expires?: string;
}

export const ORBIT_CERTIFICATIONS_SOURCE: SourceLink = { ...CERTIFICATIONS, quote: 'Certificazione che attesta la qualità dell’organizzazione e dei processi aziendali.' }; // allow-italian: fixture data, shown as written

export const ORBIT_CERTIFICATIONS: OrbitCertification[] = [
  { id: 'iso9001', name: 'ISO 9001', what: 'qualità dei processi' }, // allow-italian: fixture data, shown as written
  { id: 'iso14001', name: 'ISO 14001', what: 'gestione ambientale' }, // allow-italian: fixture data, shown as written
  { id: 'iso45001', name: 'ISO 45001', what: 'salute e sicurezza sul lavoro' }, // allow-italian: fixture data, shown as written
  { id: 'iso37001', name: 'ISO 37001', what: 'prevenzione della corruzione', expires: '2026-12-21' }, // allow-italian: fixture data, shown as written
  { id: 'sa8000', name: 'SA 8000', what: 'responsabilità sociale verso i lavoratori', expires: '2028-03-01' }, // allow-italian: fixture data, shown as written
  { id: 'emas', name: 'EMAS IT-001690', what: 'registrazione ambientale europea, dichiarazione convalidata da RINA il 29/06/2026' }, // allow-italian: fixture data, shown as written
  { id: 'pdr125', name: 'UNI/PdR 125', what: 'parità di genere' }, // allow-italian: fixture data, shown as written
  { id: 'legality', name: 'Rating di legalità', what: 'tre stelle, RT 7468' }, // allow-italian: fixture data, shown as written
];

/** The counters of the home page, as they read today. */
export const ORBIT_NUMBERS_SOURCE: SourceLink = { ...HOME, quote: 'FLOTTA 930 RISORSE 1.124' };

export const ORBIT_NUMBERS: Array<{ id: string; label: string; value: string }> = [
  { id: 'fleet', label: 'mezzi della flotta', value: '930' }, // allow-italian: fixture data, shown as written
  { id: 'people', label: 'risorse', value: '1.124' }, // allow-italian: fixture data, shown as written
  { id: 'towns', label: 'comuni serviti', value: '19' }, // allow-italian: fixture data, shown as written
  { id: 'waste', label: 'kg di rifiuti gestiti', value: '176.591.912' }, // allow-italian: fixture data, shown as written
];

/** The portal with one page per town served. */
export const ORBIT_SERVED_SOURCE: SourceLink = { ...REGULATOR_PORTAL, quote: 'servizio di gestione dei rifiuti urbani' }; // allow-italian: fixture data, shown as written

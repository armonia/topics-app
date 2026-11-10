/**
 * The facts of the Consorzio di Bonifica Integrale Comprensorio Sarno that
 * Settings > Organization prints, each with its public source and the words of
 * the page that support it, copied verbatim. They come from `DATI-VERI.md` of
 * the mockup and were reopened on 09/11/2026 against the two public sources:
 * the Libro dell'anno 2025 (PDF) and the home page of bonificasarno.it. allow-italian: quotes the words on screen
 * Nothing here is an example: a fact without a source does not go in.
 *
 * The comuni are not here: they are the table «Comuni del comprensorio» of allow-italian: quotes the words on screen
 * «Dati» (`data.ts`, `NOCERA_TOWNS`), so the two pages count the same list.
 * Same shape as `../orbit-org/organization.ts`.
 */
import type { OrbitFact, SourceLink } from '../orbit-org/organization';

const BOOK: Omit<SourceLink, 'quote'> = {
  label: "Libro dell'anno 2025 del Consorzio", // allow-italian: fixture data, shown as written
  url: 'https://www.bonificasarno.it/site/wp-content/uploads/2026/03/web_librodellanno-2025-consorziobonifica.pdf',
};
const HOME: Omit<SourceLink, 'quote'> = { label: 'bonificasarno.it', url: 'https://www.bonificasarno.it' };

/** Who the Consorzio is: name, nature, law, seat, certified mail, phone, tax code, territory. */
export const NOCERA_IDENTITY: OrbitFact[] = [
  { id: 'name', label: 'Denominazione', value: 'Consorzio di Bonifica Integrale Comprensorio Sarno', source: { ...BOOK, quote: 'ha assunto la denominazione di “Consorzio di Bonifica Integrale Comprensorio Sarno”' } }, // allow-italian: fixture data, shown as written
  { id: 'founded', label: 'Costituzione', value: "1° dicembre 1952, con DPR, come Consorzio di Bonifica dell'Agro Sarnese Nocerino", source: { ...BOOK, quote: 'costituito con DPR del 1° dicembre 1952 quale Ente di Diritto Pubblico' } }, // allow-italian: fixture data, shown as written
  { id: 'nature', label: 'Natura giuridica', value: 'Ente pubblico economico a carattere associativo (L.R. Campania 7 del 6 giugno 2025, art. 9, comma 3)', source: { ...BOOK, quote: 'enti pubblici economici a carattere associativo (art.9, comma 3)' } }, // allow-italian: fixture data, shown as written
  { id: 'law', label: 'Legge di riferimento', value: 'L.R. Campania 7 del 6 giugno 2025, che ha abrogato la L.R. 4/2003', source: { ...BOOK, quote: 'Legge Regionale n.7 del 6 giugno 2025, che ha sostituito e abrogato la precedente L.R. n. 4/2003' } }, // allow-italian: fixture data, shown as written
  { id: 'seat', label: 'Sede', value: 'Via Giuseppe Atzori snc, Centrale Ortofrutticola I, 84014 Nocera Inferiore (SA)', source: { ...HOME, quote: '84014 Nocera Inferiore (Sa)' } }, // allow-italian: fixture data, shown as written
  { id: 'pec', label: 'PEC', value: 'protocollo@x.example.it', source: { ...HOME, quote: 'protocollo@x.example.it' } }, // allow-italian: fixture data, shown as written
  { id: 'phone', label: 'Telefono', value: '081.3204511', source: { ...HOME, quote: 'Tel.: 081.3204511' } }, // allow-italian: fixture data, shown as written
  { id: 'tax', label: 'Codice fiscale', value: '80009450653', source: { ...HOME, quote: 'Cod. Fiscale 80009450653' } }, // allow-italian: fixture data, shown as written
  { id: 'territory', label: 'Comprensorio', value: 'Sarno: bacini Sarno, Torrenti Vesuviani e Irno', source: { ...BOOK, quote: 'il Consorzio opera ora nel comprensorio denominato “Sarno”, comprendente i bacini Sarno, Torrenti Vesuviani e Irno' } }, // allow-italian: fixture data, shown as written
  { id: 'members', label: 'Chi ne fa parte', value: 'Tutti i proprietari degli immobili che beneficiano delle opere di bonifica', source: { ...HOME, quote: "Il Consorzio è l'associazione di tutti i proprietari degli immobili (terreni e fabbricati) che beneficiano delle opere di bonifica." } }, // allow-italian: fixture data, shown as written
];

/** No certification is published on the site or in the book: the list stays empty on purpose. */
export interface NoceraCertification {
  id: string;
  name: string;
  what: string;
  expires?: string;
}

export const NOCERA_CERTIFICATIONS: NoceraCertification[] = [];

/** Where the empty list comes from: the home page, read on 09/11/2026, names none. */
export const NOCERA_CERTIFICATIONS_SOURCE: SourceLink = { ...HOME, quote: '' };

/** A figure of the Consorzio with the page it is read from. */
export interface NoceraNumber {
  id: string;
  label: string;
  value: string;
  source: SourceLink;
}

/** The figures «Organizzazione» prints, as the book gives them (the staff count is the exception, see below). */
export const NOCERA_NUMBERS: NoceraNumber[] = [
  { id: 'area', label: 'ettari di comprensorio', value: '43.054', source: { ...BOOK, quote: 'Il comprensorio di attuale operatività interessa una superficie totale di 43.054 ettari.' } }, // allow-italian: fixture data, shown as written
  { id: 'network', label: 'km di rete idraulica', value: '680', source: { ...BOOK, quote: 'sono presenti circa 680 km di rete idraulica' } }, // allow-italian: fixture data, shown as written
  { id: 'basins', label: 'vasche assorbenti e laminanti', value: '24', source: { ...BOOK, quote: 'Nel territorio di competenza del Consorzio sono presenti 24 vasche' } }, // allow-italian: fixture data, shown as written
  { id: 'wells', label: 'pozzi della rete irrigua', value: '55', source: { ...BOOK, quote: 'La rete irrigua è alimentata da 55 pozzi di falda profonda, con una portata complessiva di 2.503 litri/secondo.' } }, // allow-italian: fixture data, shown as written
  { id: 'irrigated', label: 'ettari irrigati su 10.131 irrigabili', value: '1.697', source: { ...BOOK, quote: 'per un totale di 1.697,00 ettari di superficie irrigata e 10.131,00 ettari di superficie irrigabile' } }, // allow-italian: fixture data, shown as written
  /* The staff count comes from the 2024 income statement in «Amministrazione trasparente» (study of 05/11, DATI-VERI.md); the quote below is the wording of that note, to be replaced with the line of the document the day it is reopened. */
  { id: 'staff', label: 'dipendenti al 31/12/2024', value: '129', source: { label: 'bonificasarno.it, Amministrazione trasparente, conto economico 2024', url: 'https://www.bonificasarno.it/amministrazione-trasparente/', quote: '129 dipendenti (3 dirigenti, 30 impiegati, 96 operai)' } }, // allow-italian: fixture data, shown as written
];

/** The generic source of the figures, for the screens that print one link under all of them. */
export const NOCERA_NUMBERS_SOURCE: SourceLink = { ...BOOK, quote: 'Il comprensorio di attuale operatività interessa una superficie totale di 43.054 ettari.' }; // allow-italian: fixture data, shown as written

/** The towns and the table that lists them. */
export const NOCERA_SERVED_SOURCE: SourceLink = { ...BOOK, quote: 'COMUNI DEL COMPRENSORIO ALTO' }; // allow-italian: fixture data, shown as written

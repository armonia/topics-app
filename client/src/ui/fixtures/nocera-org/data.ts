/**
 * The comuni of the comprensorio «Sarno», as the table «Comuni del allow-italian: quotes the words on screen
 * comprensorio» of «Dati» shows them. Every row comes from the Libro dell'anno allow-italian: quotes the words on screen
 * 2025 of the Consorzio: the two lists «Comuni del comprensorio Alto» (11) and allow-italian: quotes the words on screen
 * «Comuni del comprensorio Basso» (10), and the canals, torrents and basins allow-italian: quotes the words on screen
 * each comune carries in the book. The book gives no start date and no
 * service per comune, so `since` says so and `service` names the comprensorio
 * and the works the book lists there. The provinces are the ones the book
 * prints next to the works (SA, AV) or the known ones (NA).
 *
 * `contracts` is empty: the contract author fills it with the ids of
 * `contracts.ts` that run in that comune. `place` is how the cards name the
 * place, when it is not the name of the comune.
 */
import type { SarimTown } from '../sarim-org/data';

const BOOK = 'https://www.bonificasarno.it/site/wp-content/uploads/2026/03/web_librodellanno-2025-consorziobonifica.pdf';
const source = { host: 'bonificasarno.it', url: BOOK };

const NO_START = "non indicato nel Libro dell'anno 2025"; // allow-italian: fixture data, shown as written

const high = (text: string) => `Comprensorio Alto. ${text}`; // allow-italian: fixture data, shown as written
const low = (text: string) => `Comprensorio Basso. ${text}`; // allow-italian: fixture data, shown as written
const NO_WORKS = "Nessun intervento citato nel Libro dell'anno 2025."; // allow-italian: fixture data, shown as written
const works = (list: string) => `Nel Libro dell'anno 2025: ${list}.`; // allow-italian: fixture data, shown as written

export const NOCERA_TOWNS: SarimTown[] = [
  { id: 'bracigliano', name: 'Bracigliano', province: 'SA', service: high(works('Torrente Lavinaio, Vallone Ionne, Vallone Marzio, Vallone Piesco, Vallone Salto')), since: NO_START, source, contracts: [] }, // allow-italian: fixture data, shown as written
  { id: 'montoro', name: 'Montoro', province: 'AV', service: high(works('Canale Labso, Canale Vietri, Vallone Valle, Fiumicello Borgo')), since: NO_START, source, contracts: [] }, // allow-italian: fixture data, shown as written
  { id: 'solofra', name: 'Solofra', province: 'AV', service: high(works('Vallone San Vito, Vallone della Starza, Vallone Santo Spirito')), since: NO_START, source, contracts: [] }, // allow-italian: fixture data, shown as written
  { id: 'siano', name: 'Siano', province: 'SA', service: high(works('Vallone Truda, Vallone Orneto, Vasca Campo, Vasca San Vito')), since: NO_START, source, contracts: ['ct-convenzione-difesa-suolo'] }, // allow-italian: fixture data, shown as written
  { id: 'castel-san-giorgio', name: 'Castel San Giorgio', province: 'SA', service: high(works('Canale dei Mulini, Canale Lauro, Canale Macchione, Canale Torello, Vasca Lanzara')), since: NO_START, source, contracts: [] }, // allow-italian: fixture data, shown as written
  { id: 'mercato-san-severino', name: 'Mercato San Severino', province: 'SA', service: high(works('Canale Mulino Pagano, Canale Nocelleto, Torrente Lavinaio, Vasca Ciorani')), since: NO_START, source, contracts: [] }, // allow-italian: fixture data, shown as written
  { id: 'fisciano', name: 'Fisciano', province: 'SA', service: high(works('Torrente Calvagnola, Torrente San Rocco')), since: NO_START, source, contracts: [] }, // allow-italian: fixture data, shown as written
  { id: 'calvanico', name: 'Calvanico', province: 'SA', service: high(NO_WORKS), since: NO_START, source, contracts: [] }, // allow-italian: fixture data, shown as written
  { id: 'roccapiemonte', name: 'Roccapiemonte', province: 'SA', service: high(works('Collettore Casali, Collettore Roccapiemonte')), since: NO_START, source, contracts: [] }, // allow-italian: fixture data, shown as written
  { id: 'nocera-superiore', name: 'Nocera Superiore', province: 'SA', service: high(works('Alveo Bagnara, Alveo Citola, Canale Santa Croce, Vasca Santa Croce')), since: NO_START, source, contracts: [] }, // allow-italian: fixture data, shown as written
  { id: 'cava-de-tirreni', name: "Cava de' Tirreni", province: 'SA', service: high(works('Vallone Arbosto, Vallone Bagnara, Vallone Citola, Vallone Contrapone')), since: NO_START, source, contracts: [] }, // allow-italian: fixture data, shown as written
  { id: 'palma-campania', name: 'Palma Campania', province: 'NA', service: low(NO_WORKS), since: NO_START, source, contracts: [] }, // allow-italian: fixture data, shown as written
  { id: 'sarno', name: 'Sarno', province: 'SA', service: low(works('Canale Fraina, Rio Bracciullo, Vallone Trave')), since: NO_START, source, contracts: [] }, // allow-italian: fixture data, shown as written
  { id: 'poggiomarino', name: 'Poggiomarino', province: 'NA', service: low(NO_WORKS), since: NO_START, source, contracts: [] }, // allow-italian: fixture data, shown as written
  { id: 'striano', name: 'Striano', province: 'NA', service: low(works('Canale Corrente, Canale Rivolta')), since: NO_START, source, contracts: [] }, // allow-italian: fixture data, shown as written
  { id: 'san-valentino-torio', name: 'San Valentino Torio', province: 'SA', service: low(works('Canale Rio Casatori, Canale Rio Pennacchio')), since: NO_START, source, contracts: [] }, // allow-italian: fixture data, shown as written
  { id: 'boscoreale', name: 'Boscoreale', province: 'NA', service: low(NO_WORKS), since: NO_START, source, contracts: [] }, // allow-italian: fixture data, shown as written
  { id: 'scafati', name: 'Scafati', province: 'SA', service: low(works('Canale Bottaro, Rio Sguazzatorio, Canale Controfosso Destro del fiume Sarno')), since: NO_START, source, contracts: [] }, // allow-italian: fixture data, shown as written
  { id: 'san-marzano-sul-sarno', name: 'San Marzano sul Sarno', province: 'SA', service: low(works('Canale Mannara, Canale Buonaiuto, Alveo Comune Nocerino')), since: NO_START, source, contracts: [] }, // allow-italian: fixture data, shown as written
  { id: 'pagani', name: 'Pagani', province: 'SA', service: low(works('Alveo Comune Nocerino, Vasca Pignataro')), since: NO_START, source, contracts: [] }, // allow-italian: fixture data, shown as written
  { id: 'nocera-inferiore', name: 'Nocera Inferiore', province: 'SA', service: low(`Sede del Consorzio. ${works('Alveo Comune Nocerino, Canale Fosso Imperatore, Vasca Cicalesi')}`), since: NO_START, source, contracts: [] }, // allow-italian: fixture data, shown as written
];

/**
 * Case S-0151: the FIR of a leaf collection trip, back with a weight at
 * destination lower than the estimate, to register in WinWaste and RENTRI.
 * SARIM, flow `sarim-fir`, office `servizi`.
 *
 * Real: FIR/RENTRI and the leaf service are SARIM's repetitive work, WinWaste
 * its waste program (training questionnaire, DATI-VERI.md); EER 20 02 01 is
 * the code of biodegradable waste from gardens and parks. An example: the
 * FIR number, the producer, the plant, the weights, the 2-day rule (declared
 * as an internal example).
 */
import type { CaseSeed } from '../types';
import { original } from './originals';

export const CASE_S0151: CaseSeed = {
  id: 'S-0151',
  org: 'sarim',
  kind: 'fir',
  title: 'FIR foglie, peso a destino da registrare', // allow-italian: fixture data, shown as written
  subject: 'FIR RXFT 004812 KP del 03/11/2026, servizio foglie', // allow-italian: fixture data, shown as written
  office: 'servizi',
  flow: 'sarim-fir',
  channel: 'portale',
  arrivedAt: '2026-11-04T09:20:00+01:00',
  counterpart: 'Impianto di compostaggio (esempio)', // allow-italian: fixture data, shown as written
  status: 'in-lavorazione',
  assignee: 'attilio',
  proposal: 'Servizi · registrare 4.820 kg entro oggi', // allow-italian: fixture data, shown as written
  fields: [
    {
      id: 'numero', label: 'Numero FIR', value: 'RXFT 004812 KP', confidence: 98, consulted: 1, // allow-italian: fixture data, shown as written
      source: { doc: 'd-fir', page: 1, before: 'Numero FIR: ', highlight: 'RXFT 004812 KP', after: ' Data emissione' }, // allow-italian: fixture data, shown as written
      reasoning: ['Numero assegnato con la vidimazione virtuale RENTRI.'], // allow-italian: fixture data, shown as written
    },
    {
      id: 'eer', label: 'Codice EER', value: '20 02 01 · rifiuti biodegradabili', confidence: 97, consulted: 1, // allow-italian: fixture data, shown as written
      source: { doc: 'd-fir', page: 1, before: 'Codice EER ', highlight: '20 02 01', after: ' · rifiuti biodegradabili' }, // allow-italian: fixture data, shown as written
      reasoning: ['Foglie del servizio di raccolta: stesso codice dei FIR precedenti del servizio.'], // allow-italian: fixture data, shown as written
    },
    {
      id: 'peso', label: 'Peso a destino', value: '4.820 kg (stimati 5.200)', confidence: 82, consulted: 1, // allow-italian: fixture data, shown as written
      source: { doc: 'd-fir', page: 1, before: 'Peso verificato a destino ', highlight: '4.820 kg', after: '' }, // allow-italian: fixture data, shown as written
      reasoning: ['Scritto a mano dall\'impianto, per questo sotto 85%. Nel registro va il peso verificato a destino, non la stima: 380 kg in meno.'], // allow-italian: fixture data, shown as written
    },
  ],
  deadlines: [
    {
      id: 'registrazione', label: 'Registrazione in WinWaste e RENTRI', // allow-italian: fixture data, shown as written
      from: '2026-11-04', days: 2, date: '2026-11-06', rollsOver: true,
      rule: 'regola interna di esempio: entro 2 giorni dal rientro del FIR', // allow-italian: fixture data, shown as written
      calc: 'Copia firmata rientrata il 04/11/2026: registrare entro venerdì 06/11/2026.', // allow-italian: fixture data, shown as written
      office: 'servizi',
    },
  ],
  steps: [
    { id: 'emesso', label: 'FIR emesso', flowStep: 's1', state: 'done', at: '2026-11-03 07:20', by: 'WinWaste' }, // allow-italian: fixture data, shown as written
    { id: 'trasporto', label: 'Trasporto', flowStep: 's2', state: 'done', at: '2026-11-03 11:10', by: 'Squadra foglie (esempio)' }, // allow-italian: fixture data, shown as written
    { id: 'rientro', label: 'Rientro con il peso', flowStep: 's3', state: 'done', at: '2026-11-04 09:20', by: 'Servizi' }, // allow-italian: fixture data, shown as written
    { id: 'registrazione', label: 'Registrazione', flowStep: 's4', state: 'current' }, // allow-italian: fixture data, shown as written
    { id: 'rendiconto', label: 'Rendicontazione foglie', flowStep: 's5', state: 'todo' }, // allow-italian: fixture data, shown as written
  ],
  documents: [
    {
      id: 'd-fir', name: 'FIR-RXFT004812KP.pdf', kind: 'pdf',
      detail: 'copia firmata dal destinatario · 1 pagina', // allow-italian: fixture data, shown as written
      from: 'Impianto di compostaggio (esempio)', receivedAt: '2026-11-04T09:20:00+01:00', // allow-italian: fixture data, shown as written
      summary: [{ text: 'Foglie, EER 20 02 01: stimati 5.200 kg, verificati a destino 4.820 kg, accettato per intero.', page: 1 }], // allow-italian: fixture data, shown as written
      ...original('S-0151', 'd-fir', 1),
    },
  ],
  history: [
    { at: '2026-11-03 07:20', who: 'WinWaste', what: 'FIR emesso e vidimato con RENTRI' }, // allow-italian: fixture data, shown as written
    { at: '2026-11-04 09:20', who: 'Servizi', what: 'Copia firmata rientrata e scansionata', doc: 'd-fir' }, // allow-italian: fixture data, shown as written
    { at: '2026-11-04 09:22', who: 'AI', what: 'Peso a destino 4.820 kg, 380 kg sotto la stima' }, // allow-italian: fixture data, shown as written
  ],
  primaryAction: {
    label: 'Registra in WinWaste e RENTRI', // allow-italian: fixture data, shown as written
    kind: 'deposit',
    receipt: {
      title: 'Registrazione eseguita', // allow-italian: fixture data, shown as written
      lines: [
        'Registro cronologico: scarico di 4.820 kg, EER 20 02 01', // allow-italian: fixture data, shown as written
        'FIR RXFT 004812 KP chiuso in WinWaste', // allow-italian: fixture data, shown as written
        'Dati trasmessi a RENTRI il 06/11/2026 alle 10:37', // allow-italian: fixture data, shown as written
      ],
    },
  },
  example: true,
};

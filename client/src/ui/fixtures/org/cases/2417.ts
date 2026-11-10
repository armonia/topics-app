/**
 * Case 2417: a contested payment notice, appealed by a taxpayer. The Legale
 * confirmed the classification, and then the Halley robot stopped on its
 * refused password (run e-0412), so the case has no protocol number yet and
 * the run is the thing that holds it. Legal path of the PEC flow, office
 * Legale. A lighter case: it exists so that the stopped run, the Registro and
 * the notice point to a case that opens.
 */
import type { CaseSeed } from '../types';

export const CASE_2417: CaseSeed = {
  id: '2417',
  org: 'nocera',
  kind: 'ricorso',
  title: 'Avviso contestato, ricorso del contribuente', // allow-italian: fixture data, shown as written
  subject: 'Ricorso avverso avviso di pagamento contestato', // allow-italian: fixture data, shown as written
  office: 'legale',
  flow: 'pec',
  channel: 'pec',
  arrivedAt: '2026-11-05T08:52:40+01:00',
  counterpart: 'Contribuente (esempio)', // allow-italian: fixture data, shown as written
  status: 'in-lavorazione',
  assignee: 'protocollo',
  proposal: 'Legale · protocollo fermo, il robot di Halley aspetta la password', // allow-italian: fixture data, shown as written
  fields: [],
  deadlines: [],
  steps: [
    { id: 'arrivata', label: 'Arrivata', flowStep: 'trigger', state: 'done', at: '2026-11-05 08:52', by: 'Flusso PEC' }, // allow-italian: fixture data, shown as written
    { id: 'protocollata', label: 'Protocollata', flowStep: 'e', state: 'current' }, // allow-italian: fixture data, shown as written
    { id: 'controdeduzioni', label: 'Controdeduzioni', flowStep: 'f', state: 'todo' }, // allow-italian: fixture data, shown as written
  ],
  documents: [],
  history: [
    { at: '2026-11-05 08:52', who: 'Flusso PEC', what: 'PEC consegnata su protocollo@' }, // allow-italian: fixture data, shown as written
    { at: '2026-11-06 09:50', who: 'Halley', what: 'Il robot si è fermato: password rifiutata, 3 tentativi, nessun dato scritto' }, // allow-italian: fixture data, shown as written
  ],
  primaryAction: {
    label: 'Invia le controdeduzioni', // allow-italian: fixture data, shown as written
    kind: 'send-pec',
    receipt: { title: 'Ricevuta di avvenuta consegna', lines: ['Consegnato alla casella PEC del contribuente (esempio)'] }, // allow-italian: fixture data, shown as written
  },
  example: true,
};

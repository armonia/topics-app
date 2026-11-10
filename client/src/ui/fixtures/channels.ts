/**
 * Fixture of ch01: the channels of the example organization, where its work
 * comes from and where it goes out. True: PEC is Aruba, mail and Teams are
 * Microsoft 365, the Consorzio adopted SEND in 05/2026 and has the site
 * bonificasarno.it (DATI-VERI.md). Example: the state of each connection and
 * the volumes. Volumes are the monthly estimates of the flows each channel
 * starts (`org/flows.ts`), so the overview and this table add up the same;
 * a channel that starts no flow shows no number rather than an invented one.
 */
import type { Channel } from './org/types';
import { flowSeed } from './org/flows';

export type ChannelId = 'pec' | 'mail' | 'whatsapp' | 'teams' | 'telefono' | 'portale' | 'sdi' | 'send';

export type ChannelState = 'connected' | 'testing' | 'pending' | 'paused';

/** What comes in and what goes out, as kinds the copy names. */
export type ChannelIn = 'yes' | 'no' | 'transcribed';
export type ChannelOut = 'yes' | 'no' | 'notices' | 'receipt';

export interface RoutingRule {
  id: string;
  /** When it applies, in plain words. */
  when: string;
  /** What happens, in plain words. */
  then: string;
  /** The flow it starts, if any (`org/flows.ts`). */
  flow?: string;
  on: boolean;
}

export interface ChannelSeed {
  id: ChannelId;
  /** The channel kind of the cases that arrive through it (`CaseSeed.channel`). */
  caseChannel?: Channel;
  name: string;
  /** Who provides it. */
  provider: string;
  address: string;
  state: ChannelState;
  entra: ChannelIn;
  esce: ChannelOut;
  /** The flow it starts; `undefined`: a person takes what arrives. */
  flow?: string;
  /** What starts instead of a flow, when there is none. */
  startsNote?: string;
  /** What must happen before something leaves. */
  beforeExit?: string;
  /** What the channel's rules say, one line. */
  policy: string;
  rules: RoutingRule[];
}

const reportsPerMonth = flowSeed('segnalazioni')?.perMonth ?? 64;
/** WhatsApp takes this many of the monthly segnalazioni, the telephone the rest. */
const WHATSAPP_SHARE = 24;

/** Items per month a channel brings, an estimate; `undefined` when it starts no flow. */
export const CHANNEL_VOLUME: Partial<Record<ChannelId, number>> = {
  pec: flowSeed('pec')?.perMonth,
  whatsapp: WHATSAPP_SHARE,
  telefono: reportsPerMonth - WHATSAPP_SHARE,
  portale: flowSeed('irrigua')?.perMonth,
  sdi: flowSeed('fatture')?.perMonth,
};

export const CHANNELS: ChannelSeed[] = [
  {
    id: 'pec', caseChannel: 'pec', name: 'PEC protocollo@', provider: 'Aruba', address: 'protocollo@', // allow-italian: fixture data, shown as written
    state: 'connected', entra: 'yes', esce: 'yes', flow: 'pec', beforeExit: 'firma del responsabile', // allow-italian: fixture data, shown as written
    policy: 'La PEC vale come raccomandata: ogni messaggio si protocolla e le ricevute si conservano.', // allow-italian: fixture data, shown as written
    rules: [
      { id: 'r1', when: 'sempre', then: 'avvia «PEC in arrivo → protocollo»', flow: 'pec', on: true }, // allow-italian: fixture data, shown as written
      { id: 'r2', when: 'il mittente è una PEC di tribunale o di avvocato', then: 'va al Legale, mai in coda al Protocollo', on: true }, // allow-italian: fixture data, shown as written
      { id: 'r3', when: 'l\'oggetto contiene «accesso agli atti»', then: 'avvia «Accesso agli atti»', flow: 'accesso', on: false }, // allow-italian: fixture data, shown as written
    ],
  },
  {
    id: 'mail', caseChannel: 'mail', name: 'Mail ordinaria', provider: 'Microsoft 365', address: 'caselle degli uffici', // allow-italian: fixture data, shown as written
    state: 'connected', entra: 'yes', esce: 'yes', startsNote: 'la legge una persona', beforeExit: 'conferma della persona', // allow-italian: fixture data, shown as written
    policy: 'Una mail ordinaria non ha valore legale: si smista, non si protocolla da sola.', // allow-italian: fixture data, shown as written
    rules: [
      { id: 'r1', when: 'sempre', then: 'va in «Da fare» del Protocollo', on: true }, // allow-italian: fixture data, shown as written
      { id: 'r2', when: 'allegata una fattura XML', then: 'avvia «Fattura passiva → pagamento»', flow: 'fatture', on: false }, // allow-italian: fixture data, shown as written
    ],
  },
  {
    id: 'whatsapp', caseChannel: 'whatsapp', name: 'WhatsApp Business', provider: 'Meta', address: 'il numero Business dell\'ente (esempio)', // allow-italian: fixture data, shown as written
    state: 'connected', entra: 'yes', esce: 'yes', flow: 'segnalazioni', beforeExit: 'solo modelli approvati', // allow-italian: fixture data, shown as written
    policy: 'Si risponde solo con modelli approvati e dentro le 24 ore dall\'ultimo messaggio.', // allow-italian: fixture data, shown as written
    rules: [
      { id: 'r1', when: 'arriva una foto o una posizione', then: 'avvia «Segnalazione dal territorio → intervento»', flow: 'segnalazioni', on: true }, // allow-italian: fixture data, shown as written
      { id: 'r2', when: 'chiede lo stato di un turno', then: 'risponde con il modello «stato del turno»', on: true }, // allow-italian: fixture data, shown as written
    ],
  },
  {
    id: 'teams', caseChannel: 'teams', name: 'Teams', provider: 'Microsoft 365', address: 'canale «Richieste interne»', // allow-italian: fixture data, shown as written
    state: 'connected', entra: 'yes', esce: 'notices', startsNote: 'richieste interne, a una persona', // allow-italian: fixture data, shown as written
    policy: 'Teams porta richieste interne e manda avvisi: non esce niente verso l\'esterno.', // allow-italian: fixture data, shown as written
    rules: [
      { id: 'r1', when: 'un messaggio nel canale «Richieste interne»', then: 'va in «Da fare» dell\'ufficio indicato', on: true }, // allow-italian: fixture data, shown as written
    ],
  },
  {
    id: 'telefono', caseChannel: 'telefono', name: 'Telefono', provider: 'centralino', address: 'trascrizione delle chiamate', // allow-italian: fixture data, shown as written
    state: 'testing', entra: 'transcribed', esce: 'no', flow: 'segnalazioni', // allow-italian: fixture data, shown as written
    policy: 'Il telefono si trascrive: la chiamata diventa un testo da confermare, con l\'audio accanto.', // allow-italian: fixture data, shown as written
    rules: [
      { id: 'r1', when: 'la trascrizione cita un canale o un allagamento', then: 'avvia «Segnalazione dal territorio → intervento»', flow: 'segnalazioni', on: true }, // allow-italian: fixture data, shown as written
    ],
  },
  {
    id: 'portale', caseChannel: 'portale', name: 'Modulo sul sito', provider: 'bonificasarno.it', address: 'www.bonificasarno.it', // allow-italian: fixture data, shown as written
    state: 'connected', entra: 'yes', esce: 'receipt', flow: 'irrigua', beforeExit: 'ricevuta automatica', // allow-italian: fixture data, shown as written
    policy: 'Chi compila il modulo riceve subito una ricevuta con il numero della richiesta.', // allow-italian: fixture data, shown as written
    rules: [
      { id: 'r1', when: 'modulo «richiesta irrigua»', then: 'avvia «Richiesta irrigua → turno»', flow: 'irrigua', on: true }, // allow-italian: fixture data, shown as written
    ],
  },
  {
    id: 'sdi', caseChannel: 'sdi', name: 'SdI fatture', provider: 'Sistema di Interscambio', address: 'codice destinatario dell\'ente', // allow-italian: fixture data, shown as written
    state: 'connected', entra: 'yes', esce: 'no', flow: 'fatture', // allow-italian: fixture data, shown as written
    policy: 'Le fatture elettroniche arrivano dallo SdI e si leggono come XML, non come immagini.', // allow-italian: fixture data, shown as written
    rules: [
      { id: 'r1', when: 'sempre', then: 'avvia «Fattura passiva → pagamento»', flow: 'fatture', on: true }, // allow-italian: fixture data, shown as written
    ],
  },
  {
    id: 'send', name: 'SEND, notifiche a valore legale', provider: 'PagoPA', address: 'piattaforma notifiche digitali', // allow-italian: fixture data, shown as written
    state: 'pending', entra: 'no', esce: 'yes', beforeExit: 'firma del direttore', // allow-italian: fixture data, shown as written
    policy: 'Una notifica SEND ha valore legale: parte solo con la firma del direttore.', // allow-italian: fixture data, shown as written
    rules: [
      { id: 'r1', when: 'una pratica chiede una notifica a valore legale', then: 'prepara la notifica e aspetta la firma del direttore', on: true }, // allow-italian: fixture data, shown as written
    ],
  },
];

/**
 * One person reached on several channels (the right side of the overview):
 * the same taxpayer by PEC, WhatsApp and the telephone, recognised by tax code
 * and by the number in the Prunes registry. Example, as the case says.
 */
export const SAME_PERSON = {
  fallbackName: 'Azienda agricola (esempio)', // allow-italian: fixture data, shown as written
  note: 'Riconosciuta dal codice fiscale e dal numero in anagrafica Prunes. Chi apre la pratica vede tutta la storia, in ordine.', // allow-italian: fixture data, shown as written
  items: [
    { channel: 'pec' as const, text: 'PEC dell\'avvocato · ricorso', day: '2026-11-05', caseId: '2418' }, // allow-italian: fixture data, shown as written
    { channel: 'whatsapp' as const, text: 'WhatsApp · «quando passa il turno?»', day: '2026-10-28' }, // allow-italian: fixture data, shown as written
    { channel: 'telefono' as const, text: 'Telefonata · sollecito avviso', day: '2026-09-12' }, // allow-italian: fixture data, shown as written
  ],
};

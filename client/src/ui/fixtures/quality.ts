/**
 * Fixture of q01 and q02: the controls that stand in front of every write,
 * the six dimensions of ISO/IEC 25012 they measure, and the examples stopped
 * in quarantine. Scores that can be computed are computed by the preview from
 * the example cases; the others carry a declared example percentage and the
 * screen says so. Suppliers, invoices and IBANs are examples and masked.
 */

export type DimensionId = 'accuracy' | 'completeness' | 'consistency' | 'credibility' | 'currentness' | 'compliance';

export const DIMENSION_IDS: DimensionId[] = ['accuracy', 'completeness', 'consistency', 'currentness', 'credibility', 'compliance'];

export type CheckScope = 'field' | 'tables' | 'programs' | 'outliers';

export interface CheckSeed {
  id: string;
  dimension: DimensionId;
  scope: CheckScope;
  /** What is checked, in the words of the sector. */
  label: string;
  /** Where it applies. */
  where: string;
  /** Computed from the example cases when set; otherwise `declaredPct` is shown as an example. */
  evaluator?: string;
  declaredPct?: number;
}

export const CHECKS: CheckSeed[] = [
  { id: 'c-cf', dimension: 'accuracy', scope: 'field', label: 'Codice fiscale con carattere di controllo valido', where: 'Contribuente, ricorrente', declaredPct: 99.9 }, // allow-italian: fixture data, shown as written
  { id: 'c-iban', dimension: 'accuracy', scope: 'field', label: 'IBAN con cifra di controllo valida', where: 'Fornitore, fatture', declaredPct: 99.9 }, // allow-italian: fixture data, shown as written
  { id: 'c-amount', dimension: 'accuracy', scope: 'field', label: 'Importi non negativi', where: 'Pratiche con un importo', evaluator: 'amount' }, // allow-italian: fixture data, shown as written
  { id: 'c-notified', dimension: 'accuracy', scope: 'field', label: 'Data di notifica non nel futuro', where: 'Scadenze: evento da cui decorre il termine', evaluator: 'notified' }, // allow-italian: fixture data, shown as written
  { id: 'c-required', dimension: 'completeness', scope: 'field', label: 'Ufficio, flusso, oggetto, controparte e responsabile compilati', where: 'Pratiche', evaluator: 'required' }, // allow-italian: fixture data, shown as written
  { id: 'c-protocol', dimension: 'completeness', scope: 'field', label: 'Ogni pratica già confermata ha il numero di protocollo', where: 'Pratiche, Halley', evaluator: 'protocol' }, // allow-italian: fixture data, shown as written
  { id: 'c-deadlines', dimension: 'consistency', scope: 'tables', label: 'Ogni scadenza torna: data = evento + giorni, spostata dopo i festivi', where: 'Scadenze, regole del percorso', evaluator: 'deadlines' }, // allow-italian: fixture data, shown as written
  { id: 'c-duplicates', dimension: 'consistency', scope: 'tables', label: 'Un solo numero di protocollo per pratica, nessun doppione', where: 'Pratiche, Halley', evaluator: 'duplicates' }, // allow-italian: fixture data, shown as written
  { id: 'c-invoice-amount', dimension: 'consistency', scope: 'programs', label: 'Importo della fattura uguale tra SdI, Topics e TeamSystem', where: 'Fatture', declaredPct: 99.6 }, // allow-italian: fixture data, shown as written
  { id: 'c-reread', dimension: 'currentness', scope: 'programs', label: 'Contribuente riletto da Prunes da meno di 24 ore', where: 'Contribuenti', declaredPct: 99.8 }, // allow-italian: fixture data, shown as written
  { id: 'c-outlier', dimension: 'currentness', scope: 'outliers', label: 'Importo entro il solito di quel fornitore', where: 'Fatture', declaredPct: 99.7 }, // allow-italian: fixture data, shown as written
  { id: 'c-confidence', dimension: 'credibility', scope: 'field', label: 'Valori letti dall\'AI con sicurezza di almeno 85, o confermati da una persona', where: 'Campi letti dai documenti', evaluator: 'confidence' }, // allow-italian: fixture data, shown as written
  { id: 'c-vat', dimension: 'credibility', scope: 'programs', label: 'IBAN e partita IVA confermati dall\'anagrafe dello SdI o dal fornitore via PEC', where: 'Fornitori', declaredPct: 98.9 }, // allow-italian: fixture data, shown as written
  { id: 'c-source', dimension: 'compliance', scope: 'field', label: 'Ogni valore letto ha il documento, la pagina e le parole da cui viene', where: 'Campi letti dai documenti', evaluator: 'source' }, // allow-italian: fixture data, shown as written
  { id: 'c-norm', dimension: 'compliance', scope: 'field', label: 'Ogni scadenza dice la norma che la fissa e come è calcolata', where: 'Scadenze', evaluator: 'norm' }, // allow-italian: fixture data, shown as written
];

/** Declared numbers of the whole organization, all examples or estimates. */
export const QUALITY_TOTALS = {
  rowsPerDay: 18402,
  autoCorrected: 34,
  /** Checks running in all, by scope; the list above is the part that weighs on the score. */
  checks: { field: 214, tables: 38, programs: 17, outliers: 12 } as Record<CheckScope, number>,
};

export interface OriginalSeed {
  title: string;
  tag: string;
  /** What the original is, in one line. */
  detail: string;
  rows: Array<{ label: string; value: string; flag?: boolean }>;
}

export interface QuarantineSeed {
  id: string;
  /** What was found, as the list names it. */
  title: string;
  dimension: DimensionId;
  /** Where it was found: «fattura 1201», «pratica 2409». */
  where: string;
  /** The case it belongs to, when the example cases have it. */
  caseId?: string;
  /** What happened, for the list. */
  summary: string;
  /** Why it was stopped, for the page. */
  headline: string;
  why: string;
  risk: string;
  office: 'ragioneria' | 'legale' | 'protocollo';
  /** ISO date-time the check stopped it. */
  at: string;
  left: OriginalSeed;
  right: OriginalSeed;
  /** What stays stopped. */
  held: { title: string; body: string };
  history: Array<{ what: string; at: string }>;
  /** `null` for an item that was settled before: it only shows what happened. */
  actions: null | {
    confirm: { label: string; confirmTitle: string; confirmBody: string; done: string };
    reject: { label: string; confirmTitle: string; confirmBody: string; done: string };
    ask: { label: string; subject: string; body: string; to: string; steps: [string, string, string]; done: string };
  };
  /** An item settled without a person: how. */
  settled?: { status: 'auto' | 'solved'; text: string };
  /** Who is told and who may unblock. */
  unblockers: Array<{ who: string; may: string }>;
}

export const QUARANTINE: QuarantineSeed[] = [
  {
    id: 'q-iban',
    title: 'Stesso IBAN, due fornitori', // allow-italian: fixture data, shown as written
    dimension: 'consistency',
    where: 'fattura 1201', // allow-italian: fixture data, shown as written
    summary: 'possibile frode o anagrafica doppia', // allow-italian: fixture data, shown as written
    headline: 'Due fornitori diversi con lo stesso IBAN', // allow-italian: fixture data, shown as written
    why: 'La fattura 1201 di Idraulica Sud srl chiede il pagamento sull\'IBAN già registrato per Pompe Campania snc. Le fatture precedenti di Idraulica Sud andavano su un altro IBAN. Il pagamento è fermo finché qualcuno non conferma.', // allow-italian: fixture data, shown as written
    risk: 'Un IBAN che cambia insieme a un fornitore diverso è il segnale più comune delle truffe sui pagamenti. Può anche essere una cessione del credito regolare, che però deve avere un atto notificato.', // allow-italian: fixture data, shown as written
    office: 'ragioneria',
    at: '2026-11-05T16:20:00+01:00',
    left: {
      title: 'Fattura precedente (esempio)', // allow-italian: fixture data, shown as written
      tag: 'Idraulica Sud srl', // allow-italian: fixture data, shown as written
      detail: 'Registrata a settembre, pagata', // allow-italian: fixture data, shown as written
      rows: [
        { label: 'Fornitore', value: 'Idraulica Sud srl' }, // allow-italian: fixture data, shown as written
        { label: 'Partita IVA', value: 'valida, attiva' }, // allow-italian: fixture data, shown as written
        { label: 'IBAN in fattura', value: 'IT…7781' }, // allow-italian: fixture data, shown as written
        { label: 'Fornitore dal', value: '2023' }, // allow-italian: fixture data, shown as written
        { label: 'Pagata il', value: '30/09/2026' }, // allow-italian: fixture data, shown as written
      ],
    },
    right: {
      title: 'Fattura 1201 (nuova)', // allow-italian: fixture data, shown as written
      tag: 'Idraulica Sud srl', // allow-italian: fixture data, shown as written
      detail: 'Arrivata dallo SdI ieri alle 16:18', // allow-italian: fixture data, shown as written
      rows: [
        { label: 'Fornitore', value: 'Idraulica Sud srl' }, // allow-italian: fixture data, shown as written
        { label: 'Partita IVA', value: 'valida, attiva' }, // allow-italian: fixture data, shown as written
        { label: 'IBAN in fattura', value: 'IT…3456', flag: true }, // allow-italian: fixture data, shown as written
        { label: 'Già registrato per', value: 'Pompe Campania snc (dal 2019)', flag: true }, // allow-italian: fixture data, shown as written
        { label: 'Legame con Pompe Campania', value: 'nessuno noto' }, // allow-italian: fixture data, shown as written
      ],
    },
    held: { title: 'Solo questo pagamento', body: 'Il resto del flusso fatture va avanti. La fattura è registrata, il mandato no.' }, // allow-italian: fixture data, shown as written
    history: [
      { what: 'Fattura arrivata dallo SdI', at: '2026-11-05T16:18:00+01:00' }, // allow-italian: fixture data, shown as written
      { what: 'Controllo di coerenza fallito', at: '2026-11-05T16:20:00+01:00' }, // allow-italian: fixture data, shown as written
      { what: 'Avvisato il responsabile della ragioneria su Teams', at: '2026-11-05T16:20:00+01:00' }, // allow-italian: fixture data, shown as written
    ],
    actions: {
      confirm: {
        label: 'Conferma il nuovo IBAN', // allow-italian: fixture data, shown as written
        confirmTitle: 'Confermare l\'IBAN IT…3456 per Idraulica Sud srl?', // allow-italian: fixture data, shown as written
        confirmBody: 'Il mandato di pagamento della fattura 1201 parte sul nuovo IBAN e l\'anagrafica del fornitore viene aggiornata. Scrivi il motivo: va nel Registro.', // allow-italian: fixture data, shown as written
        done: 'IBAN confermato: il pagamento della fattura 1201 è sbloccato.', // allow-italian: fixture data, shown as written
      },
      reject: {
        label: 'Respingi la fattura', // allow-italian: fixture data, shown as written
        confirmTitle: 'Respingere la fattura 1201?', // allow-italian: fixture data, shown as written
        confirmBody: 'La fattura torna al fornitore come rifiutata e il pagamento resta bloccato. L\'anagrafica non cambia.', // allow-italian: fixture data, shown as written
        done: 'Fattura 1201 respinta: pagamento bloccato.', // allow-italian: fixture data, shown as written
      },
      ask: {
        label: 'Chiedi conferma al fornitore via PEC', // allow-italian: fixture data, shown as written
        subject: 'Conferma dell\'IBAN per la fattura 1201', // allow-italian: fixture data, shown as written
        body: 'Gentile fornitore, la fattura 1201 indica un IBAN diverso da quello usato finora. Vi chiediamo di confermare le coordinate con una PEC firmata dal legale rappresentante, o di allegare l\'atto di cessione del credito.', // allow-italian: fixture data, shown as written
        to: 'PEC del fornitore dall\'anagrafica', // allow-italian: fixture data, shown as written
        steps: ['Prepara il messaggio', 'Firma e invia da PEC Aruba', 'Attende la ricevuta di consegna'], // allow-italian: fixture data, shown as written
        done: 'Richiesta inviata: il pagamento resta fermo finché il fornitore non risponde.', // allow-italian: fixture data, shown as written
      },
    },
    unblockers: [
      { who: 'Responsabile della ragioneria', may: 'sì, con motivo' }, // allow-italian: fixture data, shown as written
      { who: 'Robot e AI', may: 'mai' }, // allow-italian: fixture data, shown as written
    ],
  },
  {
    id: 'q-notifica-2409',
    title: 'Data di notifica nel futuro', // allow-italian: fixture data, shown as written
    dimension: 'accuracy',
    where: 'pratica 2409', // allow-italian: fixture data, shown as written
    caseId: '2409',
    summary: 'l\'AI ha letto 2027 invece di 2026 da una scansione', // allow-italian: fixture data, shown as written
    headline: 'La data di notifica è nel futuro', // allow-italian: fixture data, shown as written
    why: 'Dalla scansione dell\'atto l\'AI ha letto 14/10/2027, che è dopo oggi. Una notifica non può essere nel futuro, e da quella data decorrono i 60 giorni per costituirsi: se restasse così il termine sarebbe calcolato un anno dopo.', // allow-italian: fixture data, shown as written
    risk: 'Un termine di giudizio calcolato su una data sbagliata si vede quando è tardi. Per questo la data resta ferma e il termine non viene scritto finché una persona non la conferma.', // allow-italian: fixture data, shown as written
    office: 'legale',
    at: '2026-11-04T09:42:00+01:00',
    left: {
      title: 'Cosa ha letto l\'AI', // allow-italian: fixture data, shown as written
      tag: 'AI', // allow-italian: fixture data, shown as written
      detail: 'Dalla pagina 1 della scansione', // allow-italian: fixture data, shown as written
      rows: [
        { label: 'Notificato il', value: '14/10/2027', flag: true }, // allow-italian: fixture data, shown as written
        { label: 'Sicurezza della lettura', value: '61 su 100' }, // allow-italian: fixture data, shown as written
        { label: 'Costituirsi entro', value: 'non calcolata' }, // allow-italian: fixture data, shown as written
      ],
    },
    right: {
      title: 'Cosa dice l\'originale', // allow-italian: fixture data, shown as written
      tag: 'Scansione', // allow-italian: fixture data, shown as written
      detail: 'L\'ultima cifra dell\'anno è sbiadita', // allow-italian: fixture data, shown as written
      rows: [
        { label: 'Parole intorno', value: '«notificato in data 14 ottobre 202…»' }, // allow-italian: fixture data, shown as written
        { label: 'Data più probabile', value: '14/10/2026' }, // allow-italian: fixture data, shown as written
        { label: 'Costituirsi entro', value: '14/12/2026, se confermata' }, // allow-italian: fixture data, shown as written
      ],
    },
    held: { title: 'Solo la data di notifica', body: 'Il resto della pratica si può leggere; il termine di costituzione non è calcolato.' }, // allow-italian: fixture data, shown as written
    history: [
      { what: 'Scansione letta dal passo «Legge l\'atto»', at: '2026-11-04T09:41:00+01:00' }, // allow-italian: fixture data, shown as written
      { what: 'Controllo «non nel futuro» fallito', at: '2026-11-04T09:42:00+01:00' }, // allow-italian: fixture data, shown as written
      { what: 'Avvisato l\'ufficio legale', at: '2026-11-04T09:42:00+01:00' }, // allow-italian: fixture data, shown as written
    ],
    actions: {
      confirm: {
        label: 'Correggi in 14/10/2026', // allow-italian: fixture data, shown as written
        confirmTitle: 'Correggere la data di notifica in 14/10/2026?', // allow-italian: fixture data, shown as written
        confirmBody: 'Il termine di costituzione viene calcolato dalla data corretta. Il valore letto dall\'AI resta nel Registro. Scrivi il motivo.', // allow-italian: fixture data, shown as written
        done: 'Data corretta in 14/10/2026: il termine è stato calcolato.', // allow-italian: fixture data, shown as written
      },
      reject: {
        label: 'Scarta la lettura', // allow-italian: fixture data, shown as written
        confirmTitle: 'Scartare la data letta dall\'AI?', // allow-italian: fixture data, shown as written
        confirmBody: 'Il campo resta vuoto e torna in «Da fare» perché una persona lo scriva guardando l\'originale.', // allow-italian: fixture data, shown as written
        done: 'Lettura scartata: la data tocca a una persona.', // allow-italian: fixture data, shown as written
      },
      ask: {
        label: 'Chiedi all\'ufficio che l\'ha ricevuta', // allow-italian: fixture data, shown as written
        subject: 'Data di notifica dell\'atto della pratica 2409', // allow-italian: fixture data, shown as written
        body: 'La scansione ha l\'ultima cifra dell\'anno sbiadita. Potete confermare la data riportata sulla ricevuta di consegna della PEC?', // allow-italian: fixture data, shown as written
        to: 'Ufficio legale, via Teams', // allow-italian: fixture data, shown as written
        steps: ['Prepara il messaggio', 'Invia su Teams', 'Attende la risposta'], // allow-italian: fixture data, shown as written
        done: 'Richiesta mandata all\'ufficio legale: la data resta ferma.', // allow-italian: fixture data, shown as written
      },
    },
    unblockers: [
      { who: 'Ufficio legale', may: 'sì, con motivo' }, // allow-italian: fixture data, shown as written
      { who: 'Robot e AI', may: 'mai' }, // allow-italian: fixture data, shown as written
    ],
  },
  {
    id: 'q-importo-1203',
    title: 'Importo fuori dal solito', // allow-italian: fixture data, shown as written
    dimension: 'currentness',
    where: 'fattura 1203', // allow-italian: fixture data, shown as written
    summary: '10 volte la media di quel fornitore', // allow-italian: fixture data, shown as written
    headline: 'Un importo dieci volte più alto del solito', // allow-italian: fixture data, shown as written
    why: 'La fattura 1203 di Elettrica dell\'Agro srl è di 18.500 euro. Le ultime fatture dello stesso fornitore hanno una media di 1.850 euro. Può essere una fornitura straordinaria o uno zero di troppo.', // allow-italian: fixture data, shown as written
    risk: 'Un importo che sbaglia di un ordine di grandezza arriva fino al mandato di pagamento se nessuno lo guarda: il controllo lo ferma prima e chiede a una persona.', // allow-italian: fixture data, shown as written
    office: 'ragioneria',
    at: '2026-11-05T11:05:00+01:00',
    left: {
      title: 'Le ultime fatture (esempio)', // allow-italian: fixture data, shown as written
      tag: 'Elettrica dell\'Agro srl', // allow-italian: fixture data, shown as written
      detail: 'Media di 29 fatture dal 2021', // allow-italian: fixture data, shown as written
      rows: [
        { label: 'Media', value: '1.850 €' }, // allow-italian: fixture data, shown as written
        { label: 'Più alta', value: '3.240 €' }, // allow-italian: fixture data, shown as written
        { label: 'Ultima', value: '1.790 € a ottobre' }, // allow-italian: fixture data, shown as written
      ],
    },
    right: {
      title: 'Fattura 1203 (nuova)', // allow-italian: fixture data, shown as written
      tag: 'Elettrica dell\'Agro srl', // allow-italian: fixture data, shown as written
      detail: 'Arrivata dallo SdI ieri alle 11:03', // allow-italian: fixture data, shown as written
      rows: [
        { label: 'Importo', value: '18.500 €', flag: true }, // allow-italian: fixture data, shown as written
        { label: 'Rispetto alla media', value: '10 volte', flag: true }, // allow-italian: fixture data, shown as written
        { label: 'Ordine collegato', value: 'nessuno' }, // allow-italian: fixture data, shown as written
      ],
    },
    held: { title: 'Solo questo pagamento', body: 'La fattura è registrata; il mandato aspetta la conferma dell\'importo.' }, // allow-italian: fixture data, shown as written
    history: [
      { what: 'Fattura arrivata dallo SdI', at: '2026-11-05T11:03:00+01:00' }, // allow-italian: fixture data, shown as written
      { what: 'Controllo «importo nel solito» fallito', at: '2026-11-05T11:05:00+01:00' }, // allow-italian: fixture data, shown as written
      { what: 'Avvisato il responsabile della ragioneria su Teams', at: '2026-11-05T11:05:00+01:00' }, // allow-italian: fixture data, shown as written
    ],
    actions: {
      confirm: {
        label: 'Conferma l\'importo', // allow-italian: fixture data, shown as written
        confirmTitle: 'Confermare l\'importo di 18.500 €?', // allow-italian: fixture data, shown as written
        confirmBody: 'Il mandato di pagamento può partire. L\'importo fuori dal solito resta scritto nel Registro con il tuo motivo.', // allow-italian: fixture data, shown as written
        done: 'Importo confermato: il pagamento della fattura 1203 è sbloccato.', // allow-italian: fixture data, shown as written
      },
      reject: {
        label: 'Respingi la fattura', // allow-italian: fixture data, shown as written
        confirmTitle: 'Respingere la fattura 1203?', // allow-italian: fixture data, shown as written
        confirmBody: 'La fattura torna al fornitore come rifiutata, con la richiesta di una nota di credito.', // allow-italian: fixture data, shown as written
        done: 'Fattura 1203 respinta: richiesta la nota di credito.', // allow-italian: fixture data, shown as written
      },
      ask: {
        label: 'Chiedi conferma al fornitore via PEC', // allow-italian: fixture data, shown as written
        subject: 'Conferma dell\'importo della fattura 1203', // allow-italian: fixture data, shown as written
        body: 'Gentile fornitore, la fattura 1203 è di 18.500 euro, molto sopra le vostre fatture abituali. Potete confermare l\'importo o inviare una nota di credito?', // allow-italian: fixture data, shown as written
        to: 'PEC del fornitore dall\'anagrafica', // allow-italian: fixture data, shown as written
        steps: ['Prepara il messaggio', 'Firma e invia da PEC Aruba', 'Attende la ricevuta di consegna'], // allow-italian: fixture data, shown as written
        done: 'Richiesta inviata: il pagamento resta fermo finché il fornitore non risponde.', // allow-italian: fixture data, shown as written
      },
    },
    unblockers: [
      { who: 'Responsabile della ragioneria', may: 'sì, con motivo' }, // allow-italian: fixture data, shown as written
      { who: 'Robot e AI', may: 'mai' }, // allow-italian: fixture data, shown as written
    ],
  },
  {
    id: 'q-piva-1190',
    title: 'Partita IVA con cifra sbagliata', // allow-italian: fixture data, shown as written
    dimension: 'accuracy',
    where: 'fattura 1190', // allow-italian: fixture data, shown as written
    summary: 'corretta dall\'anagrafica dello SdI, fonte certa', // allow-italian: fixture data, shown as written
    headline: 'Una cifra sbagliata nella partita IVA, corretta da sola', // allow-italian: fixture data, shown as written
    why: 'La partita IVA scritta in fattura non passava il controllo della cifra finale. L\'anagrafica dello SdI ha il valore giusto: è una fonte certa, quindi il sistema lo ha scritto da solo e ha lasciato il valore di prima nel Registro.', // allow-italian: fixture data, shown as written
    risk: 'Le correzioni automatiche sono ammesse solo da una fonte certa (SdI, Prunes, IPA), e sempre con il valore di prima.', // allow-italian: fixture data, shown as written
    office: 'ragioneria',
    at: '2026-11-03T15:12:00+01:00',
    left: {
      title: 'Prima', // allow-italian: fixture data, shown as written
      tag: 'Fattura', // allow-italian: fixture data, shown as written
      detail: 'Come arrivata', // allow-italian: fixture data, shown as written
      rows: [{ label: 'Partita IVA', value: 'cifra finale non valida', flag: true }], // allow-italian: fixture data, shown as written
    },
    right: {
      title: 'Dopo', // allow-italian: fixture data, shown as written
      tag: 'Anagrafe dello SdI', // allow-italian: fixture data, shown as written
      detail: 'Fonte certa', // allow-italian: fixture data, shown as written
      rows: [{ label: 'Partita IVA', value: 'valida, attiva' }], // allow-italian: fixture data, shown as written
    },
    held: { title: 'Niente è fermo', body: 'La fattura è andata avanti con il valore corretto.' }, // allow-italian: fixture data, shown as written
    history: [
      { what: 'Fattura arrivata dallo SdI', at: '2026-11-03T15:10:00+01:00' }, // allow-italian: fixture data, shown as written
      { what: 'Controllo della cifra fallito', at: '2026-11-03T15:11:00+01:00' }, // allow-italian: fixture data, shown as written
      { what: 'Corretta dall\'anagrafica dello SdI', at: '2026-11-03T15:12:00+01:00' }, // allow-italian: fixture data, shown as written
    ],
    actions: null,
    settled: { status: 'auto', text: 'corretta da sola' }, // allow-italian: fixture data, shown as written
    unblockers: [{ who: 'Robot e AI', may: 'solo da fonte certa' }], // allow-italian: fixture data, shown as written
  },
  {
    id: 'q-pec-2398',
    title: 'Doppia PEC dallo stesso mittente', // allow-italian: fixture data, shown as written
    dimension: 'consistency',
    where: 'pratica 2398', // allow-italian: fixture data, shown as written
    caseId: '2398',
    summary: 'stesso documento inviato due volte: collegata, un solo protocollo', // allow-italian: fixture data, shown as written
    headline: 'La stessa PEC è arrivata due volte', // allow-italian: fixture data, shown as written
    why: 'Il secondo messaggio ha lo stesso mittente, lo stesso oggetto e lo stesso allegato del primo. È stato collegato alla pratica esistente e non ha avuto un nuovo numero di protocollo.', // allow-italian: fixture data, shown as written
    risk: 'Un doppione protocollato due volte crea due pratiche per lo stesso atto e due termini da seguire.', // allow-italian: fixture data, shown as written
    office: 'protocollo',
    at: '2026-11-02T08:30:00+01:00',
    left: {
      title: 'Primo messaggio', // allow-italian: fixture data, shown as written
      tag: 'PEC', // allow-italian: fixture data, shown as written
      detail: 'Protocollato', // allow-italian: fixture data, shown as written
      rows: [{ label: 'Allegato', value: 'stesso file, stessa impronta' }], // allow-italian: fixture data, shown as written
    },
    right: {
      title: 'Secondo messaggio', // allow-italian: fixture data, shown as written
      tag: 'PEC', // allow-italian: fixture data, shown as written
      detail: 'Collegato al primo', // allow-italian: fixture data, shown as written
      rows: [{ label: 'Allegato', value: 'stesso file, stessa impronta' }], // allow-italian: fixture data, shown as written
    },
    held: { title: 'Niente è fermo', body: 'Un solo protocollo, una sola pratica.' }, // allow-italian: fixture data, shown as written
    history: [
      { what: 'Seconda PEC arrivata', at: '2026-11-02T08:29:00+01:00' }, // allow-italian: fixture data, shown as written
      { what: 'Controllo dei doppioni: trovato', at: '2026-11-02T08:30:00+01:00' }, // allow-italian: fixture data, shown as written
      { what: 'Collegata alla pratica, nessun nuovo protocollo', at: '2026-11-02T08:30:00+01:00' }, // allow-italian: fixture data, shown as written
    ],
    actions: null,
    settled: { status: 'solved', text: 'risolta' }, // allow-italian: fixture data, shown as written
    unblockers: [{ who: 'Protocollo', may: 'sì' }], // allow-italian: fixture data, shown as written
  },
];

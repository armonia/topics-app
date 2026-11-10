/**
 * The flows of the Consorzio edition: what starts them, their steps, who does
 * each step and the column of the kanban a card at that step stands in. The
 * nine flows are the ones of the plan (PEC e protocollo, Fatture passive,
 * Turni irrigui, Segnalazioni dal territorio, Concessioni idrauliche, Polizia allow-italian: quotes the words on screen
 * idraulica, Contributi e sgravi, Personale, Contratti, gare e incarichi); the
 * steps are taken from the flows already written for the old preview
 * (`../org/flows.ts`) and rearranged into the five columns. Every flow has a
 * step in each of the five columns, so a card can stand in any of them.
 *
 * Volumes per month are estimates, the same ones the old preview printed
 * (PEC 1.204, invoices 204, irrigation 388, reports 64, concessions 10,
 * police 6, staff 105, tenders 9); the one new flow, Contributi e sgravi, is an
 * estimate too. The screens say «stima».
 *
 * Agents prepare and check; a person verifies, approves and signs.
 */
import type { OpsFlow, OpsFlowStep, StageId } from '../sarim-org/types';
import { CERTIFIED_MAIL_FLOW } from '../flows';
import type { FlowSplitDef, FlowSplitLane } from '../world-types';

const rule: OpsFlowStep['actor'] = { kind: 'rule' };
const agent = (id: string): OpsFlowStep['actor'] => ({ kind: 'agent', id });
const person = (id: string): OpsFlowStep['actor'] => ({ kind: 'person', id });
const program = (name: string): OpsFlowStep['actor'] => ({ kind: 'program', name });
const step = (id: string, stage: StageId, actor: OpsFlowStep['actor'], title: string): OpsFlowStep => ({ id, title, actor, stage });

export const NOCERA_OPS_FLOWS: OpsFlow[] = [
  {
    id: 'nocera-pec', name: 'PEC da protocollare', outcome: 'PEC protocollata e assegnata al team', area: 'protocollo', // allow-italian: fixture data, shown as written
    source: 'PEC sulla casella protocollo, da PEC Aruba', agent: 'ag-pec', stuckAfterHours: 24, // allow-italian: fixture data, shown as written
    trigger: 'arriva una PEC sulla casella protocollo', status: 'attivo', version: 4, perMonth: 1204, // allow-italian: fixture data, shown as written
    programs: ['PEC Aruba', 'Prunes', 'Halley'],
    steps: [
      step('s1', 'arrivo', agent('ag-pec'), 'Legge la PEC e gli allegati: mittente, oggetto, firme e ricevuta di consegna'), // allow-italian: fixture data, shown as written
      step('s2', 'lavorazione', agent('ag-pec'), 'Riconosce il tipo di PEC e propone il team e la voce del titolario'), // allow-italian: fixture data, shown as written
      step('s3', 'lavorazione', program('Prunes'), "Trova il contribuente e l'avviso contestato nel catasto consortile"), // allow-italian: fixture data, shown as written
      step('s4', 'lavorazione', rule, 'Calcola le scadenze: 60 giorni per costituirsi in giudizio, 30 per un accesso agli atti'), // allow-italian: fixture data, shown as written
      step('s5', 'verifica', person('cn-protocollo'), 'Il Protocollo verifica il tipo, il team e la scadenza'), // allow-italian: fixture data, shown as written
      step('s6', 'verifica', person('cn-legale'), "L'avvocato interno verifica ricorsi e atti giudiziari: parti, corte, termini"), // allow-italian: fixture data, shown as written
      step('s7', 'approvazione', person('cn-dg'), "La direzione approva l'incarico al legale o la risposta firmata"), // allow-italian: fixture data, shown as written
      step('s8', 'fatto', program('Halley'), "Protocolla in Halley, apre il fascicolo e assegna l'atto al team"), // allow-italian: fixture data, shown as written
    ],
  },
  {
    id: 'nocera-fatture', name: 'Fattura passiva', outcome: 'pagamento', area: 'ragioneria', // allow-italian: fixture data, shown as written
    source: 'fatture elettroniche dei fornitori, dallo SdI', agent: 'ag-fatture', stuckAfterHours: 48, // allow-italian: fixture data, shown as written
    trigger: 'arriva una fattura dallo SdI', status: 'attivo', version: 2, perMonth: 204, // allow-italian: fixture data, shown as written
    programs: ['TeamSystem'],
    steps: [
      step('s1', 'arrivo', agent('ag-fatture'), 'Legge la fattura elettronica: fornitore, righe, imponibile e IVA'), // allow-italian: fixture data, shown as written
      step('s2', 'lavorazione', rule, 'Verifica IVA, split payment, CIG e fornitore'), // allow-italian: fixture data, shown as written
      step('s3', 'lavorazione', agent('ag-fatture'), 'Abbina fattura, ordine e determina di impegno'), // allow-italian: fixture data, shown as written
      step('s4', 'lavorazione', rule, 'Fissa la scadenza a 30 giorni dal ricevimento'), // allow-italian: fixture data, shown as written
      step('s5', 'verifica', person('cn-ragioneria'), 'La Ragioneria verifica le differenze e risponde allo SdI: accettata o rifiutata'), // allow-italian: fixture data, shown as written
      step('s6', 'approvazione', person('cn-dg'), "Il dirigente dà il visto, a seconda dell'importo"), // allow-italian: fixture data, shown as written
      step('s7', 'fatto', program('TeamSystem'), 'Registra la liquidazione in TeamSystem e prepara il mandato di pagamento'), // allow-italian: fixture data, shown as written
    ],
  },
  {
    id: 'nocera-irrigazione', name: 'Turno irriguo', outcome: 'turno assegnato', area: 'irrigazione', // allow-italian: fixture data, shown as written
    source: 'richieste dal modulo sul sito dell\'ente', agent: 'ag-irrigazione', stuckAfterHours: 24, // allow-italian: fixture data, shown as written
    trigger: 'arriva una richiesta di turno dal modulo sul sito', status: 'attivo', version: 1, perMonth: 388, // allow-italian: fixture data, shown as written
    programs: ['Prunes'],
    steps: [
      step('s1', 'arrivo', agent('ag-irrigazione'), 'Legge la richiesta: bacino, particella, coltura e giorni richiesti'), // allow-italian: fixture data, shown as written
      step('s2', 'lavorazione', program('Prunes'), 'Verifica bacino e particella nel catasto consortile'), // allow-italian: fixture data, shown as written
      step('s3', 'lavorazione', rule, 'Cerca turni già assegnati nello stesso bacino negli stessi giorni'), // allow-italian: fixture data, shown as written
      step('s4', 'lavorazione', agent('ag-irrigazione'), 'Propone giorno e ora del turno'), // allow-italian: fixture data, shown as written
      step('s5', 'verifica', person('cn-irrigazione'), 'Il tecnico del bacino verifica la proposta'), // allow-italian: fixture data, shown as written
      step('s6', 'approvazione', person('cn-dg'), 'La direzione approva i turni fuori calendario'), // allow-italian: fixture data, shown as written
      step('s7', 'fatto', rule, 'Aggiorna il calendario dei turni e avvisa chi ha chiesto il turno'), // allow-italian: fixture data, shown as written
    ],
  },
  {
    id: 'nocera-segnalazioni', name: 'Segnalazione dal territorio', outcome: 'intervento', area: 'tecnica', // allow-italian: fixture data, shown as written
    source: 'WhatsApp, telefono e mail di cittadini e comuni', agent: 'ag-segnalazioni', stuckAfterHours: 12, // allow-italian: fixture data, shown as written
    trigger: 'arriva una segnalazione (WhatsApp, telefono, mail)', status: 'attivo', version: 1, perMonth: 64, // allow-italian: fixture data, shown as written
    programs: ['QGIS'],
    steps: [
      step('s1', 'arrivo', agent('ag-segnalazioni'), 'Legge la segnalazione: luogo, canale e tipo di problema (ostruzione, allagamento, rifiuti)'), // allow-italian: fixture data, shown as written
      step('s2', 'lavorazione', rule, 'Cerca segnalazioni già aperte sullo stesso canale'), // allow-italian: fixture data, shown as written
      step('s3', 'lavorazione', program('QGIS'), 'Localizza il canale e il tratto sulla mappa del reticolo'), // allow-italian: fixture data, shown as written
      step('s4', 'lavorazione', agent('ag-segnalazioni'), 'Propone la squadra e la priorità del sopralluogo'), // allow-italian: fixture data, shown as written
      step('s5', 'verifica', person('cn-tecnico'), "Il responsabile tecnico verifica la segnalazione e l'urgenza"), // allow-italian: fixture data, shown as written
      step('s6', 'approvazione', person('cn-dg'), 'La direzione approva gli interventi fuori programma'), // allow-italian: fixture data, shown as written
      step('s7', 'fatto', person('cn-tecnico'), 'La squadra interviene, il Tecnico risponde a chi ha segnalato e chiude'), // allow-italian: fixture data, shown as written
    ],
  },
  {
    id: 'nocera-concessioni', name: 'Concessione idraulica', outcome: 'concessione o autorizzazione', area: 'tecnica', // allow-italian: fixture data, shown as written
    source: 'richieste di attraversamento o scarico in un canale consortile', agent: 'ag-concessioni', stuckAfterHours: 72, // allow-italian: fixture data, shown as written
    trigger: 'arriva una richiesta di attraversamento o scarico', status: 'collaudo', version: 1, perMonth: 10, // allow-italian: fixture data, shown as written
    programs: ['PEC Aruba', 'Prunes', 'QGIS', 'AutoCAD', 'Halley'],
    steps: [
      step('s1', 'arrivo', agent('ag-concessioni'), 'Legge la richiesta: opera, canale, comune e richiedente'), // allow-italian: fixture data, shown as written
      step('s2', 'lavorazione', program('Prunes'), 'Verifica proprietà e particella nel catasto consortile'), // allow-italian: fixture data, shown as written
      step('s3', 'lavorazione', program('QGIS'), 'Mostra il tracciato sulla mappa e la distanza dal canale'), // allow-italian: fixture data, shown as written
      step('s4', 'lavorazione', program('AutoCAD'), "Legge le tavole DWG dell'opera e chiede l'integrazione se manca qualcosa"), // allow-italian: fixture data, shown as written
      step('s5', 'lavorazione', agent('ag-concessioni'), 'Prepara il disciplinare e calcola il canone'), // allow-italian: fixture data, shown as written
      step('s6', 'verifica', person('cn-tecnico'), 'Il responsabile tecnico fa il sopralluogo e dà il parere'), // allow-italian: fixture data, shown as written
      step('s7', 'approvazione', person('cn-dg'), 'La direzione firma la concessione'), // allow-italian: fixture data, shown as written
      step('s8', 'fatto', program('PEC Aruba'), 'Invia la concessione via PEC e la protocolla in Halley'), // allow-italian: fixture data, shown as written
    ],
  },
  {
    id: 'nocera-polizia', name: 'Polizia idraulica', outcome: 'verbale notificato', area: 'polizia', // allow-italian: fixture data, shown as written
    source: "verbali dell'ufficiale idraulico e del sorvegliante", agent: 'ag-polizia', stuckAfterHours: 72, // allow-italian: fixture data, shown as written
    trigger: "arriva il verbale dell'ufficiale idraulico", status: 'collaudo', version: 1, perMonth: 6, // allow-italian: fixture data, shown as written
    programs: ['QGIS', 'Halley', 'SEND'],
    steps: [
      step('s1', 'arrivo', agent('ag-polizia'), 'Legge il verbale: luogo, violazione, norma violata e soggetto'), // allow-italian: fixture data, shown as written
      step('s2', 'lavorazione', program('QGIS'), "Localizza l'opera o il tratto sul reticolo e sulla fascia di rispetto"), // allow-italian: fixture data, shown as written
      step('s3', 'lavorazione', program('Halley'), 'Protocolla il verbale e apre il fascicolo'), // allow-italian: fixture data, shown as written
      step('s4', 'lavorazione', agent('ag-polizia'), 'Prepara la notifica e calcola i 30 giorni per gli scritti difensivi'), // allow-italian: fixture data, shown as written
      step('s5', 'verifica', person('cn-polizia'), "L'ufficiale idraulico verifica il verbale e la notifica"), // allow-italian: fixture data, shown as written
      step('s6', 'verifica', person('cn-legale'), 'Il Legale verifica la norma e la sanzione'), // allow-italian: fixture data, shown as written
      step('s7', 'approvazione', person('cn-dg'), 'La direzione firma la notifica'), // allow-italian: fixture data, shown as written
      step('s8', 'fatto', program('SEND'), 'Notifica il verbale via SEND e segna la data di perfezionamento'), // allow-italian: fixture data, shown as written
    ],
  },
  {
    id: 'nocera-contributi', name: 'Istanza di sgravio', outcome: 'sgravio, rimborso o diniego', area: 'catasto', // allow-italian: fixture data, shown as written
    source: 'istanze di sgravio o rimborso dei contributi consortili', agent: 'ag-contributi', stuckAfterHours: 72, // allow-italian: fixture data, shown as written
    trigger: "arriva un'istanza di sgravio o di rimborso", status: 'collaudo', version: 1, perMonth: 38, // allow-italian: fixture data, shown as written
    programs: ['Prunes', 'Microsoft 365', 'SEND', 'TeamSystem'],
    steps: [
      step('s1', 'arrivo', agent('ag-contributi'), "Legge l'istanza: contribuente, tributo, anno e richiesta"), // allow-italian: fixture data, shown as written
      step('s2', 'lavorazione', program('Prunes'), 'Trova il contribuente, i suoi immobili e gli avvisi emessi'), // allow-italian: fixture data, shown as written
      step('s3', 'lavorazione', rule, 'Calcola il termine di risposta'), // allow-italian: fixture data, shown as written
      step('s4', 'lavorazione', agent('ag-contributi'), 'Prepara il conteggio e la bozza del provvedimento'), // allow-italian: fixture data, shown as written
      step('s5', 'verifica', person('cn-catasto'), "Il Catasto e ruoli verifica l'istruttoria e il conteggio"), // allow-italian: fixture data, shown as written
      step('s6', 'approvazione', person('cn-dg'), 'La direzione firma il provvedimento di sgravio, rimborso o diniego'), // allow-italian: fixture data, shown as written
      step('s7', 'fatto', program('SEND'), "Notifica il provvedimento via SEND e, per un rimborso, passa l'ordine di pagamento alla Ragioneria"), // allow-italian: fixture data, shown as written
    ],
  },
  {
    id: 'nocera-personale', name: 'Scadenza del personale', outcome: 'rinnovo, proroga o chiusura', area: 'personale', // allow-italian: fixture data, shown as written
    source: 'contratti a termine, visite mediche e certificati da Publisys', agent: 'ag-personale', stuckAfterHours: 24, // allow-italian: fixture data, shown as written
    trigger: 'ogni giorno alle 7', status: 'attivo', version: 1, perMonth: 105, // allow-italian: fixture data, shown as written
    programs: ['Publisys', 'Microsoft 365'],
    steps: [
      step('s1', 'arrivo', program('Publisys'), 'Ogni giorno alle 7 legge contratti a termine, visite e certificati'), // allow-italian: fixture data, shown as written
      step('s2', 'lavorazione', rule, 'Trova quelli che scadono entro 30 giorni'), // allow-italian: fixture data, shown as written
      step('s3', 'lavorazione', agent('ag-personale'), 'Prepara la scheda di ogni scadenza e la bozza di lettera'), // allow-italian: fixture data, shown as written
      step('s4', 'verifica', person('cn-personale'), 'Il Personale decide: rinnovo, proroga o chiusura'), // allow-italian: fixture data, shown as written
      step('s5', 'approvazione', person('cn-dg'), 'La direzione approva rinnovi e proroghe'), // allow-italian: fixture data, shown as written
      step('s6', 'fatto', person('cn-personale'), 'Il Personale consegna la lettera e invia la comunicazione obbligatoria'), // allow-italian: fixture data, shown as written
    ],
  },
  {
    id: 'nocera-contratti', name: 'Contratti, gare e incarichi', outcome: 'determina e scadenze', area: 'legale', // allow-italian: fixture data, shown as written
    source: 'capitolati, bandi, accordi quadro e richieste di incarico a un legale', agent: 'ag-contratti', stuckAfterHours: 72, // allow-italian: fixture data, shown as written
    trigger: "si apre una gara, un accordo quadro o un incarico", status: 'attivo', version: 1, perMonth: 9, // allow-italian: fixture data, shown as written
    programs: ['Traspare', 'PA Legal', 'Microsoft 365', 'Halley'],
    steps: [
      step('s1', 'arrivo', agent('ag-contratti'), 'Legge il capitolato, il bando o la richiesta di incarico'), // allow-italian: fixture data, shown as written
      step('s2', 'lavorazione', agent('ag-contratti'), 'Estrae oggetto, importo, CIG e requisiti'), // allow-italian: fixture data, shown as written
      step('s3', 'lavorazione', rule, 'Verifica il CIG e la soglia della procedura'), // allow-italian: fixture data, shown as written
      step('s4', 'lavorazione', program('Traspare'), 'Apre la procedura sulla piattaforma di gara'), // allow-italian: fixture data, shown as written
      step('s5', 'lavorazione', agent('ag-contratti'), 'Prepara la bozza di determina'), // allow-italian: fixture data, shown as written
      step('s6', 'verifica', person('cn-tecnico'), 'Il responsabile del procedimento verifica i requisiti'), // allow-italian: fixture data, shown as written
      step('s7', 'verifica', person('cn-legale'), "L'avvocato interno verifica la determina"), // allow-italian: fixture data, shown as written
      step('s8', 'approvazione', person('cn-dg'), 'La direzione firma la determina'), // allow-italian: fixture data, shown as written
      step('s9', 'fatto', program('Halley'), "Protocolla la determina, la pubblica all'albo e fissa le scadenze"), // allow-italian: fixture data, shown as written
    ],
  },
];

/**
 * Where the PEC flow splits by type. Step 3 (finding who and what the PEC is
 * about) is the one each type of PEC does its own way: the lanes are the seven
 * paths of the PEC flow already drawn for the old preview
 * (`CERTIFIED_MAIL_FLOW`, `../flows.ts`), cut to the steps before the
 * deadlines are computed (step 4) and the Protocollo checks (step 5), which
 * the flow does once for every type. Two paths start another flow; two have
 * no steps of their own. Volumes and offices are the paths' own; the count of
 * steps is dropped from their line, since it counted steps the flow now draws
 * once.
 */
const lanePath = (id: string, keep: string[], extra: Partial<FlowSplitLane> = {}): FlowSplitLane => {
  const path = CERTIFIED_MAIL_FLOW.branch.paths.find((p) => p.id === id);
  if (!path) throw new Error(`PEC path ${id} is missing from ../flows.ts`);
  return { ...path, expanded: true, meta: path.meta.replace(/ · \d+ passi/, '').replace(/ al mese(?!, stima)/, ' al mese, stima'), steps: path.steps?.filter((s) => keep.includes(s.id)) ?? [], ...extra }; // allow-italian: matches the fixture's own words
};

export const NOCERA_SPLITS: FlowSplitDef[] = [
  {
    flow: 'nocera-pec', step: 's3', by: 'tipo di PEC', agent: 'ag-pec', // allow-italian: fixture data, shown as written
    lanes: [
      lanePath('pA', ['a', 'b'], { at: 'b' }),
      lanePath('pB', ['b1', 'b2'], { at: 'b2' }),
      lanePath('pC', ['c1', 'c2']),
      lanePath('pD', [], { handoff: 'avvia «Turno irriguo» o «Segnalazione dal territorio»', meta: '140 al mese, stima' }), // allow-italian: fixture data, shown as written
      lanePath('pE', [], { handoff: 'avvia «Fattura passiva»', meta: '31 al mese, stima' }), // allow-italian: fixture data, shown as written
      lanePath('pF', ['f1', 'f3']),
      lanePath('pG', []),
    ],
  },
];

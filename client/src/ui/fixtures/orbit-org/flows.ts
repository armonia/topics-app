/**
 * The flows of the ORBIT edition: what starts them, their steps, who does each
 * step and the column of the kanban a card at that step stands in.
 *
 * The first six are the flows the multi-organization edition already lists in
 * `../orbit.ts`: their name, trigger, version and monthly volume are read from
 * there, so the two editions cannot print different numbers for the same flow.
 * `orbit-turni` and `orbit-varianti` exist only here. Every flow has a step in
 * each of the five columns, so a card can stand in any of them.
 *
 * Agents prepare and check; a person verifies, approves and signs.
 */
import { REPORTS_PATHS, ORBIT_FLOWS } from '../orbit';
import type { FlowSplitDef, FlowSplitLane } from '../world-types';
import type { OpsFlow, OpsFlowStep, StageId } from './types';

/** Name, trigger, version and volume of a flow the other edition already lists, written once in `../orbit.ts`. */
function catalogue(id: string): Pick<OpsFlow, 'id' | 'name' | 'outcome' | 'trigger' | 'version' | 'perMonth'> {
  const seed = ORBIT_FLOWS.find((f) => f.id === id);
  if (!seed) throw new Error(`ORBIT flow ${id} is missing from the catalogue of ../orbit.ts`);
  /* The other edition writes «name → outcome»; here the name is the short part everywhere and the outcome a subtitle. */
  const [name, outcome] = seed.name.split(' → ');
  return { id, name, outcome, trigger: seed.trigger, version: seed.version, perMonth: seed.perMonth };
}

const rule: OpsFlowStep['actor'] = { kind: 'rule' };
const agent = (id: string): OpsFlowStep['actor'] => ({ kind: 'agent', id });
const person = (id: string): OpsFlowStep['actor'] => ({ kind: 'person', id });
const program = (name: string): OpsFlowStep['actor'] => ({ kind: 'program', name });
const step = (id: string, stage: StageId, actor: OpsFlowStep['actor'], title: string): OpsFlowStep => ({ id, title, actor, stage });

export const ORBIT_OPS_FLOWS: OpsFlow[] = [
  {
    ...catalogue('orbit-segnalazioni'), area: 'customer', source: 'mail AMA, numero verde, app Orbit Ambiente, portale utenze ed Enviro', agent: 'ag-segnalazioni', stuckAfterHours: 4, // allow-italian: fixture data, shown as written
    status: 'attivo', // allow-italian: status code of the data, not shown
    programs: ['Posta e PEC', 'SAP', 'WinWaste'],
    steps: [
      step('s1', 'arrivo', agent('ag-segnalazioni'), 'Legge la segnalazione: indirizzo, tipo di rifiuto, urgenza'), // allow-italian: fixture data, shown as written
      step('s2', 'lavorazione', rule, 'Cerca doppioni negli ultimi 7 giorni, stesso indirizzo entro 50 metri'), // allow-italian: fixture data, shown as written
      step('s3', 'lavorazione', agent('ag-segnalazioni'), 'Propone turno e mezzo del cantiere di zona'), // allow-italian: fixture data, shown as written
      step('s4', 'lavorazione', person('orbit-callcenter'), 'Il call center richiama chi ha segnalato se mancano dati o foto'), // allow-italian: fixture data, shown as written
      step('s5', 'verifica', person('orbit-callcenter'), 'Il call center verifica la proposta e la conferma'), // allow-italian: fixture data, shown as written
      step('s6', 'approvazione', person('orbit-tecnico'), 'Il responsabile tecnico approva gli interventi fuori giro'), // allow-italian: fixture data, shown as written
      step('s7', 'fatto', program('SAP'), "Ordine di servizio aperto in SAP, giro in WinWaste, avviso a chi ha segnalato"), // allow-italian: fixture data, shown as written
    ],
  },
  {
    ...catalogue('orbit-foglie'), area: 'customer', source: 'passaggi del mese raccolti da WinWaste', agent: 'ag-segnalazioni', stuckAfterHours: 24, // allow-italian: fixture data, shown as written
    status: 'attivo', // allow-italian: status code of the data, not shown
    programs: ['WinWaste', 'Excel'],
    steps: [
      step('s1', 'arrivo', program('WinWaste'), 'Raccoglie i passaggi del mese'), // allow-italian: fixture data, shown as written
      step('s2', 'lavorazione', agent('ag-segnalazioni'), 'Compone il rendiconto per zona e lo confronta con i passaggi previsti'), // allow-italian: fixture data, shown as written
      step('s3', 'verifica', person('orbit-callcenter'), 'Il call center verifica le zone con passaggi mancanti'), // allow-italian: fixture data, shown as written
      step('s4', 'approvazione', person('orbit-tecnico'), 'Il responsabile tecnico approva il rendiconto'), // allow-italian: fixture data, shown as written
      step('s5', 'fatto', person('orbit-callcenter'), 'Il call center lo invia ad AMA e lo archivia'), // allow-italian: fixture data, shown as written
    ],
  },
  {
    ...catalogue('orbit-fir'), area: 'customer', source: 'formulari dei ritiri chiusi, da Enviro e dalle foto degli autisti', agent: 'ag-fir', stuckAfterHours: 24, // allow-italian: fixture data, shown as written
    status: 'attivo', // allow-italian: status code of the data, not shown
    programs: ['Enviro', 'RENTRI'],
    steps: [
      step('s1', 'arrivo', agent('ag-fir'), 'Legge il formulario: codice EER, pesi, targa, destinatario'), // allow-italian: fixture data, shown as written
      step('s2', 'lavorazione', person('orbit-callcenter'), "Se manca il peso a destino, il customer service lo chiede all'impianto o all'autista"), // allow-italian: fixture data, shown as written
      step('s3', 'lavorazione', rule, 'Confronta il peso a destino con la stima alla partenza'), // allow-italian: fixture data, shown as written
      step('s4', 'lavorazione', agent('ag-fir'), 'Prepara la registrazione di carico e scarico per RENTRI'), // allow-italian: fixture data, shown as written
      step('s5', 'verifica', person('orbit-callcenter'), 'Il customer service verifica codici e pesi'), // allow-italian: fixture data, shown as written
      step('s6', 'approvazione', person('orbit-tecnico'), 'Il responsabile tecnico firma la registrazione'), // allow-italian: fixture data, shown as written
      step('s7', 'fatto', program('RENTRI'), 'Registrazione trasmessa a RENTRI e formulario archiviato'), // allow-italian: fixture data, shown as written
    ],
  },
  {
    ...catalogue('orbit-fatture'), area: 'contabilita', source: 'fatture elettroniche dei fornitori, dallo SDI e dalla PEC', agent: 'ag-fatture', stuckAfterHours: 48, // allow-italian: fixture data, shown as written
    status: 'attivo', // allow-italian: status code of the data, not shown
    programs: ['Posta e PEC', 'Excel'],
    steps: [
      step('s1', 'arrivo', agent('ag-fatture'), 'Legge la fattura elettronica: fornitore, righe, imponibile e IVA'), // allow-italian: fixture data, shown as written
      step('s2', 'lavorazione', agent('ag-fatture'), 'Abbina fattura, ordine o contratto e bolla di consegna'), // allow-italian: fixture data, shown as written
      step('s3', 'lavorazione', rule, 'Confronta prezzi e quantità con ordine e contratto'), // allow-italian: fixture data, shown as written
      step('s4', 'lavorazione', person('orbit-contabilita'), 'La contabilità chiede i documenti che mancano'), // allow-italian: fixture data, shown as written
      step('s5', 'verifica', person('orbit-contabilita'), 'La contabilità verifica le differenze'), // allow-italian: fixture data, shown as written
      step('s6', 'approvazione', person('orbit-dg'), 'La direzione approva il pagamento con differenze o trattenute'), // allow-italian: fixture data, shown as written
      step('s7', 'fatto', agent('ag-fatture'), 'Abbina il pagamento al movimento in banca e chiude la riconciliazione'), // allow-italian: fixture data, shown as written
    ],
  },
  {
    ...catalogue('orbit-gara'), area: 'legale', source: 'bandi e disciplinari dai portali gare', agent: 'ag-gare', stuckAfterHours: 48, // allow-italian: fixture data, shown as written
    status: 'attivo', // allow-italian: status code of the data, not shown
    programs: ['Portali gare / Innova', 'Word'],
    steps: [
      step('s1', 'arrivo', agent('ag-gare'), 'Trova la gara sul portale e legge bando e disciplinare'), // allow-italian: fixture data, shown as written
      step('s2', 'lavorazione', agent('ag-gare'), 'Prepara la scheda: oggetto, importo, scadenze, requisiti, CCNL'), // allow-italian: fixture data, shown as written
      step('s3', 'lavorazione', person('orbit-tecnico'), 'La Tecnica stima mezzi, personale e costi del servizio'), // allow-italian: fixture data, shown as written
      step('s4', 'verifica', person('orbit-bruno'), 'Il Legale verifica requisiti, garanzie e clausole'), // allow-italian: fixture data, shown as written
      step('s5', 'approvazione', person('orbit-dg'), 'La direzione decide se partecipare'), // allow-italian: fixture data, shown as written
      step('s6', 'fatto', rule, 'Scadenze della gara in calendario, oppure gara archiviata'), // allow-italian: fixture data, shown as written
    ],
  },
  {
    ...catalogue('orbit-scadenze'), area: 'personale', source: 'contratti a termine da Zucchetti, mail di RSU, INPS e INAIL', agent: 'ag-personale', stuckAfterHours: 24, // allow-italian: fixture data, shown as written
    status: 'attivo', // allow-italian: status code of the data, not shown
    programs: ['Zucchetti'],
    steps: [
      step('s1', 'arrivo', program('Zucchetti'), 'Ogni lunedì legge i contratti a tempo determinato'), // allow-italian: fixture data, shown as written
      step('s2', 'lavorazione', rule, 'Calcola le scadenze entro 60 giorni'), // allow-italian: fixture data, shown as written
      step('s3', 'lavorazione', agent('ag-personale'), 'Prepara la scheda di ogni contratto: mesi fatti, proroghe usate, servizio'), // allow-italian: fixture data, shown as written
      step('s4', 'verifica', person('orbit-personale'), 'Il Personale decide: rinnovo, proroga o chiusura'), // allow-italian: fixture data, shown as written
      step('s5', 'approvazione', person('orbit-dg'), 'La direzione approva rinnovi e proroghe'), // allow-italian: fixture data, shown as written
      step('s6', 'fatto', person('orbit-personale'), 'Il Personale consegna la lettera e invia la comunicazione obbligatoria'), // allow-italian: fixture data, shown as written
    ],
  },
  {
    id: 'orbit-turni', name: 'Turni', outcome: 'presenze, ferie e fogli targa', area: 'personale', // allow-italian: fixture data, shown as written
    source: 'timbrature, richieste di ferie e fogli targa da Zucchetti', agent: 'ag-personale', stuckAfterHours: 24, // allow-italian: fixture data, shown as written
    trigger: 'ogni giorno, a fine turno', status: 'attivo', version: 1, perMonth: 160, // allow-italian: fixture data, shown as written
    programs: ['Zucchetti', 'Excel'],
    steps: [
      step('s1', 'arrivo', program('Zucchetti'), 'A fine turno arrivano timbrature, richieste di ferie e fogli targa'), // allow-italian: fixture data, shown as written
      step('s2', 'lavorazione', agent('ag-personale'), 'Incrocia turni, presenze, ferie e fogli targa e segna le differenze'), // allow-italian: fixture data, shown as written
      step('s3', 'lavorazione', person('orbit-personale'), 'Il Personale corregge presenze e giustificativi con i capi cantiere'), // allow-italian: fixture data, shown as written
      step('s4', 'verifica', person('orbit-personale'), 'Il Personale verifica presenze, ore in più e ferie'), // allow-italian: fixture data, shown as written
      step('s5', 'verifica', person('orbit-flotta'), 'La Flotta verifica fogli targa e chilometri'), // allow-italian: fixture data, shown as written
      step('s6', 'approvazione', person('orbit-personale'), 'Il Personale approva ferie, cambi turno e straordinari'), // allow-italian: fixture data, shown as written
      step('s7', 'fatto', program('Zucchetti'), 'Presenze chiuse in Zucchetti, fogli targa archiviati'), // allow-italian: fixture data, shown as written
    ],
  },
  {
    id: 'orbit-varianti', name: 'Variante di contratto', outcome: 'approvazione e firma', area: 'legale', // allow-italian: fixture data, shown as written
    source: 'varianti, rinnovi, subappalti e accordi dei contratti in vigore', agent: 'ag-contratti', stuckAfterHours: 72, // allow-italian: fixture data, shown as written
    trigger: 'una variante, un rinnovo o un subappalto di un contratto in vigore', status: 'collaudo', version: 1, perMonth: 4, // allow-italian: fixture data, shown as written
    programs: ['Word', 'Posta e PEC'],
    steps: [
      step('s1', 'arrivo', agent('ag-contratti'), 'Legge la richiesta o la scadenza e trova contratto e clausola'), // allow-italian: fixture data, shown as written
      step('s2', 'lavorazione', agent('ag-contratti'), 'Prepara la bozza in Word e il confronto con la versione in vigore'), // allow-italian: fixture data, shown as written
      step('s3', 'lavorazione', person('orbit-bruno'), "Il Legale scrive o corregge l'atto"), // allow-italian: fixture data, shown as written
      step('s4', 'verifica', agent('ag-contratti'), 'Mette a confronto versioni, prezzi e valore per chi verifica'), // allow-italian: fixture data, shown as written
      step('s5', 'verifica', person('orbit-bruno'), 'Il Legale verifica clausole e importi'), // allow-italian: fixture data, shown as written
      step('s6', 'approvazione', person('orbit-dg'), 'La direzione approva e firma'), // allow-italian: fixture data, shown as written
      step('s7', 'fatto', program('Posta e PEC'), "Atto firmato inviato via PEC e archiviato come nuova versione"), // allow-italian: fixture data, shown as written
    ],
  },
];

/**
 * Where the report flow splits by type. Step 3 (the proposal of shift and
 * vehicle) is the one each type does its own way: the lanes are the paths of
 * `REPORTS_PATHS` (`../orbit.ts`) cut to the steps that come before the call
 * center confirms (step 5), since the confirmation, the order in SAP and the
 * notice to who reported are steps 5-7 of the flow, the same for every type.
 * Volumes and offices are the paths' own; the count of steps is dropped from
 * their line, since it counted the steps the flow now draws once.
 */
const lanePath = (id: string, keep: string[], at?: string): FlowSplitLane => {
  const path = REPORTS_PATHS.find((p) => p.id === id);
  if (!path) throw new Error(`report path ${id} is missing from ../orbit.ts`);
  return { ...path, expanded: true, meta: path.meta.replace(/ · \d+ passi$/, '').replace(/ al mese(?!, stima)/, ' al mese, stima'), steps: path.steps?.filter((s) => keep.includes(s.id)), at }; // allow-italian: matches the fixture's own words
};

export const ORBIT_SPLITS: FlowSplitDef[] = [
  {
    flow: 'orbit-segnalazioni', step: 's3', by: 'tipo di segnalazione', agent: 'ag-segnalazioni', // allow-italian: fixture data, shown as written
    lanes: [lanePath('pA', ['a']), lanePath('pB', ['a']), lanePath('pC', ['a', 'b', 'c']), lanePath('pD', ['a']), lanePath('pE', ['a'])],
  },
];

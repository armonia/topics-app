/**
 * What each step of the Consorzio flows reads and what it produces, by flow id
 * and step id (`flows.ts`). The step page of «Flussi» prints them as the same
 * data chips the other editions use; the names are the words the teams of the
 * Consorzio use for the paper and the values they handle. Examples, coherent
 * with the flows: a value a card shows is the value the step that reads it
 * names. Same shape as `../orbit-org/step-data.ts`.
 */
import type { FieldRef } from '../../types';
import type { StepData } from '../orbit-org/step-data';

const mail = (name: string): FieldRef => ({ kind: 'mail', name });
const file = (name: string): FieldRef => ({ kind: 'file', name });
const legal = (name: string): FieldRef => ({ kind: 'legal', name });
const record = (name: string): FieldRef => ({ kind: 'record', name });
const figure = (name: string): FieldRef => ({ kind: 'number', name });
const folder = (name: string): FieldRef => ({ kind: 'folder', name });
const calendar = (name: string): FieldRef => ({ kind: 'calendar', name });
const person = (name: string): FieldRef => ({ kind: 'person', name });
const link = (name: string): FieldRef => ({ kind: 'link', name });
const bolt = (name: string): FieldRef => ({ kind: 'bolt', name });
const pair = (reads: FieldRef[], produces: FieldRef[]): StepData => ({ reads, produces });

export const NOCERA_STEP_DATA: Record<string, Record<string, StepData>> = {
  'nocera-pec': {
    s1: pair([mail('PEC'), file('Allegati'), file('Ricevuta di consegna')], [record('Mittente'), figure('Firme verificate'), file('Testo degli allegati')]), // allow-italian: fixture data, shown as written
    s2: pair([mail('PEC.oggetto'), record('Mittente'), file('Testo degli allegati')], [folder('Tipo di PEC'), folder('Voce del titolario'), figure('Sicurezza')]), // allow-italian: fixture data, shown as written
    s3: pair([legal('Ricorso'), record('Mittente')], [record('Contribuente'), record('Avviso di pagamento')]), // allow-italian: fixture data, shown as written
    s4: pair([calendar('Data di notifica'), folder('Tipo di PEC')], [calendar('Termine di costituzione'), calendar('Termine di risposta')]), // allow-italian: fixture data, shown as written
    s5: pair([folder('Tipo di PEC'), folder('Voce del titolario'), calendar('Termine di risposta')], [bolt('Conferma')]), // allow-italian: fixture data, shown as written
    s6: pair([legal('Ricorso'), record('Avviso di pagamento'), calendar('Termine di costituzione')], [bolt('Parere')]), // allow-italian: fixture data, shown as written
    s7: pair([legal('Ricorso'), bolt('Parere')], [bolt('Approvazione')]), // allow-italian: fixture data, shown as written
    s8: pair([bolt('Conferma'), bolt('Approvazione')], [figure('Numero di protocollo'), folder('Fascicolo'), link('Team assegnato')]), // allow-italian: fixture data, shown as written
  },
  'nocera-fatture': {
    s1: pair([file('Fattura elettronica')], [record('Fornitore'), figure('Imponibile'), figure('IVA')]), // allow-italian: fixture data, shown as written
    s2: pair([record('Fornitore'), figure('IVA'), figure('CIG')], [figure('Differenze')]), // allow-italian: fixture data, shown as written
    s3: pair([record('Fornitore'), file('Ordine o determina di impegno')], [link('Abbinamento')]), // allow-italian: fixture data, shown as written
    s4: pair([calendar('Data di ricevimento')], [calendar('Scadenza a 30 giorni')]), // allow-italian: fixture data, shown as written
    s5: pair([figure('Differenze'), link('Abbinamento')], [bolt('Conferma'), mail('Risposta allo SdI')]), // allow-italian: fixture data, shown as written
    s6: pair([figure('Imponibile'), figure('Differenze')], [bolt('Visto')]), // allow-italian: fixture data, shown as written
    s7: pair([bolt('Visto'), calendar('Scadenza a 30 giorni')], [record('Registrazione in TeamSystem'), file('Mandato di pagamento')]), // allow-italian: fixture data, shown as written
  },
  'nocera-irrigazione': {
    s1: pair([file('Modulo del sito')], [folder('Bacino'), record('Particella'), folder('Coltura'), calendar('Giorni richiesti')]), // allow-italian: fixture data, shown as written
    s2: pair([folder('Bacino'), record('Particella')], [record('Utenza irrigua'), person('Intestatario')]), // allow-italian: fixture data, shown as written
    s3: pair([folder('Bacino'), calendar('Giorni richiesti'), calendar('Calendario dei turni')], [figure('Turni sovrapposti')]), // allow-italian: fixture data, shown as written
    s4: pair([figure('Turni sovrapposti'), calendar('Calendario dei turni')], [calendar('Turno proposto')]), // allow-italian: fixture data, shown as written
    s5: pair([calendar('Turno proposto')], [bolt('Conferma')]), // allow-italian: fixture data, shown as written
    s6: pair([calendar('Turno proposto')], [bolt('Approvazione')]), // allow-italian: fixture data, shown as written
    s7: pair([bolt('Conferma')], [calendar('Calendario dei turni'), mail('Avviso a chi ha chiesto il turno')]), // allow-italian: fixture data, shown as written
  },
  'nocera-segnalazioni': {
    s1: pair([mail('Segnalazione'), file('Foto')], [folder('Luogo'), folder('Canale'), folder('Tipo di problema')]), // allow-italian: fixture data, shown as written
    s2: pair([folder('Canale'), figure('Segnalazioni aperte')], [link('Segnalazione collegata')]), // allow-italian: fixture data, shown as written
    s3: pair([folder('Luogo'), folder('Canale')], [record('Tratto del canale'), record('Comune')]), // allow-italian: fixture data, shown as written
    s4: pair([record('Tratto del canale'), folder('Tipo di problema')], [figure('Squadra'), figure('Priorità')]), // allow-italian: fixture data, shown as written
    s5: pair([figure('Squadra'), figure('Priorità')], [bolt('Conferma')]), // allow-italian: fixture data, shown as written
    s6: pair([figure('Priorità'), figure('Costo stimato')], [bolt('Approvazione')]), // allow-italian: fixture data, shown as written
    s7: pair([bolt('Conferma'), bolt('Approvazione')], [file('Foto dopo l\'intervento'), mail('Risposta a chi ha segnalato')]), // allow-italian: fixture data, shown as written
  },
  'nocera-concessioni': {
    s1: pair([mail('Richiesta'), file('Allegati')], [folder('Opera'), folder('Canale'), record('Comune'), person('Richiedente')]), // allow-italian: fixture data, shown as written
    s2: pair([record('Comune'), person('Richiedente')], [record('Proprietà'), record('Particella')]), // allow-italian: fixture data, shown as written
    s3: pair([record('Particella'), folder('Canale')], [file('Tracciato sulla mappa'), figure('Distanza dal canale')]), // allow-italian: fixture data, shown as written
    s4: pair([file('Tavole DWG')], [file('Integrazione richiesta'), figure('Documenti mancanti')]), // allow-italian: fixture data, shown as written
    s5: pair([folder('Opera'), figure('Distanza dal canale')], [file('Disciplinare'), figure('Canone')]), // allow-italian: fixture data, shown as written
    s6: pair([file('Disciplinare'), file('Tracciato sulla mappa')], [bolt('Parere')]), // allow-italian: fixture data, shown as written
    s7: pair([file('Disciplinare'), bolt('Parere'), figure('Canone')], [bolt('Firma')]), // allow-italian: fixture data, shown as written
    s8: pair([bolt('Firma')], [mail('Concessione via PEC'), figure('Numero di protocollo')]), // allow-italian: fixture data, shown as written
  },
  'nocera-polizia': {
    s1: pair([legal('Verbale'), file('Foto del sopralluogo')], [folder('Violazione'), legal('Norma violata'), person('Soggetto')]), // allow-italian: fixture data, shown as written
    s2: pair([folder('Violazione'), file('Foto del sopralluogo')], [record('Tratto del canale'), figure('Distanza dal ciglio')]), // allow-italian: fixture data, shown as written
    s3: pair([legal('Verbale')], [figure('Numero di protocollo'), folder('Fascicolo')]), // allow-italian: fixture data, shown as written
    s4: pair([legal('Verbale'), person('Soggetto')], [file('Bozza di notifica'), calendar('Termine per gli scritti difensivi')]), // allow-italian: fixture data, shown as written
    s5: pair([legal('Verbale'), file('Bozza di notifica')], [bolt('Conferma')]), // allow-italian: fixture data, shown as written
    s6: pair([legal('Norma violata'), figure('Sanzione')], [bolt('Parere')]), // allow-italian: fixture data, shown as written
    s7: pair([file('Bozza di notifica'), bolt('Parere')], [bolt('Firma')]), // allow-italian: fixture data, shown as written
    s8: pair([bolt('Firma')], [mail('Notifica SEND'), calendar('Data di perfezionamento')]), // allow-italian: fixture data, shown as written
  },
  'nocera-contributi': {
    s1: pair([mail('Istanza')], [person('Contribuente'), folder('Tributo'), folder('Anno'), folder('Richiesta')]), // allow-italian: fixture data, shown as written
    s2: pair([person('Contribuente')], [record('Immobili'), record('Avviso di pagamento')]), // allow-italian: fixture data, shown as written
    s3: pair([calendar('Data di arrivo')], [calendar('Termine di risposta')]), // allow-italian: fixture data, shown as written
    s4: pair([record('Avviso di pagamento'), record('Immobili')], [figure('Importo dovuto'), file('Bozza del provvedimento')]), // allow-italian: fixture data, shown as written
    s5: pair([figure('Importo dovuto'), file('Bozza del provvedimento')], [bolt('Conferma')]), // allow-italian: fixture data, shown as written
    s6: pair([file('Bozza del provvedimento'), bolt('Conferma')], [bolt('Firma')]), // allow-italian: fixture data, shown as written
    s7: pair([bolt('Firma')], [mail('Notifica SEND'), file('Ordine di pagamento')]), // allow-italian: fixture data, shown as written
  },
  'nocera-personale': {
    s1: pair([], [record('Contratti a termine'), record('Visite mediche'), record('Certificati')]), // allow-italian: fixture data, shown as written
    s2: pair([record('Contratti a termine'), record('Visite mediche'), record('Certificati')], [calendar('Scadenze entro 30 giorni')]), // allow-italian: fixture data, shown as written
    s3: pair([calendar('Scadenze entro 30 giorni')], [file('Scheda della scadenza'), file('Bozza di lettera')]), // allow-italian: fixture data, shown as written
    s4: pair([file('Scheda della scadenza')], [bolt('Decisione')]), // allow-italian: fixture data, shown as written
    s5: pair([bolt('Decisione')], [bolt('Approvazione')]), // allow-italian: fixture data, shown as written
    s6: pair([bolt('Approvazione'), file('Bozza di lettera')], [file('Lettera'), legal('Comunicazione obbligatoria')]), // allow-italian: fixture data, shown as written
  },
  'nocera-contratti': {
    s1: pair([file('Capitolato'), file('Bando'), mail('Richiesta di incarico')], [folder('Oggetto')]), // allow-italian: fixture data, shown as written
    s2: pair([file('Capitolato'), file('Bando')], [figure('Importo'), figure('CIG'), legal('Requisiti')]), // allow-italian: fixture data, shown as written
    s3: pair([figure('Importo'), figure('CIG')], [folder('Procedura')]), // allow-italian: fixture data, shown as written
    s4: pair([folder('Procedura')], [file('Procedura sulla piattaforma'), calendar('Scadenza delle offerte')]), // allow-italian: fixture data, shown as written
    s5: pair([folder('Oggetto'), figure('Importo'), legal('Requisiti')], [file('Bozza di determina')]), // allow-italian: fixture data, shown as written
    s6: pair([legal('Requisiti')], [bolt('Conferma')]), // allow-italian: fixture data, shown as written
    s7: pair([file('Bozza di determina')], [bolt('Parere')]), // allow-italian: fixture data, shown as written
    s8: pair([file('Bozza di determina'), bolt('Parere')], [bolt('Firma')]), // allow-italian: fixture data, shown as written
    s9: pair([bolt('Firma')], [figure('Numero di protocollo'), calendar('Pubblicazione all\'albo'), calendar('Scadenze della procedura')]), // allow-italian: fixture data, shown as written
  },
};

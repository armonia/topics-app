/**
 * What each step of the ORBIT flows reads and what it produces, by flow id and
 * step id (`flows.ts`). The step page of «Flussi» prints them as the same data (allow-italian: quotes the Italian interface)
 * chips the multi-organization edition uses; the names are the words ORBIT's
 * offices use for the paper and the values they handle. Examples, coherent
 * with the cards: a value a card shows (`Codice EER`, `Peso a destino`) is the
 * value the step that reads it names.
 */
import type { FieldRef } from '../../types';

export interface StepData {
  reads: FieldRef[];
  produces: FieldRef[];
}

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

export const ORBIT_STEP_DATA: Record<string, Record<string, StepData>> = {
  'orbit-segnalazioni': {
    s1: pair([mail('Segnalazione'), file('Foto')], [record('Indirizzo'), folder('Tipo di rifiuto'), folder('Urgenza')]), // allow-italian: fixture data, shown as written
    s2: pair([record('Indirizzo'), figure('Segnalazioni aperte')], [link('Segnalazione collegata')]), // allow-italian: fixture data, shown as written
    s3: pair([record('Indirizzo'), calendar('Calendario di raccolta')], [figure('Turno'), figure('Mezzo')]), // allow-italian: fixture data, shown as written
    s4: pair([person('Chi ha segnalato')], [file('Foto'), record('Numero civico')]), // allow-italian: fixture data, shown as written
    s5: pair([figure('Turno'), figure('Mezzo')], [bolt('Conferma')]), // allow-italian: fixture data, shown as written
    s6: pair([figure('Turno'), figure('Costo fuori giro')], [bolt('Approvazione')]), // allow-italian: fixture data, shown as written
    s7: pair([bolt('Conferma')], [file('Ordine SAP'), calendar('Giro WinWaste'), mail('Avviso a chi ha segnalato')]), // allow-italian: fixture data, shown as written
  },
  'orbit-foglie': {
    s1: pair([], [calendar('Passaggi del mese')]), // allow-italian: fixture data, shown as written
    s2: pair([calendar('Passaggi del mese'), file('Programma AMA')], [file('Rendiconto per zona'), figure('Passaggi mancanti')]), // allow-italian: fixture data, shown as written
    s3: pair([figure('Passaggi mancanti')], [file('Rendiconto corretto')]), // allow-italian: fixture data, shown as written
    s4: pair([file('Rendiconto corretto')], [bolt('Approvazione')]), // allow-italian: fixture data, shown as written
    s5: pair([file('Rendiconto corretto')], [mail('Invio ad AMA')]), // allow-italian: fixture data, shown as written
  },
  'orbit-fir': {
    s1: pair([legal('Formulario FIR'), file("Foto dell'autista")], [folder('Codice EER'), figure('Peso a partenza'), record('Targa'), record('Destinatario')]), // allow-italian: fixture data, shown as written
    s2: pair([legal('Formulario FIR')], [file("Copia dell'impianto")]), // allow-italian: fixture data, shown as written
    s3: pair([figure('Peso a partenza'), figure('Peso a destino')], [figure('Differenza di peso')]), // allow-italian: fixture data, shown as written
    s4: pair([folder('Codice EER'), figure('Peso a destino')], [legal('Registrazione RENTRI')]), // allow-italian: fixture data, shown as written
    s5: pair([legal('Registrazione RENTRI')], [bolt('Conferma')]), // allow-italian: fixture data, shown as written
    s6: pair([legal('Registrazione RENTRI')], [bolt('Firma')]), // allow-italian: fixture data, shown as written
    s7: pair([legal('Registrazione RENTRI')], [file('Ricevuta RENTRI')]), // allow-italian: fixture data, shown as written
  },
  'orbit-fatture': {
    s1: pair([file('Fattura elettronica')], [record('Fornitore'), figure('Imponibile'), figure('IVA')]), // allow-italian: fixture data, shown as written
    s2: pair([record('Fornitore'), file('Ordine o contratto'), file('Bolla di consegna')], [link('Abbinamento')]), // allow-italian: fixture data, shown as written
    s3: pair([link('Abbinamento'), figure('Prezzi del contratto')], [figure('Differenze')]), // allow-italian: fixture data, shown as written
    s4: pair([figure('Differenze')], [file('Documenti mancanti')]), // allow-italian: fixture data, shown as written
    s5: pair([figure('Differenze')], [bolt('Conferma')]), // allow-italian: fixture data, shown as written
    s6: pair([figure('Differenze'), figure('Trattenuta')], [bolt('Approvazione')]), // allow-italian: fixture data, shown as written
    s7: pair([file('Movimento in banca')], [link('Riconciliazione')]), // allow-italian: fixture data, shown as written
  },
  'orbit-gara': {
    s1: pair([file('Bando'), file('Disciplinare')], [folder('Oggetto'), calendar('Scadenza offerte')]), // allow-italian: fixture data, shown as written
    s2: pair([file('Bando'), file('Disciplinare')], [file('Scheda di valutazione'), legal('Requisiti'), legal('CCNL')]), // allow-italian: fixture data, shown as written
    s3: pair([file('Scheda di valutazione')], [figure('Mezzi'), figure('Personale'), figure('Costo stimato')]), // allow-italian: fixture data, shown as written
    s4: pair([legal('Requisiti'), legal('Garanzie')], [bolt('Parere')]), // allow-italian: fixture data, shown as written
    s5: pair([file('Scheda di valutazione'), bolt('Parere')], [bolt('Decisione')]), // allow-italian: fixture data, shown as written
    s6: pair([bolt('Decisione')], [calendar('Scadenze in calendario')]), // allow-italian: fixture data, shown as written
  },
  'orbit-scadenze': {
    s1: pair([], [record('Contratti a termine')]), // allow-italian: fixture data, shown as written
    s2: pair([record('Contratti a termine')], [calendar('Scadenze entro 60 giorni')]), // allow-italian: fixture data, shown as written
    s3: pair([record('Contratti a termine')], [figure('Mesi fatti'), figure('Proroghe usate'), folder('Servizio')]), // allow-italian: fixture data, shown as written
    s4: pair([file('Scheda del contratto')], [bolt('Decisione')]), // allow-italian: fixture data, shown as written
    s5: pair([bolt('Decisione')], [bolt('Approvazione')]), // allow-italian: fixture data, shown as written
    s6: pair([bolt('Approvazione')], [file('Lettera'), legal('UNILAV')]), // allow-italian: fixture data, shown as written
  },
  'orbit-turni': {
    s1: pair([], [calendar('Timbrature'), calendar('Richieste di ferie'), file('Fogli targa')]), // allow-italian: fixture data, shown as written
    s2: pair([calendar('Turni'), calendar('Timbrature'), file('Fogli targa')], [figure('Differenze')]), // allow-italian: fixture data, shown as written
    s3: pair([figure('Differenze')], [calendar('Presenze corrette')]), // allow-italian: fixture data, shown as written
    s4: pair([calendar('Presenze corrette')], [bolt('Conferma')]), // allow-italian: fixture data, shown as written
    s5: pair([file('Fogli targa'), figure('Chilometri GPS')], [bolt('Conferma')]), // allow-italian: fixture data, shown as written
    s6: pair([calendar('Richieste di ferie')], [bolt('Approvazione')]), // allow-italian: fixture data, shown as written
    s7: pair([calendar('Presenze corrette')], [file('Mese chiuso')]), // allow-italian: fixture data, shown as written
  },
  'orbit-varianti': {
    s1: pair([mail('Richiesta'), legal('Contratto in vigore')], [legal('Clausola')]), // allow-italian: fixture data, shown as written
    s2: pair([legal('Contratto in vigore')], [file('Bozza in Word'), file('Confronto delle versioni')]), // allow-italian: fixture data, shown as written
    s3: pair([file('Bozza in Word')], [legal('Atto')]), // allow-italian: fixture data, shown as written
    s4: pair([legal('Atto'), figure('Valore iniziale')], [figure('Variazione del valore')]), // allow-italian: fixture data, shown as written
    s5: pair([legal('Atto'), figure('Variazione del valore')], [bolt('Parere')]), // allow-italian: fixture data, shown as written
    s6: pair([legal('Atto')], [bolt('Firma')]), // allow-italian: fixture data, shown as written
    s7: pair([legal('Atto firmato')], [mail('Ricevuta PEC'), file('Nuova versione')]), // allow-italian: fixture data, shown as written
  },
};

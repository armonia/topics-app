/**
 * Fixture of w01: the flow that receives the Consorzio's certified mail.
 *
 * The case is the one of the "organizzazioni" scenario (an appeal to the tax
 * court against the 2025 contribution notice, served by certified mail on
 * 05/11/2026): the court, the 60-day term of art. 23 D.Lgs. 546/1992 and the
 * programs in use are real; the appellant, the codes and the amounts are an
 * example. Volumes per month are an example too, and say "stima".
 */
import type { FieldRef } from '../types';
import type { FlowModel } from '../flows/model';

/** The PEC flow as drawn: it always has its paths. */
export const CERTIFIED_MAIL_FLOW: FlowModel & Required<Pick<FlowModel, 'branch'>> = {
  crumbs: [{ label: 'Flussi' }, { label: 'Quando arriva una PEC su protocollo@' }], // allow-italian: fixture data, shown as written
  status: { text: 'Attivo · v4', tone: 'green' }, // allow-italian: fixture data, shown as written
  trigger: {
    id: 'trigger', actors: [{ kind: 'trigger' }],
    title: "Arriva una PEC sulla casella protocollo@ dell'organizzazione", // allow-italian: fixture data, shown as written
    note: '1.204 al mese, stima · controllo ogni 2 min', // allow-italian: fixture data, shown as written
    produces: [{ kind: 'mail', name: 'PEC' }, { kind: 'file', name: 'Allegati ×n' }, { kind: 'file', name: 'Ricevuta di consegna' }], // allow-italian: fixture data, shown as written
  },
  steps: [
    {
      id: 's1', marker: '1', actors: [{ kind: 'rule' }, { kind: 'ai' }],
      title: 'Prepara gli allegati', // allow-italian: fixture data, shown as written
      note: 'verifica firme .p7m · testo anche dalle scansioni · scarta la ricevuta', // allow-italian: fixture data, shown as written
      uses: [{ kind: 'file', name: 'Allegati' }],
      produces: [{ kind: 'file', name: 'Allegato.testo' }, { kind: 'file', name: 'Allegato.firma valida' }],
    },
    {
      id: 's2', marker: '2', actors: [{ kind: 'ai' }],
      title: 'Riconosce il tipo di PEC', // allow-italian: fixture data, shown as written
      note: '7 tipi, dal titolario · sotto 90% decide una persona', // allow-italian: fixture data, shown as written
      uses: [{ kind: 'mail', name: 'PEC.oggetto' }, { kind: 'mail', name: 'PEC.mittente' }, { kind: 'file', name: 'Allegato.testo' }],
      produces: [{ kind: 'folder', name: 'Pratica.tipo' }, { kind: 'folder', name: 'fiducia' }],
    },
  ],
  branch: {
    marker: '3',
    count: 7,
    paths: [
      {
        id: 'pA', letter: 'A', kind: 'legal', expanded: true,
        title: 'Ricorso o atto giudiziario', // allow-italian: fixture data, shown as written
        badge: { text: 'sempre una persona', tone: 'amber' }, // allow-italian: fixture data, shown as written
        meta: '6 al mese · Legale', // allow-italian: fixture data, shown as written
        steps: [
          {
            id: 'a', marker: 'a', actors: [{ kind: 'ai' }],
            title: 'Estrae parti, corte, data di notifica e richieste', // allow-italian: fixture data, shown as written
            produces: [{ kind: 'legal', name: 'Ricorso' }],
          },
          {
            id: 'b', marker: 'b', actors: [{ kind: 'program', name: 'Prunes', tone: 'blue' }],
            title: "Trova il contribuente e l'avviso contestato", // allow-italian: fixture data, shown as written
            uses: [{ kind: 'legal', name: 'Ricorso.ricorrente' }],
            produces: [{ kind: 'record', name: 'Contribuente' }, { kind: 'record', name: 'Avviso di pagamento' }], // allow-italian: fixture data, shown as written
            opens: 'Verifica della particella', // allow-italian: fixture data, shown as written
          },
          {
            id: 'c', marker: 'c', actors: [{ kind: 'rule' }], highlighted: true,
            title: 'Calcola le scadenze', // allow-italian: fixture data, shown as written
            note: 'costituzione 60 giorni dalla notifica (art. 23 D.Lgs. 546/1992) · avvisi 20 e 5 giorni prima', // allow-italian: fixture data, shown as written
            uses: [{ kind: 'mail', name: 'PEC.data consegna' }], // allow-italian: fixture data, shown as written
            produces: [{ kind: 'number', name: 'Scadenza ×3' }],
          },
          {
            id: 'd', marker: 'd', actors: [{ kind: 'person' }],
            title: 'Il Legale controlla e conferma', // allow-italian: fixture data, shown as written
            opens: 'Conferma con originali', // allow-italian: fixture data, shown as written
            due: 'entro 4 h', // allow-italian: fixture data, shown as written
          },
          {
            id: 'e', marker: 'e', actors: [{ kind: 'program', name: 'Halley', tone: 'green' }],
            title: 'Prepara la bozza di protocollo e il fascicolo «Contenzioso»', // allow-italian: fixture data, shown as written
            note: "la registra l'ufficio protocollo", // allow-italian: fixture data, shown as written
            produces: [{ kind: 'number', name: 'Protocollo n.' }, { kind: 'number', name: 'Fascicolo' }],
          },
          {
            id: 'f', marker: 'f', actors: [{ kind: 'person' }],
            title: "L'avvocato interno prepara le controdeduzioni e l'incarico al legale esterno", // allow-italian: fixture data, shown as written
            opens: 'Presentazione per il legale esterno', // allow-italian: fixture data, shown as written
          },
          {
            id: 'g', marker: 'g', actors: [{ kind: 'person' }],
            title: "La Direzione sceglie il legale dall'albo e firma l'incarico", // allow-italian: fixture data, shown as written
            trailing: 'card in Board',
          },
        ],
      },
      {
        id: 'pB', letter: 'B', kind: 'record', title: 'Istanza del contribuente', hint: 'rimborso, rateizzazione, sgravio', // allow-italian: fixture data, shown as written
        meta: '210 al mese · 7 passi · Ruoli e riscossione', // allow-italian: fixture data, shown as written
        steps: [
          { id: 'b1', marker: 'a', actors: [{ kind: 'ai' }], title: 'Estrae contribuente, tributo e richiesta', produces: [{ kind: 'record', name: 'Istanza' }] }, // allow-italian: fixture data, shown as written
          { id: 'b2', marker: 'b', actors: [{ kind: 'program', name: 'Prunes', tone: 'blue' }], title: 'Trova il contribuente e la sua posizione', uses: [{ kind: 'record', name: 'Istanza' }], produces: [{ kind: 'record', name: 'Contribuente' }] }, // allow-italian: fixture data, shown as written
          { id: 'b3', marker: 'c', actors: [{ kind: 'rule' }], title: 'Calcola il termine di risposta', produces: [{ kind: 'number', name: 'Scadenza' }] }, // allow-italian: fixture data, shown as written
          { id: 'b4', marker: 'd', actors: [{ kind: 'program', name: 'Halley', tone: 'green' }], title: "Protocolla l'istanza", produces: [{ kind: 'number', name: 'Protocollo n.' }] }, // allow-italian: fixture data, shown as written
          { id: 'b5', marker: 'e', actors: [{ kind: 'person' }], title: 'Istruttoria del Catasto e ruoli', due: 'entro 10 giorni' }, // allow-italian: fixture data, shown as written
          { id: 'b6', marker: 'f', actors: [{ kind: 'person' }], title: 'Provvedimento firmato e notificato con SEND', trailing: 'card in Board' }, // allow-italian: fixture data, shown as written
          { id: 'b7', marker: 'g', actors: [{ kind: 'program', name: 'TeamSystem', tone: 'violet' }], title: 'Rimborso: ordina il pagamento', uses: [{ kind: 'record', name: 'Contribuente' }] }, // allow-italian: fixture data, shown as written
        ],
      },
      {
        id: 'pC', letter: 'C', kind: 'mail', title: 'Comunicazione da un ente', hint: 'Regione, Comuni, ANAC, INPS', // allow-italian: fixture data, shown as written
        meta: '380 al mese · 5 passi · secondo il titolario', // allow-italian: fixture data, shown as written
        steps: [
          { id: 'c1', marker: 'a', actors: [{ kind: 'ai' }], title: 'Estrae ente, oggetto e scadenza', produces: [{ kind: 'mail', name: 'Comunicazione' }] }, // allow-italian: fixture data, shown as written
          { id: 'c2', marker: 'b', actors: [{ kind: 'rule' }], title: "Assegna all'ufficio secondo il titolario", note: 'sotto 90% decide una persona' }, // allow-italian: fixture data, shown as written
          { id: 'c3', marker: 'c', actors: [{ kind: 'program', name: 'Halley', tone: 'green' }], title: 'Protocolla la comunicazione', produces: [{ kind: 'number', name: 'Protocollo n.' }] }, // allow-italian: fixture data, shown as written
          { id: 'c4', marker: 'd', actors: [{ kind: 'person' }], title: "L'ufficio prepara la risposta", due: 'entro 5 giorni' }, // allow-italian: fixture data, shown as written
          { id: 'c5', marker: 'e', actors: [{ kind: 'person' }], title: 'Firma e invio', trailing: 'card in Board' }, // allow-italian: fixture data, shown as written
        ],
      },
      { id: 'pD', letter: 'D', kind: 'calendar', title: 'Richiesta irrigua o segnalazione dal territorio', meta: '140 al mese · avvia «Richiesta irrigua → turno»' }, // allow-italian: fixture data, shown as written
      { id: 'pE', letter: 'E', kind: 'file', title: 'Fattura o nota di credito fuori SdI', meta: '31 al mese · avvia «Fattura passiva»' }, // allow-italian: fixture data, shown as written
      {
        id: 'pF', letter: 'F', kind: 'folder', title: 'Accesso agli atti', hint: 'risposta entro 30 giorni', // allow-italian: fixture data, shown as written
        meta: '12 al mese · 5 passi · al Protocollo', // allow-italian: fixture data, shown as written
        steps: [
          { id: 'f1', marker: 'a', actors: [{ kind: 'ai' }], title: 'Riconosce la richiesta di accesso e chi la fa', produces: [{ kind: 'person', name: 'Richiedente' }] }, // allow-italian: fixture data, shown as written
          { id: 'f2', marker: 'b', actors: [{ kind: 'rule' }], title: 'Calcola la scadenza dei 30 giorni', produces: [{ kind: 'number', name: 'Scadenza' }] }, // allow-italian: fixture data, shown as written
          { id: 'f3', marker: 'c', actors: [{ kind: 'program', name: 'Halley', tone: 'green' }], title: 'Annota la richiesta nel registro degli accessi' }, // allow-italian: fixture data, shown as written
          { id: 'f4', marker: 'd', actors: [{ kind: 'person' }], title: 'Avvisa i controinteressati e valuta', due: 'entro 5 giorni' }, // allow-italian: fixture data, shown as written
          { id: 'f5', marker: 'e', actors: [{ kind: 'person' }], title: 'Risposta firmata e inviata', trailing: 'card in Board' }, // allow-italian: fixture data, shown as written
        ],
      },
      { id: 'pG', letter: 'G', kind: 'person', title: 'Altro o non riconosciuta', meta: 'sempre a una persona del Protocollo' }, // allow-italian: fixture data, shown as written
    ],
  },
  collected: {
    tag: 'Dati della pratica', // allow-italian: fixture data, shown as written
    title: 'Cosa si raccoglie nel percorso A', // allow-italian: fixture data, shown as written
    description: 'Ogni passo aggiunge campi alla stessa pratica. Qui si vede chi li scrive e chi li può leggere.', // allow-italian: fixture data, shown as written
    sections: [
      {
        label: 'Dalla PEC', // allow-italian: fixture data, shown as written
        rows: [
          { field: { kind: 'mail', name: 'PEC' }, label: 'mittente', value: 'legale del ricorrente, PEC' }, // allow-italian: fixture data, shown as written
          { label: 'consegnata il', hint: 'data e ora', value: '05/11/2026 09:12' }, // allow-italian: fixture data, shown as written
        ],
      },
      {
        label: "Dall'atto · passo a", // allow-italian: fixture data, shown as written
        rows: [
          { field: { kind: 'legal', name: 'Ricorso' }, label: 'ricorrente', value: 'azienda agricola, esempio' }, // allow-italian: fixture data, shown as written
          { label: 'corte', value: 'CGT di primo grado' }, // allow-italian: fixture data, shown as written
          { label: 'richieste', value: "annullamento, sospensione dell'avviso" }, // allow-italian: fixture data, shown as written
        ],
      },
      {
        label: 'Da Prunes · passo b', // allow-italian: fixture data, shown as written
        rows: [
          { field: { kind: 'record', name: 'Contribuente' }, label: 'codice', value: 'C-0048213' }, // allow-italian: fixture data, shown as written
          { field: { kind: 'record', name: 'Avviso' }, label: 'anno e importo', value: '2025 · 1.248 €' }, // allow-italian: fixture data, shown as written
        ],
      },
      {
        label: 'Calcolati · passo c', // allow-italian: fixture data, shown as written
        rows: [
          { field: { kind: 'number', name: 'Scadenza' }, label: 'costituzione', hint: 'data', value: '04/01/2027' }, // allow-italian: fixture data, shown as written
          { label: 'avvisi al Legale', hint: 'data', value: '15/12 · 30/12' }, // allow-italian: fixture data, shown as written
        ],
      },
      {
        label: 'Da Halley · passo e', // allow-italian: fixture data, shown as written
        rows: [{ field: { kind: 'number', name: 'Protocollo' }, label: 'numero', value: 'dopo la conferma' }], // allow-italian: fixture data, shown as written
      },
    ],
    access: { label: 'Dati giudiziari', value: 'Protocollo, Legale, Direzione' }, // allow-italian: fixture data, shown as written
  },
};

/* ---------- the other flows: what each step says, reads and writes ---------- */

/** What the screen adds to a step of a flow that has no hand-drawn model: its note, data and the view it opens. */
export interface StepDetail {
  note?: string;
  uses?: FieldRef[];
  produces?: FieldRef[];
  /** The view the step opens, as the person sees it named. */
  opens?: string;
  /** Which place of the preview that view is (the screen maps it to an address). */
  opensTo?: 'parcel' | 'inbox' | 'presentation';
  due?: string;
  trailing?: string;
  /** The stage of the by-office view (w03) this step belongs to; default from its kind. */
  phase?: 'arrival' | 'reading' | 'check' | 'registration' | 'work';
}

/** The data a flow's trigger produces, and the volume line printed on it. */
export interface TriggerDetail {
  note?: string;
  produces?: FieldRef[];
}

const f = (kind: FieldRef['kind'], name: string): FieldRef => ({ kind, name });

export const TRIGGER_DETAIL: Record<string, TriggerDetail> = {
  fatture: { note: 'controllo ogni 15 min', produces: [f('file', 'Fattura XML'), f('mail', 'Notifica SdI')] }, // allow-italian: fixture data, shown as written
  irrigua: { note: 'dal modulo del sito', produces: [f('record', 'Richiesta'), f('calendar', 'Bacino')] }, // allow-italian: fixture data, shown as written
  gara: { note: 'si avvia a mano', produces: [f('file', 'Capitolato'), f('file', 'Bando')] }, // allow-italian: fixture data, shown as written
  personale: { note: 'alle 7, ogni giorno', produces: [f('calendar', 'Scadenze')] }, // allow-italian: fixture data, shown as written
  segnalazioni: { note: 'WhatsApp, telefono', produces: [f('mail', 'Segnalazione'), f('file', 'Foto')] }, // allow-italian: fixture data, shown as written
  concessioni: { note: 'richiesta via PEC o sportello', produces: [f('mail', 'Richiesta'), f('file', 'Allegati ×n')] }, // allow-italian: fixture data, shown as written
  accesso: { note: 'PEC con «accesso»', produces: [f('mail', 'PEC'), f('file', 'Istanza')] }, // allow-italian: fixture data, shown as written
  'orbit-segnalazioni': { note: '1.412 al mese, stima · mail AMA · portale utenze · telefonata', produces: [f('mail', 'Segnalazione'), f('file', 'Foto')] }, // allow-italian: fixture data, shown as written
  verbale: { note: 'dal sopralluogo', produces: [f('legal', 'Verbale'), f('file', 'Foto')] }, // allow-italian: fixture data, shown as written
  'orbit-fir': { note: 'a ogni ritiro con formulario', produces: [f('legal', 'Ritiro')] }, // allow-italian: fixture data, shown as written
  'orbit-fatture': { note: 'dalla casella fornitori', produces: [f('file', 'Fattura'), f('mail', 'Mail')] }, // allow-italian: fixture data, shown as written
};

/** Detail of every step of the non-PEC flows, by flow then by step id. */
export const STEP_DETAIL: Record<string, Record<string, StepDetail>> = {
  fatture: {
    s1: { uses: [f('file', 'Fattura XML')], produces: [f('record', 'Righe'), f('number', 'Importo'), f('number', 'IVA')], phase: 'reading' }, // allow-italian: fixture data, shown as written
    s2: { note: 'split payment: regola fissa, non più da ricordare', uses: [f('number', 'IVA'), f('record', 'Fornitore'), f('number', 'Importo')], produces: [f('number', 'Split payment'), f('number', 'Differenza')] }, // allow-italian: fixture data, shown as written
    s3: { note: 'accettata o rifiutata entro 15 giorni', uses: [f('number', 'Differenza')], trailing: 'risposta allo SdI', phase: 'check' }, // allow-italian: fixture data, shown as written
    s6: { uses: [f('number', 'Differenza')], due: 'entro 1 giorno' }, // allow-italian: fixture data, shown as written
    s7: { note: 'sopra 5.000 € il visto è del direttore', uses: [f('number', 'Importo')], produces: [f('person', 'Chi dà il visto')] }, // allow-italian: fixture data, shown as written
    s8: { due: 'entro 2 giorni', uses: [f('person', 'Chi dà il visto')], produces: [f('legal', 'Visto')], opens: 'Conferma con originali', opensTo: 'inbox' }, // allow-italian: fixture data, shown as written
    s4: { note: 'poi controllo a campione', uses: [f('record', 'Righe'), f('legal', 'Visto')], produces: [f('number', 'Registrazione n.')], phase: 'registration' }, // allow-italian: fixture data, shown as written
    s9: { note: 'una su dieci, a caso', uses: [f('number', 'Registrazione n.')] }, // allow-italian: fixture data, shown as written
    s10: { note: 'scade a 30 giorni dalla data fattura', uses: [f('calendar', 'Data fattura')], produces: [f('calendar', 'Scadenza')] }, // allow-italian: fixture data, shown as written
    s5: { uses: [f('calendar', 'Scadenza')], opens: 'Pagamento da preparare', opensTo: 'inbox' }, // allow-italian: fixture data, shown as written
    s11: { trailing: 'card in Board', uses: [f('calendar', 'Scadenza')] }, // allow-italian: fixture data, shown as written
  },
  irrigua: {
    s1: { uses: [f('record', 'Richiesta')], produces: [f('calendar', 'Bacino'), f('record', 'Particella'), f('folder', 'Coltura')] }, // allow-italian: fixture data, shown as written
    s2: { note: '7 bacini di irrigazione collettiva', uses: [f('record', 'Particella'), f('calendar', 'Bacino')], produces: [f('person', 'Utente iscritto'), f('number', 'Superficie')], opens: 'Verifica della particella', opensTo: 'parcel' }, // allow-italian: fixture data, shown as written
    s3: { note: 'la proposta è già calcolata sul calendario del bacino', uses: [f('calendar', 'Bacino'), f('number', 'Superficie')], produces: [f('calendar', 'Turno')], due: 'entro 4 h' }, // allow-italian: fixture data, shown as written
    s4: { uses: [f('calendar', 'Turno')], trailing: 'SMS o WhatsApp' }, // allow-italian: fixture data, shown as written
    s5: { note: 'telecontrollo sviluppato internamente', uses: [f('calendar', 'Turno')], produces: [f('number', 'Erogazione')] }, // allow-italian: fixture data, shown as written
    s6: { produces: [f('calendar', 'Calendario dei turni')] }, // allow-italian: fixture data, shown as written
    s7: { uses: [f('number', 'Erogazione')] }, // allow-italian: fixture data, shown as written
  },
  gara: {
    s1: { uses: [f('file', 'Capitolato'), f('file', 'Bando')], produces: [f('file', 'Testo letto')] }, // allow-italian: fixture data, shown as written
    s2: { uses: [f('file', 'Testo letto')], produces: [f('number', 'CIG'), f('number', 'Importo'), f('folder', 'Requisiti')] }, // allow-italian: fixture data, shown as written
    s3: { note: "soglia dell'affidamento dal regolamento interno", uses: [f('number', 'CIG'), f('number', 'Importo')], produces: [f('folder', 'Procedura')] }, // allow-italian: fixture data, shown as written
    s4: { uses: [f('folder', 'Procedura')], produces: [f('link', 'Procedura sul portale')] }, // allow-italian: fixture data, shown as written
    s5: { uses: [f('folder', 'Requisiti')], due: 'entro 3 giorni' }, // allow-italian: fixture data, shown as written
    s6: { uses: [f('number', 'CIG'), f('number', 'Importo'), f('folder', 'Requisiti')], produces: [f('legal', 'Determina (bozza)')] }, // allow-italian: fixture data, shown as written
    s7: { uses: [f('legal', 'Determina (bozza)')], due: 'entro 2 giorni', opens: 'Conferma con originali', opensTo: 'inbox' }, // allow-italian: fixture data, shown as written
    s8: { uses: [f('legal', 'Determina (bozza)')], trailing: 'card in Board' }, // allow-italian: fixture data, shown as written
    s9: { produces: [f('number', 'Protocollo n.')], phase: 'registration' }, // allow-italian: fixture data, shown as written
    s10: { produces: [f('number', 'Scadenza ×n')] }, // allow-italian: fixture data, shown as written
  },
  personale: {
    s1: { note: 'solo lettura', produces: [f('calendar', 'Scadenze')], phase: 'reading' }, // allow-italian: fixture data, shown as written
    s2: { uses: [f('calendar', 'Scadenze')], produces: [f('calendar', 'In scadenza')] }, // allow-italian: fixture data, shown as written
    s3: { uses: [f('calendar', 'In scadenza')], trailing: 'mail' }, // allow-italian: fixture data, shown as written
    s4: { uses: [f('calendar', 'In scadenza')], due: 'entro 5 giorni' }, // allow-italian: fixture data, shown as written
  },
  segnalazioni: {
    s1: { uses: [f('mail', 'Segnalazione'), f('file', 'Foto')], produces: [f('folder', 'Luogo'), f('folder', 'Tipo'), f('mail', 'Canale di contatto')] }, // allow-italian: fixture data, shown as written
    s7: { note: 'stesso canale entro 7 giorni', uses: [f('folder', 'Luogo')], produces: [f('link', 'Segnalazione collegata')] }, // allow-italian: fixture data, shown as written
    s2: { uses: [f('folder', 'Luogo')], produces: [f('record', 'Canale'), f('number', 'Tratto')], opens: 'Verifica della particella', opensTo: 'parcel' }, // allow-italian: fixture data, shown as written
    s3: { note: 'allagamento o ostruzione = urgente', uses: [f('folder', 'Tipo'), f('record', 'Canale')], produces: [f('number', 'Urgenza')], due: 'entro 2 h' }, // allow-italian: fixture data, shown as written
    s4: { uses: [f('number', 'Urgenza'), f('record', 'Canale')], trailing: 'card in Board' }, // allow-italian: fixture data, shown as written
    s5: { produces: [f('file', "Foto dell'intervento"), f('folder', 'Note')] }, // allow-italian: fixture data, shown as written
    s6: { uses: [f('mail', 'Canale di contatto')] }, // allow-italian: fixture data, shown as written
  },
  concessioni: {
    s1: { uses: [f('mail', 'Richiesta')], produces: [f('folder', 'Tipo di opera'), f('record', 'Canale'), f('folder', 'Comune')] }, // allow-italian: fixture data, shown as written
    s2: { uses: [f('record', 'Canale')], produces: [f('record', 'Proprietario'), f('record', 'Particella')] }, // allow-italian: fixture data, shown as written
    s8: { uses: [f('record', 'Particella')], opens: 'Verifica della particella', opensTo: 'parcel' }, // allow-italian: fixture data, shown as written
    s3: { note: 'se la domanda è incompleta', uses: [f('mail', 'Richiesta')], trailing: 'PEC' }, // allow-italian: fixture data, shown as written
    s4: { due: 'entro 10 giorni', produces: [f('legal', 'Parere')] }, // allow-italian: fixture data, shown as written
    s5: { uses: [f('legal', 'Parere')], trailing: 'card in Board' }, // allow-italian: fixture data, shown as written
    s6: { note: 'dalla procedura già scritta in Conoscenza', uses: [f('legal', 'Parere'), f('folder', 'Tipo di opera')], produces: [f('legal', 'Disciplinare (bozza)'), f('number', 'Canone')] }, // allow-italian: fixture data, shown as written
    s7: { uses: [f('legal', 'Disciplinare (bozza)')], produces: [f('mail', 'Ricevuta di consegna')] }, // allow-italian: fixture data, shown as written
  },
  verbale: {
    v1: { note: 'nei luoghi, con foto e coordinate', produces: [f('legal', 'Verbale'), f('record', 'Particella')] }, // allow-italian: fixture data, shown as written
    v2: { uses: [f('legal', 'Verbale')], produces: [f('number', 'Protocollo n.')], phase: 'registration' }, // allow-italian: fixture data, shown as written
    v3: { note: 'notifica a valore legale', uses: [f('legal', 'Verbale')], produces: [f('mail', 'Ricevuta di notifica')] }, // allow-italian: fixture data, shown as written
    v4: { note: 'il termine parte dalla notifica', uses: [f('mail', 'Ricevuta di notifica')], produces: [f('calendar', 'Scadenza')] }, // allow-italian: fixture data, shown as written
    v5: { uses: [f('calendar', 'Scadenza')], due: 'entro 5 giorni' }, // allow-italian: fixture data, shown as written
  },
  accesso: {
    s1: { uses: [f('mail', 'PEC'), f('file', 'Istanza')], produces: [f('person', 'Richiedente'), f('folder', 'Atti richiesti')] }, // allow-italian: fixture data, shown as written
    s2: { note: 'risposta entro 30 giorni dalla richiesta', uses: [f('mail', 'PEC.data consegna')], produces: [f('calendar', 'Scadenza')] }, // allow-italian: fixture data, shown as written
    s3: { uses: [f('folder', 'Atti richiesti')], produces: [f('person', 'Controinteressati')] }, // allow-italian: fixture data, shown as written
    s4: { due: 'entro 5 giorni', uses: [f('person', 'Controinteressati')] }, // allow-italian: fixture data, shown as written
    s5: { uses: [f('folder', 'Atti richiesti')], produces: [f('legal', 'Risposta (bozza)')] }, // allow-italian: fixture data, shown as written
    s6: { uses: [f('legal', 'Risposta (bozza)')], produces: [f('mail', 'Ricevuta di consegna')] }, // allow-italian: fixture data, shown as written
  },
  'orbit-segnalazioni': {
    s1: { uses: [f('mail', 'Segnalazione')], produces: [f('record', 'Indirizzo'), f('folder', 'Tipo di servizio'), f('folder', 'Urgenza')] }, // allow-italian: fixture data, shown as written
    s7: { note: 'stesso indirizzo entro 50 m', uses: [f('record', 'Indirizzo'), f('number', 'Servizi aperti')] }, // allow-italian: fixture data, shown as written
    s2: { uses: [f('record', 'Indirizzo')], produces: [f('number', 'Ordine SAP')], phase: 'registration' }, // allow-italian: fixture data, shown as written
    s8: { uses: [f('record', 'Indirizzo')], produces: [f('number', 'Turno'), f('number', 'Mezzo')], phase: 'check' }, // allow-italian: fixture data, shown as written
    s3: { uses: [f('number', 'Turno'), f('number', 'Mezzo')], due: 'entro 2 h' }, // allow-italian: fixture data, shown as written
    s4: { uses: [f('number', 'Ordine SAP')], phase: 'work' }, // allow-italian: fixture data, shown as written
    s6: { uses: [f('number', 'Turno')] }, // allow-italian: fixture data, shown as written
    s5: { trailing: 'sempre', phase: 'registration' }, // allow-italian: fixture data, shown as written
  },
  'orbit-fatture': {
    s1: { uses: [f('file', 'Fattura')], produces: [f('number', 'Importo'), f('number', 'IVA')] }, // allow-italian: fixture data, shown as written
    s2: { uses: [f('number', 'Importo')], produces: [f('number', 'Registrazione n.')], phase: 'registration' }, // allow-italian: fixture data, shown as written
    s3: { uses: [f('number', 'Importo')], produces: [f('number', 'Differenza')] }, // allow-italian: fixture data, shown as written
    s4: { uses: [f('number', 'Differenza')], due: 'entro 1 giorno' }, // allow-italian: fixture data, shown as written
    s5: { note: 'confronto con i movimenti bancari', uses: [f('number', 'Registrazione n.')], phase: 'registration' }, // allow-italian: fixture data, shown as written
    s6: { trailing: 'mail' }, // allow-italian: fixture data, shown as written
  },
  'orbit-fir': {
    s1: { note: 'quattro copie, una al produttore', produces: [f('legal', 'FIR'), f('number', 'Peso previsto')], phase: 'registration' }, // allow-italian: fixture data, shown as written
    s2: { uses: [f('legal', 'FIR')], phase: 'work' }, // allow-italian: fixture data, shown as written
    s3: { uses: [f('legal', 'FIR')], produces: [f('number', 'Peso a destino')] }, // allow-italian: fixture data, shown as written
    s4: { uses: [f('legal', 'FIR'), f('number', 'Peso a destino')], produces: [f('number', 'Registrazione n.')] }, // allow-italian: fixture data, shown as written
    s5: { uses: [f('number', 'Peso a destino')], trailing: 'rendiconto mensile' }, // allow-italian: fixture data, shown as written
  },
};

/** What each program does in the examples, for the row label of the by-office view. */
export const PROGRAM_ROLE: Record<string, string> = {
  Halley: 'protocollo e atti', // allow-italian: fixture data, shown as written
  Prunes: 'catasto, ruoli, riscossione', // allow-italian: fixture data, shown as written
  TeamSystem: 'contabilità', // allow-italian: fixture data, shown as written
  Publisys: 'paghe', // allow-italian: fixture data, shown as written
  Traspare: 'gare telematiche', // allow-italian: fixture data, shown as written
  SAP: 'ordini di servizio', // allow-italian: fixture data, shown as written
};

/** The stage of the by-office view of the PEC flow, per step (the legal path A). */
export const PEC_PHASE: Record<string, NonNullable<StepDetail['phase']>> = {
  trigger: 'arrival', s1: 'reading', s2: 'reading', a: 'reading', b: 'check', c: 'check', d: 'check', e: 'registration', f: 'work', g: 'work',
};

/** The by-office numbers are examples: time per office and where a flow waits longest. */
export const OFFICE_TIMES: Record<string, { rows: Array<{ who: string; time: string }>; stuck: string }> = {
  pec: {
    rows: [{ who: 'Legale', time: '1 h 50 in media' }, { who: 'Direzione', time: '1,2 giorni' }], // allow-italian: fixture data, shown as written
    stuck: "La firma della Direzione: in un esempio di un mese, 2 incarichi su 6 hanno aspettato più di 2 giorni.", // allow-italian: fixture data, shown as written
  },
  fatture: {
    rows: [{ who: 'Ragioneria', time: '3 h in media' }, { who: 'Direzione', time: '0,8 giorni' }], // allow-italian: fixture data, shown as written
    stuck: 'Il visto sopra i 5.000 €: in un esempio di un mese, 9 fatture su 204 hanno aspettato più di 2 giorni.', // allow-italian: fixture data, shown as written
  },
  irrigua: {
    rows: [{ who: 'Irrigazione', time: '2 h in media' }], // allow-italian: fixture data, shown as written
    stuck: 'La conferma del turno nei giorni di punta, a inizio stagione irrigua.', // allow-italian: fixture data, shown as written
  },
  gara: {
    rows: [{ who: 'Legale', time: '1,5 giorni' }, { who: 'Direzione', time: '1 giorno' }, { who: 'Tecnico', time: '2 giorni' }], // allow-italian: fixture data, shown as written
    stuck: 'La revisione del Legale: in un esempio di un mese, la determina ha aspettato 3 giorni.', // allow-italian: fixture data, shown as written
  },
  personale: {
    rows: [{ who: 'Amministrazione', time: '20 min in media' }], // allow-italian: fixture data, shown as written
    stuck: "Nessun punto fermo: l'avviso parte da solo ogni mattina.", // allow-italian: fixture data, shown as written
  },
  segnalazioni: {
    rows: [{ who: 'Manutenzione', time: '40 min in media' }], // allow-italian: fixture data, shown as written
    stuck: "L'assegnazione della squadra nei giorni di piena.", // allow-italian: fixture data, shown as written
  },
  concessioni: {
    rows: [{ who: 'Tecnico', time: '3 giorni in media' }, { who: 'Direzione', time: '1 giorno' }], // allow-italian: fixture data, shown as written
    stuck: 'Il sopralluogo del tecnico: in prova, 3 richieste su 6 hanno aspettato più di 5 giorni.', // allow-italian: fixture data, shown as written
  },
  verbale: {
    rows: [{ who: 'Tecnico', time: '1 giorno in media' }, { who: 'Direzione', time: '2 giorni' }], // allow-italian: fixture data, shown as written
    stuck: "L'ordinanza della Direzione: in prova, 2 verbali su 6 hanno aspettato più di 5 giorni.", // allow-italian: fixture data, shown as written
  },
  'orbit-fir': {
    rows: [{ who: 'Servizi sul territorio', time: '2 giorni in media' }], // allow-italian: fixture data, shown as written
    stuck: 'Il rientro con il peso: una copia su otto arriva dopo più di 5 giorni.', // allow-italian: fixture data, shown as written
  },
  'orbit-segnalazioni': {
    rows: [{ who: 'Call center', time: '35 min in media' }], // allow-italian: fixture data, shown as written
    stuck: 'La conferma del call center nei picchi del lunedì.', // allow-italian: fixture data, shown as written
  },
  'orbit-fatture': {
    rows: [{ who: 'Amministrazione', time: '1,5 ore in media' }], // allow-italian: fixture data, shown as written
    stuck: 'Le differenze con ordine: una fattura su dieci.', // allow-italian: fixture data, shown as written
  },
};

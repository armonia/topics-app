/**
 * The flows of the example organizations, as their list shows them (n01). The
 * PEC flow is drawn in full by `../flows.ts` (w01); here every flow has its
 * name, trigger, state and steps, so a case can say which step it is at.
 * Volumes are estimates, the same the overview sums: 1.204 + 204 + 388 + 9 +
 * 105 = 1.910 for the five flows it lists; the three added after it
 * (segnalazioni 64, concessioni 10, verbale 6) bring the Nocera total to
 * 1.990. SARIM: segnalazioni 1.412, fatture 240, FIR 180. A draft does not run:
 * its volume is 0.
 *
 * Step ids follow the cases that point at them: the PEC flow keeps `s1`, `s2`,
 * the legal path `a` to `g`, and one prefix per other path (`b1`.., `c1`..,
 * `f1`..); the other flows use `s1`, `s2`, ... and the verbale `v1`..`v5`. The
 * ids are names, not positions: the order of the array is the order of the page.
 */
import type { FlowSeed } from './types';

export const FLOWS: FlowSeed[] = [
  {
    id: 'pec', org: 'nocera', name: 'PEC in arrivo → protocollo', // allow-italian: fixture data, shown as written
    trigger: 'arriva una PEC sulla casella protocollo@', // allow-italian: fixture data, shown as written
    office: 'protocollo', status: 'attivo', version: 4, perMonth: 1204, // allow-italian: state identifier, not shown
    steps: [
      { id: 's1', label: 'Prepara gli allegati', kind: 'rule', office: 'protocollo' }, // allow-italian: fixture data, shown as written
      { id: 's2', label: 'Riconosce il tipo di PEC', kind: 'classify', office: 'protocollo' }, // allow-italian: fixture data, shown as written
      { id: 'a', label: 'Estrae parti, corte, data di notifica e richieste', kind: 'ai', office: 'legale' }, // allow-italian: fixture data, shown as written
      { id: 'b', label: "Trova il contribuente e l'avviso contestato", kind: 'robot', program: 'Prunes', office: 'catasto' }, // allow-italian: fixture data, shown as written
      { id: 'c', label: 'Calcola le scadenze', kind: 'rule', office: 'legale' }, // allow-italian: fixture data, shown as written
      { id: 'd', label: 'Il Legale controlla e conferma', kind: 'person', office: 'legale' }, // allow-italian: fixture data, shown as written
      { id: 'e', label: 'Prepara la bozza di protocollo e il fascicolo «Contenzioso»', kind: 'robot', program: 'Halley', office: 'protocollo' }, // allow-italian: fixture data, shown as written
      { id: 'f', label: "L'avvocato interno prepara le controdeduzioni e l'incarico", kind: 'person', office: 'legale' }, // allow-italian: fixture data, shown as written
      { id: 'g', label: "La Direzione sceglie il legale dall'albo e firma l'incarico", kind: 'person', office: 'direzione' }, // allow-italian: fixture data, shown as written
      { id: 'b1', label: 'Estrae contribuente, tributo e richiesta', kind: 'ai', office: 'catasto' }, // allow-italian: fixture data, shown as written
      { id: 'b2', label: 'Trova il contribuente e la sua posizione', kind: 'robot', program: 'Prunes', office: 'catasto' }, // allow-italian: fixture data, shown as written
      { id: 'b3', label: 'Calcola il termine di risposta', kind: 'rule', office: 'catasto' }, // allow-italian: fixture data, shown as written
      { id: 'b4', label: "Protocolla l'istanza", kind: 'robot', program: 'Halley', office: 'protocollo' }, // allow-italian: fixture data, shown as written
      { id: 'b5', label: 'Istruttoria del Catasto e ruoli', kind: 'person', office: 'catasto' }, // allow-italian: fixture data, shown as written
      { id: 'b6', label: 'Provvedimento firmato e notificato con SEND', kind: 'person', office: 'direzione' }, // allow-italian: fixture data, shown as written
      { id: 'b7', label: 'Rimborso: ordina il pagamento', kind: 'robot', program: 'TeamSystem', office: 'ragioneria' }, // allow-italian: fixture data, shown as written
      { id: 'c1', label: 'Estrae ente, oggetto e scadenza', kind: 'ai', office: 'protocollo' }, // allow-italian: fixture data, shown as written
      { id: 'c2', label: "Assegna all'ufficio secondo il titolario", kind: 'rule', office: 'protocollo' }, // allow-italian: fixture data, shown as written
      { id: 'c3', label: 'Protocolla la comunicazione', kind: 'robot', program: 'Halley', office: 'protocollo' }, // allow-italian: fixture data, shown as written
      { id: 'c4', label: "L'ufficio prepara la risposta", kind: 'person', office: 'segreteria' }, // allow-italian: fixture data, shown as written
      { id: 'c5', label: 'Firma e invio', kind: 'person', office: 'direzione' }, // allow-italian: fixture data, shown as written
      { id: 'f1', label: 'Riconosce la richiesta di accesso e chi la fa', kind: 'ai', office: 'protocollo' }, // allow-italian: fixture data, shown as written
      { id: 'f2', label: 'Calcola la scadenza dei 30 giorni', kind: 'rule', office: 'protocollo' }, // allow-italian: fixture data, shown as written
      { id: 'f3', label: 'Annota la richiesta nel registro degli accessi', kind: 'robot', program: 'Halley', office: 'protocollo' }, // allow-italian: fixture data, shown as written
      { id: 'f4', label: 'Avvisa i controinteressati e valuta', kind: 'person', office: 'legale' }, // allow-italian: fixture data, shown as written
      { id: 'f5', label: 'Risposta firmata e inviata', kind: 'person', office: 'segreteria' }, // allow-italian: fixture data, shown as written
    ],
  },
  {
    id: 'fatture', org: 'nocera', name: 'Fattura passiva → pagamento', // allow-italian: fixture data, shown as written
    trigger: 'arriva una fattura dallo SdI', // allow-italian: fixture data, shown as written
    office: 'ragioneria', status: 'attivo', version: 2, perMonth: 204, // allow-italian: state identifier, not shown
    steps: [
      { id: 's1', label: 'Legge righe, importi e IVA', kind: 'ai', office: 'ragioneria' }, // allow-italian: fixture data, shown as written
      { id: 's2', label: 'Controlla IVA, split payment, ordine e fornitore', kind: 'rule', office: 'ragioneria' }, // allow-italian: fixture data, shown as written
      { id: 's3', label: 'Risponde allo SdI: accettata o rifiutata', kind: 'send', office: 'ragioneria' }, // allow-italian: fixture data, shown as written
      { id: 's6', label: 'La ragioneria verifica le differenze', kind: 'person', office: 'ragioneria' }, // allow-italian: fixture data, shown as written
      { id: 's7', label: 'Sceglie chi dà il visto in base agli importi', kind: 'rule', office: 'ragioneria' }, // allow-italian: fixture data, shown as written
      { id: 's8', label: 'Visto del dirigente', kind: 'person', office: 'direzione' }, // allow-italian: fixture data, shown as written
      { id: 's4', label: 'Liquidazione: registra in TeamSystem', kind: 'robot', program: 'TeamSystem', office: 'ragioneria' }, // allow-italian: fixture data, shown as written
      { id: 's9', label: 'Controllo a campione delle registrazioni', kind: 'person', office: 'ragioneria' }, // allow-italian: fixture data, shown as written
      { id: 's10', label: 'Fissa la scadenza a 30 giorni in Dati', kind: 'rule', office: 'ragioneria' }, // allow-italian: fixture data, shown as written
      { id: 's5', label: 'Pagamento: prepara il bonifico', kind: 'view', office: 'ragioneria' }, // allow-italian: fixture data, shown as written
      { id: 's11', label: 'Card in Board al pagamento', kind: 'send', office: 'ragioneria' }, // allow-italian: fixture data, shown as written
    ],
  },
  {
    id: 'irrigua', org: 'nocera', name: 'Richiesta irrigua → turno', // allow-italian: fixture data, shown as written
    trigger: 'arriva una richiesta dal modulo sul sito', // allow-italian: fixture data, shown as written
    office: 'irrigazione', status: 'attivo', version: 1, perMonth: 388, // allow-italian: state identifier, not shown
    steps: [
      { id: 's1', label: 'Legge la richiesta: bacino, particella, coltura', kind: 'ai', office: 'irrigazione' }, // allow-italian: fixture data, shown as written
      { id: 's2', label: 'Verifica bacino e particella nel catasto consortile', kind: 'robot', program: 'Prunes', office: 'catasto' }, // allow-italian: fixture data, shown as written
      { id: 's3', label: 'Il tecnico del bacino assegna il turno', kind: 'person', office: 'irrigazione' }, // allow-italian: fixture data, shown as written
      { id: 's4', label: "Avvisa l'utente con giorno e ora del turno", kind: 'send', office: 'irrigazione' }, // allow-italian: fixture data, shown as written
      { id: 's5', label: "Registra l'erogazione dal telecontrollo", kind: 'robot', program: 'Telecontrollo', office: 'irrigazione' }, // allow-italian: fixture data, shown as written
      { id: 's6', label: 'Aggiorna il calendario dei turni', kind: 'rule', office: 'irrigazione' }, // allow-italian: fixture data, shown as written
      { id: 's7', label: 'Chiude la richiesta', kind: 'rule', office: 'irrigazione' }, // allow-italian: fixture data, shown as written
    ],
  },
  {
    id: 'gara', org: 'nocera', name: 'Gara → determina', // allow-italian: fixture data, shown as written
    trigger: 'a mano, dalla chat', // allow-italian: fixture data, shown as written
    office: 'legale', status: 'attivo', version: 1, perMonth: 9, // allow-italian: state identifier, not shown
    steps: [
      { id: 's1', label: 'Legge il capitolato e il bando', kind: 'ai', office: 'legale' }, // allow-italian: fixture data, shown as written
      { id: 's2', label: 'Estrae oggetto, importo, CIG e requisiti', kind: 'ai', office: 'legale' }, // allow-italian: fixture data, shown as written
      { id: 's3', label: 'Controlla il CIG e la soglia della procedura', kind: 'rule', office: 'legale' }, // allow-italian: fixture data, shown as written
      { id: 's4', label: 'Apre la procedura sul portale di gara', kind: 'robot', program: 'Traspare', office: 'tecnico' }, // allow-italian: fixture data, shown as written
      { id: 's5', label: 'Il responsabile del procedimento controlla i requisiti', kind: 'person', office: 'tecnico' }, // allow-italian: fixture data, shown as written
      { id: 's6', label: 'Prepara la bozza di determina', kind: 'ai', office: 'legale' }, // allow-italian: fixture data, shown as written
      { id: 's7', label: 'Il Legale rivede la determina', kind: 'person', office: 'legale' }, // allow-italian: fixture data, shown as written
      { id: 's8', label: 'La Direzione firma la determina', kind: 'person', office: 'direzione' }, // allow-italian: fixture data, shown as written
      { id: 's9', label: "Protocolla la determina e la pubblica all'albo", kind: 'robot', program: 'Halley', office: 'protocollo' }, // allow-italian: fixture data, shown as written
      { id: 's10', label: 'Fissa le scadenze della procedura', kind: 'rule', office: 'legale' }, // allow-italian: fixture data, shown as written
    ],
  },
  {
    id: 'personale', org: 'nocera', name: 'Scadenzario personale', // allow-italian: fixture data, shown as written
    trigger: 'ogni giorno alle 7', // allow-italian: fixture data, shown as written
    office: 'amministrazione', status: 'attivo', version: 1, perMonth: 105, // allow-italian: state identifier, not shown
    steps: [
      { id: 's1', label: 'Legge contratti a termine, visite e certificati', kind: 'robot', program: 'Publisys', office: 'amministrazione' }, // allow-italian: fixture data, shown as written
      { id: 's2', label: 'Trova quelli che scadono entro 30 giorni', kind: 'rule', office: 'amministrazione' }, // allow-italian: fixture data, shown as written
      { id: 's3', label: 'Avvisa il responsabile del personale', kind: 'send', office: 'amministrazione' }, // allow-italian: fixture data, shown as written
      { id: 's4', label: 'Il responsabile rinnova o archivia', kind: 'person', office: 'amministrazione' }, // allow-italian: fixture data, shown as written
    ],
  },
  {
    id: 'segnalazioni', org: 'nocera', name: 'Segnalazione dal territorio → intervento', // allow-italian: fixture data, shown as written
    trigger: 'arriva una segnalazione (WhatsApp, telefono)', // allow-italian: fixture data, shown as written
    office: 'manutenzione', status: 'attivo', version: 1, perMonth: 64, // allow-italian: state identifier, not shown
    steps: [
      { id: 's1', label: 'Estrae luogo, canale e tipo di problema', kind: 'ai', office: 'manutenzione' }, // allow-italian: fixture data, shown as written
      { id: 's7', label: 'Cerca segnalazioni già aperte sullo stesso canale', kind: 'rule', office: 'manutenzione' }, // allow-italian: fixture data, shown as written
      { id: 's2', label: 'Localizza il canale e il tratto', kind: 'robot', program: 'Prunes', office: 'catasto' }, // allow-italian: fixture data, shown as written
      { id: 's3', label: "Il tecnico conferma la segnalazione e l'urgenza", kind: 'person', office: 'tecnico' }, // allow-italian: fixture data, shown as written
      { id: 's4', label: 'Sopralluogo del caposquadra', kind: 'person', office: 'manutenzione' }, // allow-italian: fixture data, shown as written
      { id: 's5', label: 'Intervento della squadra', kind: 'person', office: 'manutenzione' }, // allow-italian: fixture data, shown as written
      { id: 's6', label: 'Risponde a chi ha segnalato e chiude', kind: 'send', office: 'manutenzione' }, // allow-italian: fixture data, shown as written
    ],
  },
  {
    id: 'concessioni', org: 'nocera', name: 'Concessione o autorizzazione idraulica', // allow-italian: fixture data, shown as written
    trigger: 'arriva una richiesta di attraversamento o scarico', // allow-italian: fixture data, shown as written
    office: 'tecnico', status: 'collaudo', version: 1, perMonth: 10, // allow-italian: state identifier, not shown
    steps: [
      { id: 's1', label: 'Legge la richiesta: opera, canale, comune', kind: 'classify', office: 'tecnico' }, // allow-italian: fixture data, shown as written
      { id: 's2', label: 'Verifica la completezza: proprietà e particella', kind: 'robot', program: 'Prunes', office: 'catasto' }, // allow-italian: fixture data, shown as written
      { id: 's8', label: 'Mostra il tracciato sulla mappa', kind: 'view', office: 'tecnico' }, // allow-italian: fixture data, shown as written
      { id: 's3', label: "Chiede l'integrazione se manca qualcosa", kind: 'send', office: 'tecnico' }, // allow-italian: fixture data, shown as written
      { id: 's4', label: 'Il tecnico fa il sopralluogo e dà il parere', kind: 'person', office: 'tecnico' }, // allow-italian: fixture data, shown as written
      { id: 's5', label: 'La Direzione firma la concessione', kind: 'person', office: 'direzione' }, // allow-italian: fixture data, shown as written
      { id: 's6', label: 'Prepara il disciplinare e calcola il canone', kind: 'ai', office: 'tecnico' }, // allow-italian: fixture data, shown as written
      { id: 's7', label: 'Invia la concessione via PEC', kind: 'send', office: 'protocollo' }, // allow-italian: fixture data, shown as written
    ],
  },
  {
    id: 'verbale', org: 'nocera', name: 'Verbale di polizia idraulica', // allow-italian: fixture data, shown as written
    trigger: "arriva il verbale dell'ufficiale idraulico", // allow-italian: fixture data, shown as written
    office: 'tecnico', status: 'collaudo', version: 1, perMonth: 6, // allow-italian: state identifier, not shown
    steps: [
      { id: 'v1', label: "Accertamento dell'ufficiale idraulico", kind: 'person', office: 'tecnico' }, // allow-italian: fixture data, shown as written
      { id: 'v2', label: 'Protocolla il verbale', kind: 'robot', program: 'Halley', office: 'protocollo' }, // allow-italian: fixture data, shown as written
      { id: 'v3', label: 'Notifica via SEND', kind: 'send', office: 'protocollo' }, // allow-italian: fixture data, shown as written
      { id: 'v4', label: 'Scritti difensivi entro 30 giorni', kind: 'rule', office: 'legale' }, // allow-italian: fixture data, shown as written
      { id: 'v5', label: 'Ordinanza o archiviazione', kind: 'person', office: 'direzione' }, // allow-italian: fixture data, shown as written
    ],
  },
  {
    id: 'accesso', org: 'nocera', name: 'Accesso agli atti', // allow-italian: fixture data, shown as written
    trigger: 'arriva una PEC con «accesso»', // allow-italian: fixture data, shown as written
    office: 'protocollo', status: 'bozza', version: 1, perMonth: 0, // allow-italian: state identifier, not shown
    steps: [
      { id: 's1', label: "Riconosce la richiesta di accesso e chi la fa", kind: 'classify', office: 'protocollo' }, // allow-italian: fixture data, shown as written
      { id: 's2', label: 'Calcola la scadenza dei 30 giorni', kind: 'rule', office: 'protocollo' }, // allow-italian: fixture data, shown as written
      { id: 's3', label: 'Individua i controinteressati', kind: 'ai', office: 'legale' }, // allow-italian: fixture data, shown as written
      { id: 's4', label: 'Il Legale valuta la richiesta', kind: 'person', office: 'legale' }, // allow-italian: fixture data, shown as written
      { id: 's5', label: 'Prepara la bozza di risposta', kind: 'ai', office: 'legale' }, // allow-italian: fixture data, shown as written
      { id: 's6', label: 'Invia la risposta via PEC', kind: 'send', office: 'protocollo' }, // allow-italian: fixture data, shown as written
    ],
  },
  {
    id: 'sarim-segnalazioni', org: 'sarim', name: 'Segnalazioni AMA e utenze → intervento', // allow-italian: fixture data, shown as written
    trigger: 'arriva una segnalazione (mail AMA, portale utenze, telefonata)', // allow-italian: fixture data, shown as written
    office: 'call-center', status: 'attivo', version: 2, perMonth: 1412, // allow-italian: state identifier, not shown
    steps: [
      { id: 's1', label: 'Estrae indirizzo, tipo di rifiuto, urgenza', kind: 'ai', office: 'call-center' }, // allow-italian: fixture data, shown as written
      { id: 's7', label: 'Cerca doppioni negli ultimi 7 giorni', kind: 'rule', office: 'call-center' }, // allow-italian: fixture data, shown as written
      { id: 's2', label: "Apre l'ordine di servizio", kind: 'robot', program: 'SAP', office: 'servizi' }, // allow-italian: fixture data, shown as written
      { id: 's8', label: 'Propone turno e mezzo del cantiere di zona', kind: 'rule', office: 'servizi' }, // allow-italian: fixture data, shown as written
      { id: 's3', label: 'Il call center conferma e assegna la squadra', kind: 'person', office: 'call-center' }, // allow-italian: fixture data, shown as written
      { id: 's4', label: 'La squadra interviene', kind: 'person', office: 'servizi' }, // allow-italian: fixture data, shown as written
      { id: 's6', label: 'Avvisa il cliente con la data', kind: 'ai', office: 'call-center' }, // allow-italian: fixture data, shown as written
      { id: 's5', label: 'Esito ad AMA: foglio cantieri, Registro, rendiconto mensile', kind: 'send', office: 'servizi' }, // allow-italian: fixture data, shown as written
    ],
  },
  {
    id: 'sarim-fatture', org: 'sarim', name: 'Fattura passiva → riconciliazione', // allow-italian: fixture data, shown as written
    trigger: 'arriva una fattura dal fornitore', // allow-italian: fixture data, shown as written
    office: 'amministrazione', status: 'attivo', version: 1, perMonth: 240, // allow-italian: state identifier, not shown
    steps: [
      { id: 's1', label: 'Legge righe, importi e IVA', kind: 'ai', office: 'amministrazione' }, // allow-italian: fixture data, shown as written
      { id: 's2', label: 'Registra in SAP', kind: 'robot', program: 'SAP', office: 'amministrazione' }, // allow-italian: fixture data, shown as written
      { id: 's3', label: "Confronta con l'ordine di acquisto", kind: 'rule', office: 'amministrazione' }, // allow-italian: fixture data, shown as written
      { id: 's4', label: 'Benestare del responsabile', kind: 'person', office: 'amministrazione' }, // allow-italian: fixture data, shown as written
      { id: 's5', label: 'Pagamento: dispone il bonifico e riconcilia', kind: 'robot', program: 'SAP', office: 'amministrazione' }, // allow-italian: fixture data, shown as written
      { id: 's6', label: 'Avvisa il fornitore dello stato', kind: 'send', office: 'amministrazione' }, // allow-italian: fixture data, shown as written
    ],
  },
  {
    id: 'sarim-fir', org: 'sarim', name: 'Formulario FIR → registrazione', // allow-italian: fixture data, shown as written
    trigger: 'si chiude un ritiro con formulario', // allow-italian: fixture data, shown as written
    office: 'servizi', status: 'attivo', version: 1, perMonth: 180, // allow-italian: state identifier, not shown
    steps: [
      { id: 's1', label: 'Emette il formulario FIR', kind: 'robot', program: 'WinWaste', office: 'servizi' }, // allow-italian: fixture data, shown as written
      { id: 's2', label: "Trasporto: l'autista consegna all'impianto", kind: 'person', office: 'servizi' }, // allow-italian: fixture data, shown as written
      { id: 's3', label: 'Rientro con il peso', kind: 'person', office: 'servizi' }, // allow-italian: fixture data, shown as written
      { id: 's4', label: 'Registra su RENTRI', kind: 'rule', office: 'amministrazione' }, // allow-italian: fixture data, shown as written
      { id: 's5', label: 'Rendicontazione servizio foglie ad AMA', kind: 'send', office: 'servizi' }, // allow-italian: fixture data, shown as written
    ],
  },
];

/** The flows of one organization. */
export const flowsOf = (org: FlowSeed['org']) => FLOWS.filter((f) => f.org === org);
export const flowSeed = (id: string) => FLOWS.find((f) => f.id === id);

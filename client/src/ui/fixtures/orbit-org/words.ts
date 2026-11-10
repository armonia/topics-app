/**
 * The words of ORBIT: its name, the phrases of the copy that name its clients,
 * programs and public sources. They stand in the shape of `OrgWords`
 * (`../../copy/org-words.ts`); `orbit-org/world.ts` hands them to the world.
 */
import type { OrgWords } from '../../copy/org-words';

export const ORBIT_WORDS: OrgWords = {
  name: 'ORBIT',
  articled: { the: 'ORBIT', of: 'di ORBIT', from: 'da ORBIT', for: 'per ORBIT', inAll: 'in tutta ORBIT' }, // allow-italian: fixture data, shown as written
  legalName: 'S.A.R.I.M. SRL',
  slug: 'orbit',
  refPrefix: 'ORBIT',
  registryName: 'RENTRI',
  it: {
    townsLabel: 'Comuni serviti',
    townsAbout: 'I comuni e i committenti di ORBIT, dalle fonti pubbliche',
    servedTitle: (n) => `${n} comuni serviti, e Roma per AMA`,
    servedBody: 'Il numero è quello del contatore della home page; la Dichiarazione ambientale parla di 20 comuni, una notizia di giugno 2026 di 25.',
    numbersBody: 'I contatori della home page di orbitambiente.it, come li legge oggi.',
    organizationKeywords: 'partita iva sede legale salerno eboli pec numero verde comuni certificazioni iso emas albo gestori flotta',
    sendExamples: 'ad AMA, ai Comuni, ai fornitori',
    programsExamples: 'un ordine in SAP, un giro in WinWaste, le presenze in Zucchetti',
    flowEditExample: 'al passo 4 aggiungi chi avvisa AMA se il recupero slitta',
    approveExamples: 'pagamenti con differenze, proroghe dei contratti a termine, partecipazione',
    variantReasonExample: 'Es. estensione dello spazzamento estivo nelle frazioni costiere',
    variantFlow: 'Variante di contratto',
    views: {
      stuckReports: 'Segnalazioni ferme',
      formsToCheck: 'Formulari da verificare',
      invoicesToCheck: 'Fatture da verificare',
      staffDue: 'Personale in scadenza entro 30 giorni',
    },
    tables: {
      segnalazioni: { label: 'Segnalazioni', about: 'Una riga per card dei flussi Segnalazioni AMA e utenze e Rendiconto servizio foglie: AMA, numero verde, app, Enviro' },
      fir: { label: 'Formulari FIR', about: 'Una riga per formulario del flusso Formulario FIR' },
      fatture: { label: 'Fatture passive', about: 'Una riga per fattura del flusso Fattura passiva' },
      gare: { label: 'Gare', about: 'Una riga per gara valutata' },
      personale: { label: 'Personale', about: 'Contratti a termine, presenze, ferie e turni' },
      varianti: { label: 'Varianti e atti', about: 'Varianti, rinnovi, subappalti e accordi in lavorazione' },
      contratti: { label: 'Contratti', about: 'Ogni contratto con la versione in vigore, il valore e le scadenze' },
      comuni: { label: 'Comuni serviti', about: 'I comuni e i committenti di ORBIT, dalle fonti pubbliche' },
    },
  },
  en: {
    townsLabel: 'Towns served',
    townsAbout: 'The towns and clients of ORBIT, from public sources',
    servedTitle: (n) => `${n} towns served, and Rome for AMA`,
    servedBody: 'The number is the counter of the home page; the Environmental Statement says 20 towns, a news item of June 2026 says 25.',
    numbersBody: 'The counters of the orbitambiente.it home page, as it reads today.',
    organizationKeywords: 'vat registered office salerno eboli certified mail toll free towns certifications iso emas register fleet',
    sendExamples: 'to AMA, the towns, suppliers',
    programsExamples: 'an order in SAP, a round in WinWaste, attendance in Zucchetti',
    flowEditExample: 'at step 4 add who tells AMA when the recovery slips',
    approveExamples: 'payments with differences, extensions of fixed-term contracts, taking part',
    variantReasonExample: 'E.g. summer sweeping extended to the coastal villages',
    variantFlow: 'contract variation',
    views: {
      stuckReports: 'Stopped reports',
      formsToCheck: 'Forms to check',
      invoicesToCheck: 'Invoices to check',
      staffDue: 'Staff due within 30 days',
    },
    tables: {
      segnalazioni: { label: 'Reports', about: 'One row per card of the Segnalazioni AMA e utenze and Rendiconto servizio foglie flows: AMA, toll-free line, app, Enviro' },
      fir: { label: 'FIR forms', about: 'One row per form of the FIR form flow' },
      fatture: { label: 'Supplier invoices', about: 'One row per invoice of the supplier invoice flow' },
      gare: { label: 'Tenders', about: 'One row per tender assessed' },
      personale: { label: 'Staff', about: 'Fixed-term contracts, attendance, leave and shifts' },
      varianti: { label: 'Variations and deeds', about: 'Variations, renewals, subcontracts and agreements in progress' },
      contratti: { label: 'Contracts', about: 'Every contract with the version in force, its value and its dates' },
      comuni: { label: 'Towns served', about: 'The towns and clients of ORBIT, from public sources' },
    },
  },
};

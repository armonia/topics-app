/**
 * Fixtures of the «flows at work» area: the configuration of each step (the
 * type recognizer, an AI block, a fixed rule, a robot), the versions of a
 * flow, and the runs of the example flows.
 *
 * What is real: the organization, its programs (Halley, Prunes, TeamSystem,
 * Publisys, PA Legal, Traspare), the 60-day term of art. 23 D.Lgs. 546/1992,
 * the kinds of mail the protocol receives. What is an example, and the
 * screens say so: the people, the taxpayers, the case numbers, the volumes
 * (a stima, equal to the flows list), the percentages of the checks.
 *
 * The runs are built from a few attributes per item (type, confidence of the
 * reading, unreadable attachments, whether the sender is in the table of
 * bodies that always go to a person); the status of each run follows from
 * them, so what the table shows, what a rule decides and what the test of a
 * version finds are the same facts.
 */
import type { FieldRef } from '../types';
import type { ConditionField, RobotStepModel, UiRunStatus } from '../flowrun/model';
import type { AiConfig, ClassifyConfig, GenericConfig, RobotConfig, RuleConfig, StepChange, StepConfig, StepOverride } from '../flowrun/config';
import type { FlowSeed, FlowStepSeed } from './org/types';
import { FLOWS } from './org/flows';
import { OFFICE_LABEL } from './org/people';
import { CASES } from './org/cases';
import { CERTIFIED_MAIL_FLOW } from './flows';

/* ---------- small helpers ---------- */

/** A repeatable stream of numbers in [0, 1): the same seed gives the same runs on every load. */
function stream(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hash = (s: string) => [...s].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 7);

/* ---------- the tables of the rule page ---------- */

export const RULE_FIELDS: ConditionField[] = [
  { id: 'fiducia', label: 'fiducia della classificazione', kind: 'number' }, // allow-italian: fixture data, shown as written
  { id: 'allegati', label: 'allegati non leggibili', kind: 'number' }, // allow-italian: fixture data, shown as written
  { id: 'mittente', label: 'dominio del mittente', kind: 'list' }, // allow-italian: fixture data, shown as written
  { id: 'giorni', label: 'giorni alla scadenza', kind: 'number' }, // allow-italian: fixture data, shown as written
  { id: 'importo', label: 'importo in euro', kind: 'number' }, // allow-italian: fixture data, shown as written
];

const ALWAYS_PERSON_TABLE = {
  name: 'Enti sempre a persona', // allow-italian: fixture data, shown as written
  items: [
    'giustizia-amministrativa.it', 'pec.anticorruzione.it', 'pec.regione.campania.it', 'pec.interno.it', 'pec.agenziaentrate.it',
    'pec.giustizia.it', 'pec.mef.it', 'pec.prefettura.salerno.it', 'pec.corteconti.it', 'pec.avvocaturastato.it', 'pec.cgt.salerno.it',
  ],
};

/** The knowledge a step may read: the real documents of the organization first. */
export const KNOWLEDGE_POOL = ['Titolario 2024', 'Organigramma', 'Procedure interne', 'L.R. 7/2025', 'Regolamento di Polizia Idraulica', 'Piano di Classifica del Territorio']; // allow-italian: fixture data, shown as written

/* ---------- classification of the PEC (w02) ---------- */

const PEC_TYPES: Array<{ id: string; letter: string; name: string; when: string; share: number; correct: number; goesTo: string }> = [
  { id: 'A', letter: 'A', name: 'Ricorso o atto giudiziario', when: 'mittente avvocato o tribunale, atto notificato, parole «ricorso», «citazione», «decreto»', share: 6, correct: 100, goesTo: 'Legale, sempre persona' }, // allow-italian: fixture data, shown as written
  { id: 'B', letter: 'B', name: 'Istanza del contribuente', when: 'chiede rimborso, rateizzazione, sgravio o rettifica di un avviso', share: 210, correct: 97, goesTo: 'Ruoli e riscossione' }, // allow-italian: fixture data, shown as written
  { id: 'C', letter: 'C', name: 'Comunicazione da ente', when: 'mittente in elenco enti pubblici, nessuna richiesta di pagamento', share: 380, correct: 95, goesTo: 'secondo il titolario' }, // allow-italian: fixture data, shown as written
  { id: 'D', letter: 'D', name: 'Richiesta irrigua o segnalazione', when: "turno d'acqua, guasto, allagamento, foglio e particella", share: 140, correct: 98, goesTo: 'Tecnico' }, // allow-italian: fixture data, shown as written
  { id: 'E', letter: 'E', name: 'Fattura fuori SdI', when: 'fattura estera, nota di credito, proforma', share: 31, correct: 94, goesTo: 'Ragioneria' }, // allow-italian: fixture data, shown as written
  { id: 'F', letter: 'F', name: 'Accesso agli atti', when: 'richiama L. 241/90 o il FOIA, chiede copia di documenti', share: 12, correct: 92, goesTo: 'Protocollo' }, // allow-italian: fixture data, shown as written
  { id: 'G', letter: 'G', name: 'Non pertinente', when: 'newsletter, pubblicità, inviti generici', share: 425, correct: 99, goesTo: 'archivio' }, // allow-italian: fixture data, shown as written
];

const GENERIC_TYPES: Record<string, Array<{ name: string; when: string; share: number; goesTo: string }>> = {
  concessioni: [
    { name: 'Attraversamento di un canale', when: 'ponte, tubazione o cavo che passa sotto o sopra un canale consortile', share: 5, goesTo: 'Tecnico' }, // allow-italian: fixture data, shown as written
    { name: 'Scarico in un canale', when: 'scarico di acque in un canale di bonifica', share: 3, goesTo: 'Tecnico' }, // allow-italian: fixture data, shown as written
    { name: 'Occupazione della fascia di rispetto', when: 'recinzione, deposito o costruzione vicino al canale', share: 2, goesTo: 'Polizia idraulica' }, // allow-italian: fixture data, shown as written
    { name: 'Non pertinente', when: 'nessuna opera su un canale consortile', share: 0, goesTo: 'archivio' }, // allow-italian: fixture data, shown as written
  ],
  accesso: [
    { name: 'Accesso documentale', when: 'richiama la L. 241/90 e indica il documento', share: 7, goesTo: 'Protocollo' }, // allow-italian: fixture data, shown as written
    { name: 'Accesso civico', when: 'richiama il D.Lgs. 33/2013, documenti da pubblicare', share: 3, goesTo: 'Protocollo' }, // allow-italian: fixture data, shown as written
    { name: 'Accesso generalizzato (FOIA)', when: 'richiama il FOIA, nessun interesse specifico', share: 2, goesTo: 'Direzione' }, // allow-italian: fixture data, shown as written
    { name: 'Non pertinente', when: 'non chiede copia di documenti', share: 0, goesTo: 'archivio' }, // allow-italian: fixture data, shown as written
  ],
};

function classifyConfig(flow: FlowSeed): ClassifyConfig {
  const pec = flow.id === 'pec';
  const list = pec
    ? PEC_TYPES
    : (GENERIC_TYPES[flow.id] ?? GENERIC_TYPES.accesso).map((t, i) => ({ id: String.fromCharCode(65 + i), letter: String.fromCharCode(65 + i), correct: 94 + (i % 5), ...t }));
  const sum = list.reduce((s, t) => s + t.share, 0) || 1;
  return {
    type: 'classify',
    takes: pec
      ? [
        { field: { kind: 'mail', name: 'PEC.oggetto' }, from: 'dal passo «Quando»' }, // allow-italian: fixture data, shown as written
        { field: { kind: 'mail', name: 'PEC.mittente' }, from: 'dal passo «Quando»' }, // allow-italian: fixture data, shown as written
        { field: { kind: 'file', name: 'Allegato.testo' }, from: 'dal passo 1, solo i primi 3' }, // allow-italian: fixture data, shown as written
        { field: { kind: 'file', name: 'Titolario 2024' }, from: 'da Conoscenza' }, // allow-italian: fixture data, shown as written
      ]
      : [
        { field: { kind: 'file', name: 'Richiesta.testo' }, from: 'dal passo «Quando»' }, // allow-italian: fixture data, shown as written
        { field: { kind: 'file', name: 'Allegato.testo' }, from: 'solo i primi 3' }, // allow-italian: fixture data, shown as written
        { field: { kind: 'file', name: 'Procedure interne' }, from: 'da Conoscenza' }, // allow-italian: fixture data, shown as written
      ],
    gives: [
      { field: { kind: 'folder', name: pec ? 'Pratica.tipo' : 'Richiesta.tipo' }, note: `uno dei ${list.length} sotto, o «non so»` }, // allow-italian: fixture data, shown as written
      { field: { kind: 'folder', name: pec ? 'Pratica.ufficio' : 'Richiesta.ufficio' }, note: 'dal titolario' }, // allow-italian: fixture data, shown as written
      { field: { kind: 'folder', name: 'fiducia' }, note: '0-100%, sotto la soglia a una persona' }, // allow-italian: fixture data, shown as written
      { field: { kind: 'folder', name: 'motivo' }, note: 'una frase, va nel Registro' }, // allow-italian: fixture data, shown as written
    ],
    types: list.map((t) => ({ id: t.id, letter: t.letter, name: t.name, when: t.when, perMonth: Math.round((t.share / sum) * flow.perMonth), correct: t.correct, goesTo: t.goesTo })),
    preRules: pec
      ? [
        { id: 'p1', when: 'Mittente in «Enti sempre a persona»', then: 'tipo A o C' }, // allow-italian: fixture data, shown as written
        { id: 'p2', when: 'Oggetto con «newsletter»', then: 'G, senza AI' }, // allow-italian: fixture data, shown as written
      ]
      : [{ id: 'p1', when: 'Mittente in «Enti sempre a persona»', then: 'va a una persona' }], // allow-italian: fixture data, shown as written
    corrections: pec
      ? [
        { id: 'k1', label: 'B scambiato per C', n: 6 }, // allow-italian: fixture data, shown as written
        { id: 'k2', label: 'E scambiato per B', n: 2 }, // allow-italian: fixture data, shown as written
      ]
      : [{ id: 'k1', label: 'Scambiato con «non pertinente»', n: 2 }], // allow-italian: fixture data, shown as written
    threshold: 90,
    calibration: [[70, 6], [80, 11], [85, 15], [90, 22], [95, 31], [100, 48]],
    knowledge: ['Titolario 2024', 'Organigramma'], // allow-italian: fixture data, shown as written
  };
}

/* ---------- AI blocks (n05) ---------- */

function aiConfig(flow: FlowSeed, step: FlowStepSeed): AiConfig {
  const legal = flow.id === 'pec' && step.id === 'a';
  return {
    type: 'ai',
    prompt: legal
      ? "Leggi il ricorso o l'atto allegato alla PEC. Riporta le parti, la corte, la data di notifica e le richieste. Se la PEC parla di un ricorso, la data da riportare è quella della notifica: le scadenze le calcola la regola dopo. Cita la pagina da cui prendi ogni valore e, se un dato manca, scrivi «non presente» senza indovinare." // allow-italian: fixture data, shown as written
      : `Leggi i documenti della pratica ed esegui questo passo: «${step.label}». Rispondi solo con i campi richiesti, cita la pagina da cui prendi ogni valore e, se un dato manca, scrivi «non presente» senza indovinare.`, // allow-italian: fixture data, shown as written
    knowledge: legal ? ['Titolario 2024', 'Procedure interne'] : ['Titolario 2024', 'Organigramma'], // allow-italian: fixture data, shown as written
    knowledgePool: KNOWLEDGE_POOL,
    fields: legal
      ? [
        { id: 'f1', name: 'ricorrente', type: 'testo', required: true }, // allow-italian: fixture data, shown as written
        { id: 'f2', name: 'corte', type: 'una delle corti', required: true }, // allow-italian: fixture data, shown as written
        { id: 'f3', name: 'data di notifica', type: 'data', required: true }, // allow-italian: fixture data, shown as written
        { id: 'f4', name: 'richieste', type: 'elenco', required: false }, // allow-italian: fixture data, shown as written
        { id: 'f5', name: 'fiducia', type: '0-100%', required: true }, // allow-italian: fixture data, shown as written
      ]
      : [
        { id: 'f1', name: 'esito', type: 'testo', required: true }, // allow-italian: fixture data, shown as written
        { id: 'f2', name: 'motivo', type: 'una frase', required: true }, // allow-italian: fixture data, shown as written
        { id: 'f3', name: 'fiducia', type: '0-100%', required: true }, // allow-italian: fixture data, shown as written
      ],
    threshold: 90,
    calibration: [[70, 5], [80, 9], [85, 13], [90, 19], [95, 27], [100, 44]],
    corrections: legal ? 214 : 96 + (hash(flow.id + step.id) % 90),
    lastCorrection: 'oggi 09:31, OP', // allow-italian: fixture data, shown as written
    model: 'Claude, dati in UE', // allow-italian: fixture data, shown as written
    region: "non lasciano l'UE", // allow-italian: fixture data, shown as written
    personalData: "non lasciano l'UE", // allow-italian: fixture data, shown as written
    cost: '0,4 cent a PEC', // allow-italian: fixture data, shown as written
    lastTest: {
      label: '20 PEC di ieri', // allow-italian: fixture data, shown as written
      same: 18,
      diffs: [
        { id: 'o', label: 'Diverse, ufficio sbagliato', n: 1 }, // allow-italian: fixture data, shown as written
        { id: 'd', label: "Diverse, scadenza migliore dell'originale", n: 1 }, // allow-italian: fixture data, shown as written
      ],
    },
  };
}

/* ---------- fixed rules (n06) ---------- */

function ruleConfig(flow: FlowSeed, step: FlowStepSeed): RuleConfig {
  const pec = flow.id === 'pec';
  if (pec && step.id === 'c') {
    return {
      type: 'rule',
      question: step.label,
      thenLabel: 'avvisa subito il Legale', // allow-italian: fixture data, shown as written
      elseLabel: 'avvisi a 20 e 5 giorni prima', // allow-italian: fixture data, shown as written
      routesToPerson: false,
      conditions: [{ id: 'c1', field: 'giorni', op: 'lt', value: '20' }], // allow-italian: field name of the example data
      fields: RULE_FIELDS,
      table: ALWAYS_PERSON_TABLE,
    };
  }
  if (pec && step.id === 's1') {
    return {
      type: 'rule',
      question: step.label,
      thenLabel: 'una persona controlla gli allegati', // allow-italian: fixture data, shown as written
      elseLabel: 'gli allegati vanno alla lettura', // allow-italian: fixture data, shown as written
      routesToPerson: true,
      conditions: [{ id: 'c1', field: 'allegati', op: 'gt', value: '0' }],
      fields: RULE_FIELDS,
      table: ALWAYS_PERSON_TABLE,
    };
  }
  return {
    type: 'rule',
    question: step.label,
    thenLabel: 'decide una persona', // allow-italian: fixture data, shown as written
    elseLabel: 'continua da solo', // allow-italian: fixture data, shown as written
    /* In the flow with a classifier the threshold of the classifier is what sends to a person; these conditions only describe it. */
    routesToPerson: !pec,
    conditions: [
      { id: 'c1', field: 'fiducia', op: 'lt', value: '90' },
      { id: 'c2', field: 'mittente', op: 'in', value: ALWAYS_PERSON_TABLE.name },
      { id: 'c3', field: 'allegati', op: 'gt', value: '0' },
    ],
    fields: RULE_FIELDS,
    table: ALWAYS_PERSON_TABLE,
  };
}

/* ---------- robots (n07) ---------- */

const robotStep = (id: string, title: string, page: string, fields: Array<[string, string]>, extra: Partial<RobotStepModel> = {}): RobotStepModel => ({
  id, title, page, fields: fields.map(([label, value]) => ({ label, value })), ...extra,
});

const ROBOT_PROGRAMS: Record<string, { user: string; hours: string; steps: RobotStepModel[]; checks: string }> = {
  Halley: {
    user: 'robot.protocollo',
    hours: 'lun-ven 7-20', // allow-italian: fixture data, shown as written
    checks: 'La pagina deve contenere «Protocollo in arrivo» · il numero deve comparire entro 10 secondi · se un campo non si trova il robot si ferma, non improvvisa.', // allow-italian: fixture data, shown as written
    steps: [
      robotStep('r1', '1 · Nuovo in arrivo', 'HALLEY · Protocollo', [['Arrivo', '›'], ['Partenza', ''], ['Interno', '']], { detail: 'menu Protocollo › Arrivo' }), // allow-italian: fixture data, shown as written
      robotStep('r2', '2 · Mittente e oggetto', 'HALLEY · Arrivo', [['Mittente', 'avv. …'], ['Oggetto', 'Ricorso…']], { sources: [{ kind: 'file', name: 'mittente' }, { kind: 'file', name: 'oggetto' }] }), // allow-italian: fixture data, shown as written
      robotStep('r3', '3 · Titolario e ufficio', 'HALLEY · Arrivo', [['Titolario', '2.4'], ['Ufficio', 'Legale']], { sources: [{ kind: 'file', name: 'titolario' }, { kind: 'file', name: 'ufficio' }] }), // allow-italian: fixture data, shown as written
      robotStep('r4', '4 · Allega i file', 'HALLEY · Allegati', [['PEC', '.eml'], ['File', '3']], { detail: 'PEC originale e allegati' }), // allow-italian: fixture data, shown as written
      robotStep('r5', '5 · Salva', 'HALLEY · Arrivo', [['', 'Registra']], { detail: 'pulsante «Registra»' }), // allow-italian: fixture data, shown as written
      robotStep('r6', '6 · Legge il numero', 'HALLEY · Arrivo', [['N.', '2026/…']], { detail: 'diventa il campo', sources: [{ kind: 'file', name: 'protocollo' }], result: 'N. 2026/…' }), // allow-italian: fixture data, shown as written
    ],
  },
  Prunes: {
    user: 'robot.catasto',
    hours: 'lun-ven 7-20', // allow-italian: fixture data, shown as written
    checks: 'La scheda deve mostrare il codice contribuente cercato · la ricerca deve dare un solo risultato · se i risultati sono due il robot si ferma e lo dice.', // allow-italian: fixture data, shown as written
    steps: [
      robotStep('r1', '1 · Anagrafica contribuenti', 'PRUNES · Catasto', [['Ricerca', ''], ['Anno', '2025']], { detail: 'menu Catasto › Contribuenti' }), // allow-italian: fixture data, shown as written
      robotStep('r2', '2 · Cerca il contribuente', 'PRUNES · Contribuenti', [['Cod. fiscale', 'dal ricorso'], ['Nome', '']], { sources: [{ kind: 'record', name: 'ricorrente' }] }), // allow-italian: fixture data, shown as written
      robotStep('r3', "3 · Apre l'avviso", 'PRUNES · Avvisi', [['Anno', '2025'], ['Importo', '1.248 €']], { detail: "scheda «Avvisi» dell'anno" }), // allow-italian: fixture data, shown as written
      robotStep('r4', '4 · Legge codice e importo', 'PRUNES · Avvisi', [['Codice', 'C-0048213']], { detail: 'diventano i campi', sources: [{ kind: 'record', name: 'contribuente' }, { kind: 'number', name: 'importo' }], result: 'C-0048213 · 1.248 €' }), // allow-italian: fixture data, shown as written
    ],
  },
};

function robotConfig(flow: FlowSeed, step: FlowStepSeed): RobotConfig {
  const program = step.program ?? 'Halley';
  const preset = ROBOT_PROGRAMS[program] ?? {
    user: `robot.${(step.office ?? flow.office).slice(0, 10)}`,
    hours: 'lun-ven 7-20', // allow-italian: fixture data, shown as written
    checks: `La pagina deve essere quella attesa di ${program} · il risultato deve comparire entro 10 secondi · se un campo non si trova il robot si ferma, non improvvisa.`, // allow-italian: fixture data, shown as written
    steps: [
      robotStep('r1', `1 · Apre ${program}`, `${program.toUpperCase()} · Menu`, [['Voce', 'dal flusso']], { detail: `menu principale di ${program}` }), // allow-italian: fixture data, shown as written
      robotStep('r2', '2 · Compila i campi', `${program.toUpperCase()} · Scheda`, [['Campo 1', 'dal flusso'], ['Campo 2', 'dal flusso']], { sources: [{ kind: 'file', name: 'campi della pratica' }] }), // allow-italian: fixture data, shown as written
      robotStep('r3', '3 · Salva', `${program.toUpperCase()} · Scheda`, [['', 'Salva']], { detail: 'pulsante «Salva»' }), // allow-italian: fixture data, shown as written
      robotStep('r4', '4 · Legge il risultato', `${program.toUpperCase()} · Scheda`, [['Esito', 'registrato']], { detail: 'diventa il campo', sources: [{ kind: 'number', name: 'esito' }], result: 'registrato' }), // allow-italian: fixture data, shown as written
    ],
  };
  const total = program === 'Halley' ? 412 : 120 + (hash(program) % 200);
  const failed = program === 'Halley' ? 1 : hash(program) % 3;
  const random = stream(hash(flow.id + step.id));
  return {
    type: 'robot',
    program,
    // The page carries the name of the step in the flow, so the list, the page and a run name it the same.
    title: step.label,
    intro: "Sono i passi che una persona ha fatto una volta sul programma, registrati e ripetuti uguali ogni volta. L'AI non clicca: se la pagina non è quella attesa il robot si ferma e passa la pratica a una persona.", // allow-italian: fixture data, shown as written
    user: preset.user,
    vault: `${program.toLowerCase()}/${preset.user}`,
    where: 'server di Topics, nel browser', // allow-italian: fixture data, shown as written
    hours: preset.hours,
    offHours: 'wait',
    oneAtATime: true,
    retries: 3,
    everyMin: 2,
    then: `alla persona di ${OFFICE_LABEL[step.office ?? flow.office].toLowerCase()}`, // allow-italian: fixture data, shown as written
    notify: 'Armonia e RP', // allow-italian: fixture data, shown as written
    steps: preset.steps,
    checks: preset.checks,
    runs: {
      days: Array.from({ length: 30 }, (_, i) => ({ value: 0.35 + random() * 0.65, failed: failed > 0 && i === 29 })),
      ok: total - failed,
      total,
      medianSec: program === 'Halley' ? 31 : 18 + (hash(program) % 40),
    },
  };
}

/* ---------- the other kinds of step (w01) ---------- */

/** The steps of the PEC flow that the first screen (w01) already describes in full. */
const PEC_STEP_MODEL = new Map(
  [...CERTIFIED_MAIL_FLOW.steps, ...(CERTIFIED_MAIL_FLOW.branch.paths.find((p) => p.id === 'pA')?.steps ?? [])].map((s) => [s.id, s]),
);

const DEFAULT_USES: Record<string, FieldRef[]> = {
  person: [{ kind: 'folder', name: 'Pratica' }, { kind: 'file', name: 'Originali' }], // allow-italian: fixture data, shown as written
  program: [{ kind: 'folder', name: 'Pratica' }],
  view: [{ kind: 'record', name: 'Pratica.dati' }], // allow-italian: fixture data, shown as written
  send: [{ kind: 'folder', name: 'Pratica' }, { kind: 'file', name: 'Bozza' }], // allow-italian: fixture data, shown as written
};
const DEFAULT_MAKES: Record<string, FieldRef[]> = {
  person: [{ kind: 'bolt', name: 'Decisione' }], // allow-italian: fixture data, shown as written
  program: [{ kind: 'number', name: 'Esito' }], // allow-italian: fixture data, shown as written
  view: [{ kind: 'link', name: 'Vista aperta' }], // allow-italian: fixture data, shown as written
  send: [{ kind: 'mail', name: 'Ricevuta' }], // allow-italian: fixture data, shown as written
};

function genericConfig(flow: FlowSeed, step: FlowStepSeed): GenericConfig {
  const model = flow.id === 'pec' ? PEC_STEP_MODEL.get(step.id) : undefined;
  const hoursOf = (due?: string) => Number(/(\d+)\s*h/.exec(due ?? '')?.[1] ?? (step.kind === 'person' ? 8 : 0));
  return {
    type: 'generic',
    office: step.office ?? flow.office,
    hours: hoursOf(model?.due),
    note: step.kind === 'person'
      ? 'Controlla i valori proposti con gli originali accanto, correggi quello che non torna e conferma.' // allow-italian: fixture data, shown as written
      : step.kind === 'send'
        ? 'Il messaggio parte solo dopo la conferma di una persona; la ricevuta resta nella pratica.' // allow-italian: fixture data, shown as written
        : 'Passo automatico: non serve fare niente. Se qualcosa non va, la pratica passa a una persona.', // allow-italian: fixture data, shown as written
    uses: model?.uses ?? DEFAULT_USES[step.kind] ?? [],
    produces: model?.produces ?? DEFAULT_MAKES[step.kind] ?? [],
    opens: model?.opens ?? (step.kind === 'person' ? 'Conferma con originali' : step.kind === 'view' ? 'Vista della pratica' : undefined), // allow-italian: fixture data, shown as written
  };
}

export function stepConfig(flow: FlowSeed, step: FlowStepSeed): StepConfig {
  switch (step.kind) {
    case 'classify': return classifyConfig(flow);
    case 'ai': return aiConfig(flow, step);
    case 'rule': return ruleConfig(flow, step);
    case 'robot': return robotConfig(flow, step);
    default: return genericConfig(flow, step);
  }
}

/* ---------- versions ---------- */

export interface VersionSeed {
  n: number;
  status: 'active' | 'testing' | 'draft' | 'old';
  who: string;
  at: string;
  summary: string;
  /** Laid on the step configurations of the active version. */
  overrides: Record<string, StepOverride>;
  /** Steps the version adds, which the flow's own list does not have. */
  added: Extract<StepChange, { kind: 'added' }>[];
}

const OLD_SUMMARIES = [
  'Prima versione: legge e smista, tutto passa da una persona', // allow-italian: fixture data, shown as written
  'Aggiunta la tabella degli enti che vanno sempre a una persona', // allow-italian: fixture data, shown as written
  'Le scadenze del ricorso si calcolano con la regola', // allow-italian: fixture data, shown as written
  'Soglia di fiducia al 90% e registrazione in Halley', // allow-italian: fixture data, shown as written
];

export function baseVersions(flow: FlowSeed): VersionSeed[] {
  const out: VersionSeed[] = [];
  const active = flow.version;
  for (let n = 1; n <= active; n++) {
    const last = n === active;
    out.push({
      n,
      status: last ? (flow.status === 'attivo' ? 'active' : flow.status === 'collaudo' ? 'testing' : 'draft') : 'old', // allow-italian: status value of the flow seed
      who: last && flow.status !== 'attivo' ? 'Attilio (Armonia)' : n % 2 ? 'Attilio (Armonia)' : 'Direttore (DIR)', // allow-italian: fixture data, shown as written
      at: `2026-${String(Math.max(8, 10 - (active - n))).padStart(2, '0')}-${String(6 + n * 4).padStart(2, '0')}T11:00:00+02:00`,
      summary: flow.id === 'pec' ? OLD_SUMMARIES[n - 1] : n === 1 ? 'Prima versione del flusso' : 'Aggiornate le soglie dopo il collaudo', // allow-italian: fixture data, shown as written
      overrides: {},
      added: [],
    });
  }
  if (flow.id === 'pec') {
    out.push({
      n: 5,
      status: 'testing',
      who: 'Attilio (Armonia)', // allow-italian: fixture data, shown as written
      at: '2026-11-03T16:20:00+01:00',
      summary: "Soglia all'85% e nuovo flusso «Accesso agli atti»", // allow-italian: fixture data, shown as written
      overrides: { s2: { threshold: 85 } },
      added: [
        { kind: 'added', after: 's2', stepKind: 'rule', title: 'È una richiesta di accesso agli atti?', note: 'parole chiave + mittente privato' }, // allow-italian: fixture data, shown as written
        { kind: 'added', after: 's2', stepKind: 'send', title: 'se sì: avvia il flusso «Accesso agli atti»' }, // allow-italian: fixture data, shown as written
      ],
    });
  }
  return out;
}

/** Day of a version's collaudo (the one running): the preview has the test of the PEC flow on day 4 of 7. */
export const TRIAL_DAY = { day: 4, of: 7 };

/* ---------- runs ---------- */

export interface RunSeed {
  id: string;
  n: number;
  flow: string;
  caseId: string;
  title: string;
  /** ISO date-time. */
  arrived: string;
  day: 'today' | 'yesterday';
  status: UiRunStatus;
  /** The step where the run is, or stopped. Finished runs: the last step they went through. */
  stepId: string;
  /** The steps the run goes through, in order. */
  path: string[];
  type?: string;
  confidence: number;
  unreadable: number;
  senderListed: boolean;
  daysLeft: number;
  amount: number;
  /** Seconds, for a run that finished. */
  durationSec: number;
  /** A person took part: the step they worked in. */
  personStepId?: string;
  attempts: number;
  protocol?: string;
  /** A run that waited (on a person, overnight) and went on: when it did, so the later steps are timed from there. */
  resumedAt?: string;
}

interface PoolItem { t: string; ty: string; c: number; u?: number; l?: boolean }

const PEC_POOL: PoolItem[] = [
  { t: 'Newsletter fornitore', ty: 'G', c: 99 }, // allow-italian: fixture data, shown as written
  { t: 'Avviso INPS, comunicazione DURC', ty: 'C', c: 94 }, // allow-italian: fixture data, shown as written
  { t: 'Comune di Angri, lavori', ty: 'C', c: 88 }, // allow-italian: fixture data, shown as written
  { t: 'Istanza di rateizzazione, contribuente', ty: 'B', c: 97 }, // allow-italian: fixture data, shown as written
  { t: 'Ente locale, convocazione', ty: 'C', c: 87 }, // allow-italian: fixture data, shown as written
  { t: 'Fattura Enel energia, ottobre', ty: 'E', c: 98, u: 1 }, // allow-italian: fixture data, shown as written
  { t: 'Regione Campania, nota L.R. 7/2025', ty: 'C', c: 95, l: true }, // allow-italian: fixture data, shown as written
  { t: 'Richiesta irrigua, bacino 3', ty: 'D', c: 98 }, // allow-italian: fixture data, shown as written
  { t: 'Segnalazione allagamento, Castel San Giorgio', ty: 'D', c: 96 }, // allow-italian: fixture data, shown as written
  { t: 'Ricorso CGT, contribuente', ty: 'A', c: 96, l: true }, // allow-italian: fixture data, shown as written
  { t: 'Comune di Sarno, lavori via Lanzara', ty: 'C', c: 91 }, // allow-italian: fixture data, shown as written
  { t: 'Istanza di sgravio, contribuente', ty: 'B', c: 95 }, // allow-italian: fixture data, shown as written
  { t: 'Pubblicità software gestionale', ty: 'G', c: 99 }, // allow-italian: fixture data, shown as written
  { t: 'Invito a un convegno', ty: 'G', c: 98 }, // allow-italian: fixture data, shown as written
  { t: 'Comunicazione ANAC', ty: 'C', c: 96, l: true }, // allow-italian: fixture data, shown as written
  { t: 'Avviso di pagamento contestato, contribuente', ty: 'B', c: 93 }, // allow-italian: fixture data, shown as written
  { t: 'Richiesta turno irriguo, bacino 5', ty: 'D', c: 97 }, // allow-italian: fixture data, shown as written
  { t: 'Fattura fornitore, scansione', ty: 'E', c: 98, u: 1 }, // allow-italian: fixture data, shown as written
  { t: 'Comune di Nocera Superiore, convenzione', ty: 'C', c: 92 }, // allow-italian: fixture data, shown as written
  { t: 'Rettifica di un avviso, contribuente', ty: 'B', c: 91 }, // allow-italian: fixture data, shown as written
  { t: 'Guasto a un pozzo, segnalazione', ty: 'D', c: 94 }, // allow-italian: fixture data, shown as written
  { t: 'Ricorso al TAR, azienda agricola', ty: 'A', c: 95, l: true }, // allow-italian: fixture data, shown as written
  { t: 'Comunicazione dal Comune di Bracigliano', ty: 'C', c: 84 }, // allow-italian: fixture data, shown as written
  { t: 'Istanza con allegato illeggibile', ty: 'B', c: 90, u: 2 }, // allow-italian: fixture data, shown as written
];

/** Yesterday: the 38 PEC the test of version 5 is run on (n09). */
const YESTERDAY_SPECIAL: PoolItem[] = [
  { t: 'Avviso INPS', ty: 'C', c: 86 }, // allow-italian: fixture data, shown as written
  { t: 'Comune di Angri, lavori', ty: 'C', c: 88 }, // allow-italian: fixture data, shown as written
  { t: 'Ente locale, convocazione', ty: 'C', c: 87 }, // allow-italian: fixture data, shown as written
  { t: 'Comune di Siano, nota', ty: 'C', c: 89 }, // allow-italian: fixture data, shown as written
  { t: 'Richiesta di accesso agli atti', ty: 'F', c: 93 }, // allow-italian: fixture data, shown as written
];

const at = (day: string, minutes: number) =>
  `${day}T${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}:00+01:00`;
export const TODAY = '2026-11-06';
/** When the Halley robot stopped on its refused password (the Registro says 09:50). */
const ROBOT_STOPPED_AT = at('2026-11-06', 590);
export const YESTERDAY = '2026-11-05';

/** Minutes after midnight of the arrival of runs 403..412, as the table of the mockup prints them. */
const PEC_FIRST_TEN = [461, 478, 490, 502, 510, 524, 531, 538, 545, 552];

function pecRuns(flow: FlowSeed): RunSeed[] {
  const stepIds = flow.steps.map((s) => s.id);
  const robotId = flow.steps.find((s) => s.kind === 'robot' && s.program === 'Halley')?.id ?? stepIds[stepIds.length - 1];
  const personId = flow.steps.find((s) => s.kind === 'person')?.id ?? stepIds[stepIds.length - 1];
  const pathOf = (ty: string, person: boolean): string[] => {
    // The legal path is its own steps (s1, s2, a to g): b1 onwards are the paths of the other types, not steps of a type A run.
    if (ty === 'A') return stepIds.slice(0, stepIds.indexOf('b1'));
    if (ty === 'G') return stepIds.slice(0, 2);
    const out = [...stepIds.slice(0, 2)];
    if (person) out.push(personId);
    if (!out.includes(robotId)) out.push(robotId);
    return out;
  };
  const out: RunSeed[] = [];
  /* Today: e-0391 to e-0431, 41 runs (e-0411, case 2418, is moved to yesterday below). */
  const todayFirst = 391;
  const random = stream(412);
  for (let i = 0; i < 41; i++) {
    const n = todayFirst + i;
    const p = n === 412 ? PEC_POOL[21] : PEC_POOL[(i * 7 + 3) % PEC_POOL.length];
    const minutes = n >= 403 && n <= 412 ? PEC_FIRST_TEN[n - 403] : n < 403 ? 420 + Math.round(((n - 391) * 38) / 12) : 552 + Math.round(((n - 412) * 73) / 19);
    const needsPerson = p.ty === 'A' || p.c < 90 || (p.u ?? 0) > 0;
    out.push({
      id: `e-${String(n).padStart(4, '0')}`, n, flow: flow.id, caseId: String(n + 2006), title: p.t,
      arrived: at(TODAY, minutes), day: 'today', status: 'done', stepId: stepIds[0], path: pathOf(p.ty, needsPerson),
      type: p.ty, confidence: p.c, unreadable: p.u ?? 0, senderListed: Boolean(p.l), daysLeft: 8 + Math.round(random() * 50),
      amount: Math.round(random() * 4000), durationSec: needsPerson ? 1800 + Math.round(random() * 9000) : p.ty === 'G' ? 8 : 40 + Math.round(random() * 80),
      personStepId: needsPerson ? personId : undefined, attempts: 0,
    });
  }
  /* The ones that wait on a person: the nine most recent of those that need one, among the runs not stopped or still running. */
  const free = out.filter((r) => r.n !== 412 && !(r.n >= 413 && r.n <= 416) && r.n < 429);
  const needing = free.filter((r) => r.personStepId).sort((a, b) => b.n - a.n);
  for (const r of needing.slice(0, 9)) { r.status = 'person'; r.stepId = r.personStepId!; r.durationSec = 0; }
  for (const r of out) {
    /* The stopped run is case 2417 (as the Registro says), not 2418: 2418 still waits for the Legale's confirmation,
       so its run waits at the person step (e-0411), and a robot cannot have stopped protocolling it. */
    if (r.n === 411) {
      // Case 2418 arrived on 05/11 at 09:12 and waits for the Legale since: its run is listed under yesterday, at the person step.
      Object.assign(r, { caseId: '2418', title: 'Ricorso CGT, azienda agricola', arrived: '2026-11-05T09:12:04+01:00', day: 'yesterday', type: 'A', confidence: 96, unreadable: 0, path: pathOf('A', true), personStepId: personId, status: 'person', stepId: personId, durationSec: 0 }); // allow-italian: fixture data, shown as written
    }
    if (r.n === 412) { r.caseId = '2417'; r.title = 'Avviso contestato, ricorso del contribuente'; r.arrived = '2026-11-05T08:52:40+01:00'; r.resumedAt = '2026-11-06T09:41:00+01:00'; r.status = 'error'; r.stepId = robotId; r.attempts = 3; r.path = pathOf('A', true); r.type = 'A'; r.durationSec = 0; r.personStepId = personId; } // allow-italian: fixture data, shown as written
    else if (r.n >= 413 && r.n <= 416) { r.status = 'blocked'; r.stepId = robotId; r.path = [...stepIds.slice(0, 2), personId, robotId]; r.personStepId = personId; r.durationSec = 0; }
    else if (r.n >= 429) { r.status = 'running'; r.stepId = r.path[Math.min(1, r.path.length - 1)]; r.durationSec = 0; }
    else if (r.status === 'done' && r.type !== 'G' && r.arrived >= ROBOT_STOPPED_AT) {
      // The robot stopped at 09:50: whatever reaches its step after that waits there, like e-0413 to e-0416.
      r.status = 'blocked'; r.stepId = robotId; r.durationSec = 0;
    }
    else if (r.status === 'done') { r.stepId = r.path[r.path.length - 1]; if (r.type === 'G') r.status = 'archived'; }
  }
  /* Yesterday: e-0353 to e-0390, 38 runs, all finished (e-0411, case 2418, joins them above, still waiting). */
  const randomSecond = stream(353);
  const specials = YESTERDAY_SPECIAL;
  for (let i = 0; i < 38; i++) {
    const n = 353 + i;
    const s = i < specials.length ? specials[i] : null;
    const base = s ?? PEC_POOL[(i * 5 + 1) % PEC_POOL.length];
    /* Keep the plain ones out of the band the test of version 5 moves (85 to 89). */
    const c = s ? s.c : base.c >= 85 && base.c < 90 ? 92 : base.c;
    const low = !s && (i === 11 || i === 19 || i === 27);
    const conf = low ? 72 + (i % 9) : c;
    const u = !s ? (base.u ?? 0) : 0;
    const needsPerson = base.ty === 'A' || conf < 90 || u > 0;
    out.push({
      id: `e-${String(n).padStart(4, '0')}`, n, flow: flow.id, caseId: String(n + 2006), title: low ? 'Comunicazione con allegato poco chiaro' : base.t, // allow-italian: fixture data, shown as written
      arrived: at(YESTERDAY, 425 + i * 22 + Math.round(randomSecond() * 8)), day: 'yesterday', status: base.ty === 'G' ? 'archived' : 'done',
      stepId: pathOf(base.ty, needsPerson)[pathOf(base.ty, needsPerson).length - 1], path: pathOf(base.ty, needsPerson), type: base.ty,
      confidence: conf, unreadable: u, senderListed: Boolean(base.l), daysLeft: 8 + Math.round(randomSecond() * 50), amount: Math.round(randomSecond() * 4000),
      durationSec: base.ty === 'G' ? 8 : needsPerson ? 1500 + Math.round(randomSecond() * 7000) : 40 + Math.round(randomSecond() * 80),
      personStepId: needsPerson ? personId : undefined, attempts: 0,
    });
  }
  return out.map((r) => {
    const example = CASES.find((c) => c.id === r.caseId);
    // A run follows the state of its case: unconfirmed means waiting for the person with no protocol, confirmed means the case's own number.
    if (example && example.status === 'da-confermare' && (r.status === 'done' || r.status === 'archived')) {
      return { ...r, status: 'person', stepId: personId, personStepId: personId, durationSec: 0, protocol: undefined, path: r.path.includes(personId) ? r.path : [...stepIds.slice(0, 2), personId, robotId] };
    }
    if (r.status === 'done' && !r.personStepId) return { ...r, protocol: example?.protocol?.number ?? `2026/00${18000 + r.n}` };
    return r;
  });
}

const GENERIC_TITLES = [
  'Caso di esempio, ', // allow-italian: fixture data, shown as written
];

function genericRuns(flow: FlowSeed): RunSeed[] {
  if (flow.status === 'bozza') return [];
  const stepIds = flow.steps.map((s) => s.id);
  const personId = flow.steps.find((s) => s.kind === 'person')?.id;
  const robotId = flow.steps.find((s) => s.kind === 'robot')?.id;
  const random = stream(hash(flow.id));
  const perDay = flow.status === 'collaudo' ? 3 : Math.max(1, Math.round(flow.perMonth / 22));
  const out: RunSeed[] = [];
  const make = (day: 'today' | 'yesterday', count: number, firstN: number) => {
    for (let i = 0; i < count; i++) {
      const n = firstN + i;
      const conf = random() < 0.3 ? 78 + Math.round(random() * 11) : 90 + Math.round(random() * 9);
      const needsPerson = Boolean(personId) && conf < 90;
      const last = day === 'today' && i === count - 1 && count > 2;
      const waiting = day === 'today' && needsPerson && i >= count - 4;
      out.push({
        id: `${flow.id}-${String(n).padStart(4, '0')}`, n, flow: flow.id, caseId: `${flow.id}-${n}`,
        title: `${GENERIC_TITLES[0]}${flow.name.split(' ')[0].toLowerCase()} n. ${n}`, // allow-italian: fixture data, shown as written
        arrived: at(day === 'today' ? TODAY : YESTERDAY, 430 + Math.round((i * 160) / count) + Math.round(random() * 5)), day,
        status: last ? 'running' : waiting ? 'person' : 'done',
        stepId: last ? stepIds[1] ?? stepIds[0] : waiting ? personId! : stepIds[stepIds.length - 1],
        path: stepIds, confidence: conf, unreadable: random() < 0.08 ? 1 : 0, senderListed: random() < 0.15, daysLeft: 8 + Math.round(random() * 50),
        amount: Math.round(random() * 8000), durationSec: needsPerson ? 1200 + Math.round(random() * 6000) : 25 + Math.round(random() * 150),
        personStepId: needsPerson ? personId : undefined, attempts: 0,
      });
    }
    return robotId;
  };
  make('today', perDay, 100);
  make('yesterday', Math.max(1, perDay + 1), 60);
  return out;
}

const RUN_CACHE = new Map<string, RunSeed[]>();

/** The runs of a flow, today's and yesterday's, newest first. */
export function runsOf(flowId: string): RunSeed[] {
  const hit = RUN_CACHE.get(flowId);
  if (hit) return hit;
  const flow = FLOWS.find((f) => f.id === flowId);
  const list = flow ? (flow.id === 'pec' ? pecRuns(flow) : genericRuns(flow)) : [];
  const sorted = [...list].sort((a, b) => ((a.resumedAt ?? a.arrived) < (b.resumedAt ?? b.arrived) ? 1 : -1));
  RUN_CACHE.set(flowId, sorted);
  return sorted;
}

/** The run that stopped: the robot could not enter Halley after the password change. */
export const STUCK_RUN = { flow: 'pec', id: 'e-0412' };

/** What the robot saw on the page it stopped on, as the run page draws it. */
export const STUCK_PAGE = {
  program: 'HALLEY', // allow-italian: fixture data, shown as written
  title: 'Accesso al sistema', // allow-italian: fixture data, shown as written
  user: 'robot.protocollo',
  warning: 'Password scaduta: cambiala per continuare', // allow-italian: fixture data, shown as written
  button: 'Accedi', // allow-italian: fixture data, shown as written
};

/** What the people on the run were told, and when it happens: the preview starts with two lines. */
export const STUCK_NOTICED = [
  { who: 'Armonia, supporto', how: 'subito' }, // allow-italian: fixture data, shown as written
  { who: 'RP, protocollo', how: 'su Teams' }, // allow-italian: fixture data, shown as written
];

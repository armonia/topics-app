/**
 * client/src/lib/i18n-hub-context-it.ts - the strings of the hub's rows in
 * System and of the agents' context level (hub-smistamento, HUBBR-17): weight
 * per harness, files, duplicates, old rules and the contradictions check; in
 * Italian, the mirror of `i18n-hub-context-en.ts`.
 *
 * Loaded with the rows' own chunk (`addCatalogue` in `i18n.ts`). A leaf: it
 * takes its type from `i18n-types.ts` and imports nothing else.
 */
import type { Dict } from './i18n-types';

const HUB_CONTEXT_IT: Dict = {
  'hubContext.open': 'Contesto degli agenti',
  'hubContext.tail': '{n} tok di base',
  'hubContext.featuresTail': 'Jarvis indietro su {n}',
  'hubContext.back': 'Sistema',
  'hubContext.close': 'Chiudi',
  'hubContext.reading': 'lettura in corso',
  'hubContext.readAt': 'letto alle {time}',
  'hubContext.hubDown': 'Hub non raggiungibile',
  'hubContext.hubDownSince': 'Hub fermo · dati delle {time}',
  'hubContext.retry': 'Riprova',
  'hubContext.empty': "L'hub non ha ancora letto il contesto",
  'hubContext.tok': '{n} tok',
  'hubContext.weight': 'Peso per harness',
  'hubContext.weight.hint': 'letto prima della prima parola',
  'hubContext.weight.home': '+{n} tok nelle sessioni aperte nella home',
  'hubContext.weight.some': '+{n} tok in alcune sessioni',
  'hubContext.contradictions': 'Contraddizioni',
  'hubContext.check.at': 'controllate {when}',
  'hubContext.check.never': 'Le regole non sono mai state confrontate fra loro.',
  'hubContext.check.none': "Nessuna contraddizione all'ultimo controllo.",
  'hubContext.check.go': 'Cerca contraddizioni',
  'hubContext.check.again': 'Controlla di nuovo',
  'hubContext.check.confirm': 'Un agente legge tutte le regole e cerca quelle che si contraddicono. Ci mette qualche minuto e consuma quota.',
  'hubContext.check.start': 'Avvia il controllo',
  'hubContext.check.cancel': 'Annulla',
  'hubContext.check.running': 'Un agente sta leggendo le regole',
  'hubContext.check.runningHint': 'le contraddizioni arrivano qui e nella campanella',
  'hubContext.check.failed': 'Il controllo non è partito: {why}',
  'hubContext.check.lastFailed': "L'ultimo controllo non è finito: {why}",
  'hubContext.check.vs': 'contro',
  'hubContext.files': "Letti all'avvio",
  'hubContext.files.hint': 'tocca per leggere',
  'hubContext.skills': 'Elenco delle skill',
  'hubContext.skills.meta': '{n} skill, nome e descrizione',
  'hubContext.onDemand': 'Letti su richiesta',
  'hubContext.onDemand.hint': 'non pesano finché nessuno li apre',
  'hubContext.more': 'altri {n}',
  'hubContext.less': 'mostra meno',
  'hubContext.duplicates': 'Doppioni',
  'hubContext.duplicates.hint': 'la stessa riga in più file',
  'hubContext.duplicates.none': 'Nessuna riga ripetuta fra i file.',
  'hubContext.oldRules': 'Regole vecchie',
  'hubContext.oldRules.hint': 'con una data di oltre 45 giorni',
  'hubContext.oldRules.meta': '{where} · {days} giorni fa',
  'hubContext.where.rules': 'Regole di {owner}',
  'hubContext.where.profile': 'Profilo di {owner}',
  'hubContext.where.memory': 'Memoria di {owner}',
  'hubContext.where.other': '{name} di {owner}',
  'hubContext.where.bare': '{name}',
  'hubContext.doctor.ok': '{n} controlli dei collegamenti: tutti verdi',
  'hubContext.doctor.fail': 'Da sistemare',
  'hubContext.text.loading': 'apertura del testo',
  'hubContext.text.failed': 'Il testo di questo file non si legge da qui.',
  'hubContext.when.today': 'oggi alle {time}',
  'hubContext.when.day': 'il {date} alle {time}',
};

export default HUB_CONTEXT_IT;

/**
 * client/src/lib/i18n-health-it.ts - one sentence per problem type of the
 * agents' system health (server/system/health.ts), in Italian. The server
 * sends the pieces (`vars`) and the client says them here. Apart from the
 * System page's catalogue because the Agents overview lists the same problems.
 */
import type { Dict } from './i18n-types';

const HEALTH_IT: Dict = {
  'health.problem.job-without-agent': 'Il lavoro a orario «{job}» non ha un agente che lo esegua, quindi non fa mai niente.',
  'health.problem.chat-unnamed': 'Una chat non ha nome ({chat}): non si capisce di cosa parla.',
  'health.problem.source-contradiction': 'Due fonti dicono cose diverse su {about}: {first} contro {second}. Scegli quale vale.',
  'health.problem.memory-unreceived.agent': 'La memoria di {agent} contiene note che nessun agente riceve.',
  'health.problem.memory-unreceived.count': '{count} memorie di progetto contengono note che nessun agente riceve.',
  'health.problem.memory-unreceived.store': 'La memoria «{store}» contiene note che nessun agente riceve.',
  'health.problem.memory-index-missing.agent': 'La memoria di {agent} ha delle note ma nessun indice, quindi l’agente non le trova.',
  'health.problem.memory-index-missing.store': 'La memoria «{store}» ha delle note ma nessun indice, quindi l’agente non le trova.',
  'health.problem.memory-index-over-limit.agent': 'L’indice della memoria di {agent} è troppo lungo: la parte oltre il limite non viene mai letta.',
  'health.problem.memory-index-over-limit.store': 'L’indice della memoria «{store}» è troppo lungo: la parte oltre il limite non viene mai letta.',
  'health.problem.tool-down': 'Il server di strumenti «{tool}» è giù, quindi gli agenti non possono usarlo.',
  'health.problem.tool-down.reason': 'Il server di strumenti «{tool}» è giù ({reason}), quindi gli agenti non possono usarlo.',
  'health.problem.persona-file-missing': 'A {agent} manca {files}, che descrive chi è.',
  'health.problem.rules-single-agent': 'Le tue regole stanno solo nell’anima di {agent}: gli altri agenti non le leggono mai. Lancia la migrazione dell’anima per spostarle nelle regole comuni.',
};

export default HEALTH_IT;

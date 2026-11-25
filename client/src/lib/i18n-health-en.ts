/**
 * client/src/lib/i18n-health-en.ts - one sentence per problem type of the
 * agents' system health (server/system/health.ts), in English. Same keys as
 * i18n-health-it.ts.
 */
import type { Dict } from './i18n-types';

const HEALTH_EN: Dict = {
  'health.problem.job-without-agent': 'The scheduled job "{job}" has no agent to run it, so it never does anything.',
  'health.problem.chat-unnamed': 'A chat has no name ({chat}), so you cannot tell what it is about.',
  'health.problem.source-contradiction': 'Two sources say different things about {about}: {first} against {second}. Choose which one counts.',
  'health.problem.memory-unreceived.agent': 'The memory of {agent} holds notes that no agent receives.',
  'health.problem.memory-unreceived.count': '{count} project memories hold notes that no agent receives.',
  'health.problem.memory-unreceived.store': 'The memory "{store}" holds notes that no agent receives.',
  'health.problem.memory-index-missing.agent': 'The memory of {agent} has notes but no index, so the agent cannot find them.',
  'health.problem.memory-index-missing.store': 'The memory "{store}" has notes but no index, so the agent cannot find them.',
  'health.problem.memory-index-over-limit.agent': 'The index of the memory of {agent} is too long: the part past the limit is never read.',
  'health.problem.memory-index-over-limit.store': 'The index of the memory "{store}" is too long: the part past the limit is never read.',
  'health.problem.tool-down': 'The tool server "{tool}" is down, so agents cannot use it.',
  'health.problem.tool-down.reason': 'The tool server "{tool}" is down ({reason}), so agents cannot use it.',
  'health.problem.persona-file-missing': '{agent} is missing {files}, which describes who it is.',
  'health.problem.rules-single-agent': 'Your rules live only in the soul of {agent}: the other agents never read them. Run the soul migration to move them to the shared rules.',
};

export default HEALTH_EN;

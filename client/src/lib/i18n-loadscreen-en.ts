/**
 * client/src/lib/i18n-loadscreen-en.ts - the strings of the load screen
 * (`/schermo`), the monitor of a machine that takes the load; in English, the
 * mirror of `i18n-loadscreen-it.ts`. Added by the screen's own chunk.
 */
import type { Dict } from './i18n-types';

const LOAD_SCREEN_EN: Dict = {
  'loadScreen.updated': 'updated at {time}',
  'loadScreen.reading': 'Reading',
  'loadScreen.state.sessions': '{n} sessions',
  'loadScreen.state.noSessions': 'no session',
  'loadScreen.state.session': '1 session',
  'loadScreen.state.workingSub': '{sessions} · {jobs}',
  'loadScreen.sent': 'Work from the Mac',
  'loadScreen.sent.job': 'Sent work',
  'loadScreen.sent.from': 'from {who}',
  'loadScreen.state.working': 'Working',
  'loadScreen.state.jobs': '{n} jobs sent',
  'loadScreen.state.job': '1 job sent',
  'loadScreen.state.noJobs': 'no jobs sent',
  'loadScreen.state.countdown': 'Sleeps in {n} min',
  'loadScreen.state.countdownSub': 'at {time}, after {threshold} min without work',
  'loadScreen.state.countdownSubBare': 'at {time}',
  'loadScreen.state.sleeping': 'Falling asleep',
  'loadScreen.state.idle': 'No work',
  'loadScreen.state.idleSub': 'sleeps after {threshold} min without work',
  'loadScreen.state.idleSubBare': 'the countdown is not available',
  'loadScreen.weight': 'Who weighs',
  'loadScreen.weight.sub': '{n} processes · {cores} cores · {mem} of memory',
  'loadScreen.weight.metric.rss': 'resident memory per program',
  'loadScreen.weight.metric.working-set': 'memory in use (working set) per program',
  'loadScreen.weight.cpuNote': 'CPU in % of one core',
  'loadScreen.weight.fromMac': 'from the Mac',
  'loadScreen.weight.processes': '{n} processes',
  'loadScreen.weight.rest': '{n} more processes · {mem}',
  'loadScreen.weight.unread': 'Processes not read: the machine does not answer',
  'loadScreen.weight.notPaired': 'Processes not read: the machine is not paired',
  'loadScreen.outcomes': 'Last outcomes',
  'loadScreen.outcome.ok': 'passed',
  'loadScreen.outcome.failed': 'failed',
  'loadScreen.outcome.unknown': 'outcome not given',
  'loadScreen.outcome.interrupted': 'interrupted',
  'loadScreen.outcome.seconds': '{n} s',
  'loadScreen.outcome.minutes': '{m} min {s} s',
  'loadScreen.hubDown': 'The hub does not answer: state and measures are from the last reading',
};

export default LOAD_SCREEN_EN;

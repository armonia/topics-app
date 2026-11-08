/**
 * client/src/lib/i18n-loadscreen-en.ts - the strings of the load screen
 * (`/schermo`), the monitor of a machine that takes the load; in English, the
 * mirror of `i18n-loadscreen-it.ts`. Added by the screen's own chunk.
 */
import type { Dict } from './i18n-types';

const LOAD_SCREEN_EN: Dict = {
  'loadScreen.title': 'Load screen',
  'loadScreen.updated': 'updated at {time}',
  'loadScreen.reading': 'Reading',
  'loadScreen.state.working': 'Working',
  'loadScreen.state.workingSub': '{cards} · {jobs}',
  'loadScreen.state.cards': '{n} cards',
  'loadScreen.state.card': '1 card',
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
  'loadScreen.why': 'Why it is awake',
  'loadScreen.running': 'Running',
  'loadScreen.running.none': 'Nothing running on this machine',
  'loadScreen.running.since': 'for {time}',
  'loadScreen.running.lessThanMinute': 'for less than a minute',
  'loadScreen.running.minutes': '{m} min',
  'loadScreen.running.hours': '{h} h {m} min',
  'loadScreen.running.from': 'from {who}',
  'loadScreen.running.more': 'and {n} more running',
  'loadScreen.running.job': 'Job sent',
  'loadScreen.weight': 'Who weighs',
  'loadScreen.weight.sub': '{n} processes · {cores} cores · {mem} of memory',
  'loadScreen.weight.metric.rss': 'resident memory per program',
  'loadScreen.weight.metric.working-set': 'memory in use (working set) per program',
  'loadScreen.weight.processes': '{n} processes',
  'loadScreen.weight.rest': '{n} more processes · {mem}',
  'loadScreen.weight.unread': 'Processes not read: the machine does not answer',
  'loadScreen.weight.notPaired': 'Processes not read: the machine is not paired',
  'loadScreen.pace': 'Quota pace',
  'loadScreen.pace.none': 'Pace not read: the hub does not answer',
  'loadScreen.pace.dial': 'Pace: {state}',
  'loadScreen.pace.end': 'runs out',
  'loadScreen.outcomes': 'Last outcomes',
  'loadScreen.outcome.ok': 'passed',
  'loadScreen.outcome.failed': 'failed',
  'loadScreen.outcome.unknown': 'outcome not given',
  'loadScreen.outcome.seconds': '{n} s',
  'loadScreen.outcome.minutes': '{m} min {s} s',
  'loadScreen.hubDown': 'The hub does not answer: state and measures are from the last reading',
};

export default LOAD_SCREEN_EN;

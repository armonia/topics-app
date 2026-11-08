/**
 * client/src/lib/i18n-consumption-en.ts - the words of the per-session
 * consumption (load screen, Processes view, card drawer); in English, the
 * mirror of `i18n-consumption-it.ts`.
 */
import type { Dict } from './i18n-types';

const CONSUMPTION_EN: Dict = {
  'consumption.title': 'Sessions',
  'consumption.live': '{n} working',
  'consumption.none': 'No session at work',
  'consumption.reading': 'Reading',
  'consumption.unread': 'Sessions not read: the server does not answer',
  'consumption.tokens': 'Tokens',
  'consumption.tokensTitle': 'input {input} · output {output} · cache read {cacheRead} · cache written {cacheWrite}',
  'consumption.tokensTotalOnly': 'Total only: this source does not break it down',
  'consumption.tokensNone': 'Tokens not read for this session',
  'consumption.tps': 'Tokens/s',
  'consumption.tpsTitle': 'Output tokens per second, averaged over the last {s} s',
  'consumption.tpsNone': 'Speed not measurable: there is no output token count, or the reading is too recent',
  'consumption.time': 'Time',
  'consumption.cpu': 'CPU',
  'consumption.memory': 'Memory',
  'consumption.memoryShared': 'of which {mb} shared',
  'consumption.memoryRemote': 'Runs on {name}: not measured here',
  'consumption.shareLine': '{what}: 1/{of} of {total}',
  'consumption.root.server': 'Topics server',
  'consumption.root.pty-bridge': 'terminal bridge',
  'consumption.root.ai-bridge': 'AI bridge',
  'consumption.root.webrtc-bridge': 'WebRTC bridge',
  'consumption.rule': 'A process several sessions use is split in equal parts between the sessions that use it',
  'consumption.procs': 'Processes',
  'consumption.procsCount': '{name} ×{n}',
  'consumption.remote': 'On the PC · {what}',
  'consumption.remoteShare': '1/{of}',
  'consumption.on': 'on {name}',
  'consumption.from': 'from {who}',
  'consumption.idle': '{n} sessions open and idle · {mem}',
  'consumption.unattributed': 'Outside any session · {mem}',
  'consumption.more': 'and {n} more working',
  'consumption.drawer': 'Session consumption',
  'consumption.drawerNone': 'No reading: the card has no session at work',
  'consumption.details': 'Detail',
};

export default CONSUMPTION_EN;

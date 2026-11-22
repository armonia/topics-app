/**
 * A job's cadence in words (e.g. "ogni giorno alle 8"), never the raw cron // allow-italian: quoted UI string
 * expression. Only the shapes people write are spelled out; anything more
 * exotic says "a orario personalizzato" rather than echoing `0 8 * * 1-5`.
 */
import type { Job } from '../../state/agentRegistry';

export interface ScheduleWords {
  key: 'agents.when.daily' | 'agents.when.weekly' | 'agents.when.everyMinutes' | 'agents.when.everyHours' | 'agents.when.at' | 'agents.when.custom';
  params: Record<string, string | number>;
}

const clock = (hour: number, minute: number) => (minute === 0 ? String(hour) : `${hour}:${String(minute).padStart(2, '0')}`);

export function scheduleWords(raw: Job['rawSchedule']): ScheduleWords {
  if (!raw) return { key: 'agents.when.custom', params: {} };
  if (raw.kind === 'every' && raw.minutes) {
    return raw.minutes % 60 === 0
      ? { key: 'agents.when.everyHours', params: { n: raw.minutes / 60 } }
      : { key: 'agents.when.everyMinutes', params: { n: raw.minutes } };
  }
  if (raw.kind === 'at' && raw.at) return { key: 'agents.when.at', params: { when: raw.at.replace('T', ' ') } };
  const m = raw.kind === 'cron' && raw.expr ? /^(\d{1,2}) (\d{1,2}) \* \* (\*|[0-6])$/.exec(raw.expr.trim()) : null;
  if (!m) return { key: 'agents.when.custom', params: {} };
  const time = clock(Number(m[2]), Number(m[1]));
  return m[3] === '*' ? { key: 'agents.when.daily', params: { time } } : { key: 'agents.when.weekly', params: { day: Number(m[3]), time } };
}

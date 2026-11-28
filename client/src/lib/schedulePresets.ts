/**
 * The few recurrences people pick by name (daily, weekly, hourly) and the cron
 * rule each one stands for. The board's recurrence menu and the Automations
 * form both read and write them here, so the two cannot disagree on what
 * «weekly» means.
 */
export type CronPreset = 'daily' | 'weekly' | 'hourly' | 'custom';

/** The cron rule of a preset at `time` («HH:MM»); `custom` has no rule of its own. */
export function presetCron(preset: Exclude<CronPreset, 'custom'>, time: string): string {
  if (preset === 'hourly') return '0 * * * *';
  const [hour, minute] = time.split(':');
  return `${Number(minute)} ${Number(hour)} * * ${preset === 'weekly' ? '1' : '*'}`;
}

/** The preset a rule is one of, with its time when it has one. */
export function cronPreset(cron: string): { preset: CronPreset; time: string | null } {
  const match = /^(\d{1,2}) (\d{1,2}) \* \* (\*|1)$/.exec(cron);
  if (match) return { preset: match[3] === '*' ? 'daily' : 'weekly', time: `${match[2]!.padStart(2, '0')}:${match[1]!.padStart(2, '0')}` };
  return { preset: cron === '0 * * * *' ? 'hourly' : 'custom', time: null };
}

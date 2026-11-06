/**
 * The two signals of the hub's status line that had no place in Topics
 * (hub-smistamento, «Campanella»): which subscription runs out before its
 * reset at today's pace, and a machine that needs a look (the Mac under
 * strain, the PC that does not answer). Pure: the live topics in, the bell's
 * rows out. The hub's own page put both in its status line; whoever did not
 * open Account e quote or Processi heard nothing until a quota hit 90%.
 */
import { macStrain } from './hubSystem';

export interface QuotaOutlook {
  provider: string;
  /** Red when it runs out within a day or has no reset in sight, amber otherwise (the hub's tone). */
  tone: 'bad' | 'warn';
  /** The hub's sentence: when it runs out, or how long it holds. */
  text: string;
  /** How it is counted and how long it stays without, in the hub's words. */
  sub: string | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);

/**
 * The subscriptions that do not reach their reset at today's pace, the worst
 * first: the hub's `level` 2 (out for more than a day before the reset) before
 * 1, and within a level the one that runs out within a day.
 */
export function quotaOutlooks(data: unknown): QuotaOutlook[] {
  const list = isRecord(data) && Array.isArray(data.providers) ? data.providers : [];
  const rows = list.flatMap((p) => {
    if (!isRecord(p)) return [];
    const level = typeof p.level === 'number' ? p.level : 0;
    const provider = str(p.id);
    const text = str(p.right);
    if (level <= 0 || !provider || !text) return [];
    const soon = p.soon === true;
    return [{ rank: level * 2 + (soon ? 1 : 0), row: { provider, tone: level >= 2 || soon ? 'bad' as const : 'warn' as const, text, sub: str(p.sub) } }];
  });
  return rows.sort((a, b) => b.rank - a.rank).map((r) => r.row);
}

export interface MachineAlert {
  machine: 'mac' | 'pc';
  /** Mac: the hub's word for its strain; PC: `closed` or `unknown`. */
  state: string;
  /** Why, in the hub's words («disco al 97%»), when it says. */
  why: string | null;
  tone: 'bad' | 'warn';
}

/**
 * The machines that need a look, as the hub's status line counted them: the
 * Mac at its red level, the PC only when it cannot be reached. A PC asleep is
 * as planned, and one at work is doing its job.
 */
export function machineAlerts(mac: unknown, pc: unknown): MachineAlert[] {
  const out: MachineAlert[] = [];
  const strain = macStrain(mac);
  if (strain) {
    const effort = isRecord(mac) && isRecord(mac.effort) ? mac.effort : null;
    out.push({ machine: 'mac', state: strain, why: effort ? str(effort.why) : null, tone: 'bad' });
  }
  const state = isRecord(pc) ? str(pc.pc) : null;
  if (state === 'chiuso') out.push({ machine: 'pc', state: 'closed', why: null, tone: 'warn' }); // allow-italian: the hub's wire value
  else if (state === 'sconosciuto') out.push({ machine: 'pc', state: 'unknown', why: null, tone: 'bad' }); // allow-italian: the hub's wire value
  return out;
}

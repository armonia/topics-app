/**
 * Human names for what the Agents pages show: a model id reads «Sonnet 5.5»,
 * a thread turn's title reads as the thread plus the channel it lives in.
 */
import { prettyModel } from '../../lib/automationRuns';

/** «claude-sonnet-5-5» or «anthropic/claude-opus-5-5» read «Sonnet 5.5» / «Opus 5.5»; a name with no version (an engine like «claude-cli») stays as it is. */
export function modelName(id: string): string {
  return /\d/.test(id) ? prettyModel(id) : id;
}

/** The bridge titles a thread's turn «#channel > thread»: the thread goes first, the channel beside it. */
export function splitTurnTitle(title: string): { title: string; channel: string | null } {
  const m = /^(.+?)\s+(?:>|›)\s+(.+)$/.exec(title);
  return m ? { title: m[2], channel: m[1] } : { title, channel: null };
}

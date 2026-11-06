/**
 * The address of «Agenti e lavori» on a filter, the hub's `#work/<filter>` made
 * Topics' `/lavori/<filter>`: which addresses are a link to the level, and the
 * filter a door asks for, taken once and only while fresh.
 * @covers HUBBR-13
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { agentsJobsLinkFilter, openAgentsJobs, takeAgentsJobsFilter } from './agentsJobsLink';

describe('agents and jobs link', () => {
  const g = globalThis as { window?: unknown };
  const had = 'window' in g;
  const before = g.window;
  const sent: string[] = [];
  beforeEach(() => {
    sent.length = 0;
    g.window = { dispatchEvent: (e: Event) => { sent.push(e.type); return true; } };
  });
  afterEach(() => {
    if (had) g.window = before;
    else delete g.window;
  });

  test('the addresses: the level alone, or on a filter; anything else is not a link to it', () => {
    expect(agentsJobsLinkFilter('/lavori')).toBeNull();
    expect(agentsJobsLinkFilter('/lavori/')).toBeNull();
    expect(agentsJobsLinkFilter('/lavori/in-attesa')).toBe('waiting');
    expect(agentsJobsLinkFilter('/lavori/in-corso')).toBe('running');
    expect(agentsJobsLinkFilter('/lavori/finiti')).toBe('finished');
    expect(agentsJobsLinkFilter('/lavori/altro')).toBeNull();
    expect(agentsJobsLinkFilter('/')).toBeUndefined();
    expect(agentsJobsLinkFilter('/tab/chat/x')).toBeUndefined();
  });

  test('a door opens System on the level, and the filter is taken once, while fresh', () => {
    openAgentsJobs('finished', 1_000);
    expect(sent).toEqual(['topics:open-user-menu']);
    expect(takeAgentsJobsFilter(2_000)).toBe('finished');
    expect(takeAgentsJobsFilter(2_000)).toBeNull();
    openAgentsJobs('waiting', 1_000);
    expect(takeAgentsJobsFilter(60_000)).toBeNull();
  });
});

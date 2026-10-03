/**
 * The cron panel shows the server's reason, not a bare status code.
 *
 * The list route answers a gateway that is down or failing with a 502 and
 * `{ jobs: [], warning }`. The panel threw `HTTP 502` away and printed «Failed
 * to load»: the reason was on the wire and never reached the screen.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { refusal } from './cronRefusal';

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('refusal', () => {
  test("the list's 502 is read from its warning", async () => {
    const res = json({ jobs: [], warning: 'Gateway unavailable: connect ECONNREFUSED 127.0.0.1:18789' }, 502);
    expect(await refusal(res, 'Failed to load')).toBe('Failed to load: Gateway unavailable: connect ECONNREFUSED 127.0.0.1:18789');
  });

  test('a command refusal is read from its error', async () => {
    expect(await refusal(json({ error: 'Gateway error: 404' }, 404), 'Run failed')).toBe('Run failed: Gateway error: 404');
  });

  test('a body that is not JSON falls back to the status code', async () => {
    expect(await refusal(new Response('<html>', { status: 502 }), 'Failed to load')).toBe('Failed to load: HTTP 502');
  });
});

describe('the panel uses it for the list too', () => {
  test('loading the jobs reads the refusal instead of throwing the status away', () => {
    const src = readFileSync(join(import.meta.dir, 'CronJobsPanel.tsx'), 'utf8');
    const load = src.slice(src.indexOf('const loadJobs'), src.indexOf('useEffect(', src.indexOf('const loadJobs')));
    expect(load).toContain("refusal(res, 'Failed to load')");
    expect(load).not.toContain('throw new Error(`HTTP ${res.status}`)');
  });
});

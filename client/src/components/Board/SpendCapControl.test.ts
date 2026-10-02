/**
 * A CAP THAT DID NOT SAVE SAYS SO.
 *
 * The write is optimistic and rolls back on failure, and the rollback was the
 * only trace: the box went quietly back to the old cap, and whoever typed a
 * spending limit could believe it was in place. Driven through the real
 * control and the real store; only the network is faked.
 *
 * @covers KANBAN-12
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as React from 'react';
import { mount, type Harness } from '../../test/reactHarness';
import { SpendCapControl } from './SpendCapControl';
import { adoptSpend } from '../../state/globalDispatchCap';

const realFetch = globalThis.fetch;
let harness: Harness | null = null;
afterEach(() => { harness?.unmount(); harness = null; globalThis.fetch = realFetch; });

const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };
const hasError = () => harness!.last().hosts.some((h) => h.props['data-testid'] === 'spend-cap-error');

function drive(status: number) {
  adoptSpend({ agentCostCapCents: 0, agentCostCapCents24h: 0, agentSpendCents24h: 120, agentSpendCentsTotal: 900 });
  globalThis.fetch = (async () => new Response(
    JSON.stringify(status === 200 ? { agentCostCapCents24h: 500 } : { error: 'boom' }),
    { status, headers: { 'content-type': 'application/json' } },
  )) as unknown as typeof fetch;
  harness = mount(React.createElement(SpendCapControl));
  const day = harness.last().hosts.find((h) => h.props['data-testid'] === 'spend-cap-day')!;
  (day.props.onBlur as (e: { target: { value: string } }) => void)({ target: { value: '5' } });
}

describe('SpendCapControl · the outcome of a cap write', () => {
  test('a rejected write shows an error next to the caps', async () => {
    drive(500);
    await settle();
    expect(hasError()).toBe(true);
  });

  test('a write that lands shows none', async () => {
    drive(200);
    await settle();
    expect(hasError()).toBe(false);
  });
});

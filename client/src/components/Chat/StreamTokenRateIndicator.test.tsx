import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { StreamTokenRateIndicator } from './StreamTokenRateIndicator';
import {
  beginStreamTokenRate,
  finishStreamTokenRate,
  forgetStreamTokenRate,
  recordStreamText,
  refreshStreamTokenRate,
} from '../../state/streamTokenRate';

const SESSION = 'indicator-test-session';

describe('StreamTokenRateIndicator', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    forgetStreamTokenRate(SESSION);
  });

  afterEach(() => {
    forgetStreamTokenRate(SESSION);
    jest.useRealTimers();
  });

  test('visually distinguishes the live estimate from final provider usage', () => {
    beginStreamTokenRate(SESSION);
    recordStreamText(SESSION, 'x'.repeat(40), 1_000);
    refreshStreamTokenRate(SESSION, 2_000);

    const live = renderToStaticMarkup(<StreamTokenRateIndicator sessionKey={SESSION} />);
    expect(live).toContain('data-rate-source="text-estimate"');
    expect(live).toContain('≈ ');
    expect(live).not.toContain('· usage');

    finishStreamTokenRate(SESSION, 200, 3_000);
    const final = renderToStaticMarkup(<StreamTokenRateIndicator sessionKey={SESSION} />);
    expect(final).toContain('data-rate-source="usage"');
    expect(final).toContain('· usage');
    expect(final).not.toContain('≈ ');
  });
});

/**
 * Il contratto di `formatTokens`, e soprattutto la PARITÀ con le cinque copie
 * che ha sostituito: ogni superficie deve continuare a stampare esattamente
 * quello che stampava, o la sostituzione non è una rifattorizzazione, è un
 * cambio di UI mascherato (e quattro asserzioni E2E se ne accorgerebbero).
 *
 * L'unica differenza VOLUTA è il confine con i milioni, che era sbagliato in
 * tre copie su cinque.
 *
 * @covers CTX-01
 */
import { describe, expect, test } from 'bun:test';
import { formatTokens } from './formatTokens';

// Le opzioni di ciascuna superficie, come nei rispettivi call site.
const RING = {} as const;                                   // useRealContext / context ring
const COMPACT = { decimals: 0 } as const;                   // toolGrouping (≥10k)
const CARD = { decimals: 1 } as const;                      // AgentSpawnCard
const HISTORY = { suffix: 'K' } as const;                   // SessionHistory
const LEADERBOARD = { decimals: 1, suffix: 'K' } as const;  // AgentLeaderboard

describe('formatTokens — parità con le copie sostituite', () => {
  test('ring (arrotondato, k minuscolo)', () => {
    expect(formatTokens(0, RING)).toBe('0');
    expect(formatTokens(999, RING)).toBe('999');
    expect(formatTokens(1_000, RING)).toBe('1k');
    expect(formatTokens(1_499, RING)).toBe('1k');
    expect(formatTokens(1_500, RING)).toBe('2k');
    expect(formatTokens(148_231, RING)).toBe('148k');
    expect(formatTokens(186_000, RING)).toBe('186k');
    expect(formatTokens(200_000, RING)).toBe('200k');
  });

  test('card e leaderboard (un decimale)', () => {
    expect(formatTokens(1_500, CARD)).toBe('1.5k');
    expect(formatTokens(32_000, LEADERBOARD)).toBe('32.0K');
    expect(formatTokens(999, CARD)).toBe('999');
  });

  test('history (arrotondato, K maiuscolo)', () => {
    expect(formatTokens(32_000, HISTORY)).toBe('32K');
    expect(formatTokens(3_200, HISTORY)).toBe('3K');
    expect(formatTokens(500, HISTORY)).toBe('500');
  });
});

describe('formatTokens — il confine con i milioni, che era il bug', () => {
  test('arrotondando a intero non esiste «1000k»: a 999.500 si passa ai milioni', () => {
    // SessionHistory stampava `1000K` qui: il ramo dei milioni scattava a
    // 1.000.000 esatti, ma Math.round(999600/1000) fa gia' 1000.
    expect(formatTokens(999_499, RING)).toBe('999k');
    expect(formatTokens(999_500, RING)).toBe('1.0M');
    expect(formatTokens(999_600, HISTORY)).toBe('1.0M');
    expect(formatTokens(999_600, COMPACT)).toBe('1.0M');
  });

  test('con un decimale il confine si sposta a 999.950, non prima', () => {
    // Qui `999.6k` è corretto e NON va promosso: il valore stampato non
    // raggiunge 1000.
    expect(formatTokens(999_600, CARD)).toBe('999.6k');
    expect(formatTokens(999_949, LEADERBOARD)).toBe('999.9K');
    expect(formatTokens(999_950, LEADERBOARD)).toBe('1.0M');
  });

  test('sopra i ~10M si smette di stampare il decimale', () => {
    expect(formatTokens(9_949_999, RING)).toBe('9.9M');
    expect(formatTokens(9_950_000, RING)).toBe('10M');
    expect(formatTokens(1_000_000, RING)).toBe('1.0M');
  });

  test('un valore non finito non esplode', () => {
    expect(formatTokens(NaN, RING)).toBe('NaN');
    expect(formatTokens(Infinity, RING)).toBe('Infinity');
  });
});

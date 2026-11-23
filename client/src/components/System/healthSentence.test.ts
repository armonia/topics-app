/** @covers SYSTEM-PAGE-01 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { ensureLocaleLoaded, t, type Locale } from '../../lib/i18n';
import type { HealthProblem } from '../../../../shared/agents-health';
import { healthSentence } from './healthSentence';

const tr = (locale: Locale) => (key: string, vars?: Record<string, string | number>) => t(key, locale, vars);
const problem = (type: string, vars?: Record<string, string>): HealthProblem => ({
  id: `${type}:x`, type, severity: 'warning', sentence: `server sentence for ${type}`, destination: { section: 'jobs' }, ...(vars ? { vars } : {}),
});

describe('healthSentence', () => {
  // English arrives as its own chunk: until then every key falls back to Italian.
  beforeAll(() => ensureLocaleLoaded('en'));

  test('a problem reads in Italian from its pieces, not in the server English', () => {
    expect(healthSentence(tr('it'), problem('job-without-agent', { job: 'Brief' }))).toBe('Il lavoro a orario «Brief» non ha un agente che lo esegua, quindi non fa mai niente.');
    expect(healthSentence(tr('en'), problem('job-without-agent', { job: 'Brief' }))).toBe('The scheduled job "Brief" has no agent to run it, so it never does anything.');
  });

  test('the pieces pick the variant: whose memory it is, and why a tool is down', () => {
    expect(healthSentence(tr('it'), problem('memory-unreceived', { agent: 'Jarvis' }))).toBe('La memoria di Jarvis contiene note che nessun agente riceve.');
    expect(healthSentence(tr('it'), problem('memory-unreceived', { store: 'shared' }))).toBe('La memoria «shared» contiene note che nessun agente riceve.');
    expect(healthSentence(tr('it'), problem('tool-down', { tool: 'docs', reason: 'exit 1' }))).toBe('Il server di strumenti «docs» è giù (exit 1), quindi gli agenti non possono usarlo.');
    expect(healthSentence(tr('it'), problem('tool-down', { tool: 'docs' }))).toBe('Il server di strumenti «docs» è giù, quindi gli agenti non possono usarlo.');
    // A type with no «.agent» variant falls back to its base sentence.
    expect(healthSentence(tr('it'), problem('rules-single-agent', { agent: 'Jarvis' }))).toStartWith('Le tue regole stanno solo nell’anima di Jarvis');
  });

  test('a type this client does not know, or a problem without pieces, keeps the server sentence', () => {
    expect(healthSentence(tr('it'), problem('something-new', { name: 'x' }))).toBe('server sentence for something-new');
    expect(healthSentence(tr('it'), problem('job-without-agent'))).toBe('server sentence for job-without-agent');
  });
});

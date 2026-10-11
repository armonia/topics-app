/**
 * THE PROVIDERS LEVEL AS DATA: one card per provider, in a fixed order that
 * does not move with the models, the companies each serves, one action per
 * state, and the count the selector's foot shares with the heading.
 *
 * Model selector revision 2026-10-04, §5.2-§5.4, AC-06, AC-07, AC-22, AC-23.
 *
 * @covers SETHOME-01
 * @covers AICTRL-01
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { t } from '../../lib/i18n';
import { AUDIT_KEYS, AUDIT_NO_KEYS, entry, snapshotOf } from '../Shared/ModelSelector/fixtures';
import {
  PROVIDER_ORDER, cardAction, cardFact, cardsCount, endpointHost, providerCards, providerKind, servedMakers,
} from './providersModel';
import { providersCountTail } from '../Sidebar/formLevelTails';

const it = (key: string, vars?: Record<string, string | number>) => t(key, 'it', vars);
const JCODE_IDS = readFileSync(join(import.meta.dir, '../../../../tests/e2e/fixtures/jcode-models.txt'), 'utf8')
  .split('\n').map((id) => id.trim()).filter(Boolean);

describe('the list: every provider once, in a fixed order (AC-06)', () => {
  test('the audit fleet: the table first, then the endpoints by label, topics as «Topics»', () => {
    const cards = providerCards(AUDIT_KEYS);
    expect(cards.map((card) => card.name)).toEqual([
      'claude-code', 'topics', 'claude', 'codex', 'openai', 'gemini', 'jcode', 'goose', 'direct-ollama', 'direct-openrouter',
    ]);
    expect(cards.find((card) => card.name === 'topics')?.label).toBe('Topics');
    expect(new Set(cards.map((card) => card.name)).size).toBe(AUDIT_KEYS.providers.length);
  });

  test('the order is the table, not the models: 134 jcode ids leave jcode where it was', () => {
    const before = providerCards(AUDIT_KEYS).findIndex((card) => card.name === 'jcode');
    const real = snapshotOf(AUDIT_KEYS.providers.map((p) => (p.name === 'jcode' ? { ...p, models: JCODE_IDS } : p)));
    expect(providerCards(real).findIndex((card) => card.name === 'jcode')).toBe(before);
  });

  test('an error does not move a card up', () => {
    const broken = snapshotOf(AUDIT_KEYS.providers.map((p) => (p.name === 'openai' ? { ...p, status: 'error' as const, lastError: 'boom' } : p)));
    expect(providerCards(broken).map((card) => card.name)).toEqual(providerCards(AUDIT_KEYS).map((card) => card.name));
  });

  test('the table of names is the revision\'s', () => {
    expect([...PROVIDER_ORDER]).toEqual(['claude-code', 'topics', 'claude', 'codex', 'muse', 'openai', 'gemini', 'jcode', 'openclaw', 'goose']);
  });

  test('a program installed but not registered is a card to connect, after the known names', () => {
    const cards = providerCards(snapshotOf([entry('claude-code', 'Claude Code', ['claude-opus-5-5'])]), [{ name: 'opencode', label: 'OpenCode' }, { name: 'claude-code', label: 'Claude Code' }]);
    expect(cards.map((card) => [card.name, card.status, card.action, card.registered])).toEqual([
      ['claude-code', 'ready', null, true],
      ['topics', 'unavailable', null, false],
      ['opencode', 'unavailable', 'setUp', false],
    ]);
  });

  test('Topics keeps its card when the engine is not registered: it holds the settings for every chat', () => {
    const cards = providerCards(snapshotOf([entry('codex', 'Codex', ['gpt-6-sol'])]));
    expect(cards.map((card) => card.name)).toEqual(['topics', 'codex']);
    expect(cardsCount(cards)).toEqual({ ready: 1, errors: 0 });
    expect(providerCards(snapshotOf([])).map((card) => card.name)).toEqual(['topics']);
    expect(providerCards(null)).toEqual([]);
  });
});

describe('the companies a card serves (§5.2, AC-07)', () => {
  test('Anthropic, OpenAI, Google first, then by number of models, then by name', () => {
    const localEndpoint = AUDIT_KEYS.providers.find((p) => p.name === 'direct-ollama')!;
    expect(servedMakers(localEndpoint)).toEqual(['OpenAI', 'Google', 'DeepSeek', 'Meta', 'Qwen']);
    const gateway = AUDIT_KEYS.providers.find((p) => p.name === 'direct-openrouter')!;
    expect(servedMakers(gateway)).toEqual(['Anthropic', 'OpenAI', 'Google', 'Meta', 'Mistral', 'xAI']);
  });

  test('a provider with no model takes the company of the static table', () => {
    expect(servedMakers(AUDIT_NO_KEYS.providers.find((p) => p.name === 'codex')!)).toEqual(['OpenAI']);
    expect(servedMakers({ name: 'muse', label: 'Muse', models: [] })).toEqual(['Meta']);
    expect(servedMakers({ name: 'goose', label: 'goose', models: [] })).toEqual([]);
  });

  test('the real jcode lists its companies, Anthropic, OpenAI, Google first', () => {
    const makers = servedMakers({ name: 'jcode', label: 'jcode', models: JCODE_IDS });
    expect(makers.slice(0, 3)).toEqual(['Anthropic', 'OpenAI', 'Google']);
    expect(makers.length).toBeGreaterThanOrEqual(17);
  });
});

describe('one action per state (§5.4)', () => {
  test('ready and checking carry none; an error retries; to connect: sign in, add a key, set up', () => {
    expect(cardAction('codex', 'ready')).toBeNull();
    expect(cardAction('codex', 'loading')).toBeNull();
    expect(cardAction('goose', 'error')).toBe('retry');
    expect(cardAction('codex', 'unavailable')).toBe('signIn');
    expect(cardAction('claude-code', 'unavailable')).toBe('signIn');
    expect(cardAction('muse', 'unavailable')).toBe('signIn');
    expect(cardAction('openai', 'unavailable')).toBe('addKey');
    expect(cardAction('gemini', 'unavailable')).toBe('setUp');
  });

  test('Topics is the engine of the band, never a default (AICTRL-01, AC-23)', () => {
    const topics = providerCards(snapshotOf([{ ...entry('topics', 'Topics', ['claude-opus-5-5']), isDefault: true }])).at(0)!;
    expect(topics.kind).toBe('engine');
    expect(topics.isDefault).toBe(false);
    expect(topics.action).toBeNull();
    expect(cardFact(topics, it)).not.toContain('Predefinito');
  });
});

describe('the fact line (§5.2)', () => {
  const cards = providerCards(AUDIT_KEYS, [], { 'direct-openrouter': 'openrouter.ai' });
  const card = (name: string) => cards.find((c) => c.name === name)!;

  test('one fact per kind of account, with the models', () => {
    expect(cardFact(card('claude-code'), it, { plan: 'Max 20x', planWarning: 'sett. 67%' })).toBe('Predefinito · Max 20x · sett. 67% · 11 modelli');
    expect(cardFact(card('codex'), it)).toBe('Piano ChatGPT · 8 modelli');
    expect(cardFact(card('openai'), it)).toBe('Chiave a consumo · 8 modelli');
    expect(cardFact(card('gemini'), it)).toBe('Programma · 3 modelli');
    expect(cardFact(card('jcode'), it)).toBe('Agente · 3 modelli');
    expect(cardFact(card('direct-openrouter'), it)).toBe('Endpoint · openrouter.ai · 6 modelli');
    const muse = providerCards(snapshotOf([entry('muse', 'Muse', ['muse-spark-1.3-contributor', 'muse-spark-1.2'])]))
      .find((c) => c.name === 'muse')!;
    expect(cardFact(muse, it)).toBe('Abbonamento Muse · 2 modelli');
  });

  test('in error, the reason', () => {
    expect(cardFact(card('goose'), it)).toBe('goose acp: exited with code 1');
  });

  test('the kinds', () => {
    expect(['claude-code', 'codex', 'muse', 'claude', 'openai', 'gemini', 'jcode', 'direct-x', 'topics', 'goose'].map(providerKind))
      .toEqual(['subscription', 'subscription', 'subscription', 'key', 'key', 'program', 'agent', 'endpoint', 'engine', 'agent']);
  });

  test('the host of an endpoint', () => {
    expect(endpointHost('https://openrouter.ai/api/v1')).toBe('openrouter.ai');
    expect(endpointHost('not a url')).toBeNull();
  });
});

describe('the count is the cards (AC-22)', () => {
  test('9 ready and 1 error on the audit fleet, in the foot and the heading alike', () => {
    expect(cardsCount(providerCards(AUDIT_KEYS))).toEqual({ ready: 9, errors: 1 });
    expect(providersCountTail(AUDIT_KEYS, it)?.text).toBe('9 pronti · 1 errore');
  });
});

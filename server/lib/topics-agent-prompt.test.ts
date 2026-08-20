/**
 * resolveCodexReasoningEffort() — mirror of the resolveClaudeEffort() contract:
 * explicit override → mirror env → user config.toml → default; unrecognised
 * values resolve to null (no override passed, no badge shown).
 */
import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveCodexReasoningEffort,
  resolveClaudeEffort,
  topicEffortFor,
  languageDirective,
  topicsAgentSystemPrompt,
  resolveMcpOutputTokens,
  DEFAULT_MCP_OUTPUT_TOKENS,
} from './topics-agent-prompt';
import { __resetDeprecatedEnvWarnings } from './env-alias';

const ENV_KEYS = ['TOPICS_CODEX_REASONING_EFFORT', 'CODEX_REASONING_EFFORT'] as const;
const CLAUDE_ENV_KEYS = ['TOPICS_CLAUDE_EFFORT', 'CLAUDE_EFFORT', 'TOPICS_MCP_OUTPUT_TOKENS'] as const;
const savedEnv: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
for (const k of CLAUDE_ENV_KEYS) savedEnv[k] = process.env[k];

const fixtureDir = mkdtempSync(join(tmpdir(), 'codex-effort-test-'));
/** Path that never exists — forces the "no config" branch. */
const missingConfig = join(fixtureDir, 'nope', 'config.toml');

function writeConfig(contents: string): string {
  const p = join(fixtureDir, `config-${Math.random().toString(36).slice(2)}.toml`);
  writeFileSync(p, contents);
  return p;
}

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  for (const k of CLAUDE_ENV_KEYS) delete process.env[k];
});

afterAll(() => {
  for (const k of [...ENV_KEYS, ...CLAUDE_ENV_KEYS]) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  rmSync(fixtureDir, { recursive: true, force: true });
});

describe('resolveCodexReasoningEffort', () => {
  test('explicit Topics override wins over everything', () => {
    process.env.TOPICS_CODEX_REASONING_EFFORT = 'medium';
    process.env.CODEX_REASONING_EFFORT = 'low';
    const config = writeConfig('model_reasoning_effort = "ultra"\n');
    expect(resolveCodexReasoningEffort({ configPath: config })).toBe('medium');
  });

  test('"off"/"default" disable the override entirely', () => {
    for (const v of ['off', 'default', ' OFF ']) {
      process.env.TOPICS_CODEX_REASONING_EFFORT = v;
      expect(resolveCodexReasoningEffort({ configPath: missingConfig })).toBeNull();
    }
  });

  test('"none" is a real codex tier, NOT a disable keyword', () => {
    process.env.TOPICS_CODEX_REASONING_EFFORT = 'none';
    expect(resolveCodexReasoningEffort({ configPath: missingConfig })).toBe('none');
  });

  test('mirror env is used when no Topics override', () => {
    process.env.CODEX_REASONING_EFFORT = 'HIGH';
    expect(resolveCodexReasoningEffort({ configPath: missingConfig })).toBe('high');
  });

  test('user config.toml value wins over the default (never downgrade)', () => {
    const config = writeConfig('model = "gpt-5.6-sol"\nmodel_reasoning_effort = "ultra"\n');
    expect(resolveCodexReasoningEffort({ configPath: config })).toBe('ultra');
  });

  test('config keys inside a table are ignored (root-level only)', () => {
    const config = writeConfig('[profiles.deep]\nmodel_reasoning_effort = "minimal"\n');
    expect(resolveCodexReasoningEffort({ configPath: config })).toBe('xhigh');
  });

  test('defaults to xhigh with no env and no config', () => {
    expect(resolveCodexReasoningEffort({ configPath: missingConfig })).toBe('xhigh');
  });

  test('unrecognised tier resolves to null (no override passed)', () => {
    process.env.TOPICS_CODEX_REASONING_EFFORT = 'galactic';
    expect(resolveCodexReasoningEffort({ configPath: missingConfig })).toBeNull();
    delete process.env.TOPICS_CODEX_REASONING_EFFORT;
    const config = writeConfig('model_reasoning_effort = "galactic"\n');
    expect(resolveCodexReasoningEffort({ configPath: config })).toBeNull();
  });
});

describe('resolveClaudeEffort — per-topic override (migration 033)', () => {
  test('valid per-topic override wins over env default', () => {
    process.env.CLAUDE_EFFORT = 'low';
    expect(resolveClaudeEffort('max')).toBe('max');
  });

  test('per-topic override wins even over the Topics env override', () => {
    process.env.TOPICS_CLAUDE_EFFORT = 'medium';
    expect(resolveClaudeEffort('high')).toBe('high');
  });

  test('override is case/space-insensitive', () => {
    expect(resolveClaudeEffort(' XHIGH ')).toBe('xhigh');
  });

  test('null / empty / unknown override falls through to env default', () => {
    expect(resolveClaudeEffort(null)).toBe('xhigh'); // no env → Warp default
    expect(resolveClaudeEffort('')).toBe('xhigh');
    expect(resolveClaudeEffort('galactic')).toBe('xhigh');
  });

  test('no override + no env still yields the xhigh default', () => {
    expect(resolveClaudeEffort()).toBe('xhigh');
  });

  test('env "off" disables when there is no valid per-topic override', () => {
    process.env.TOPICS_CLAUDE_EFFORT = 'off';
    expect(resolveClaudeEffort(null)).toBeNull();
    // …but a valid per-topic override still wins over the "off" policy.
    expect(resolveClaudeEffort('high')).toBe('high');
  });
});

describe('deprecated effort aliases (dedupe warning)', () => {
  test('CLAUDE_EFFORT still honoured but warns once; TOPICS_CLAUDE_EFFORT wins silently', () => {
    __resetDeprecatedEnvWarnings();
    const calls: string[] = [];
    const orig = console.warn;
    console.warn = (...a: any[]) => { calls.push(String(a[0])); };
    try {
      process.env.CLAUDE_EFFORT = 'medium';
      expect(resolveClaudeEffort(null)).toBe('medium'); // legacy fallback still works
      expect(resolveClaudeEffort(null)).toBe('medium'); // second read: no new warning
      expect(calls.filter((c) => c.includes('CLAUDE_EFFORT')).length).toBe(1);

      __resetDeprecatedEnvWarnings();
      calls.length = 0;
      process.env.TOPICS_CLAUDE_EFFORT = 'high';
      expect(resolveClaudeEffort(null)).toBe('high'); // canonical wins
      expect(calls.length).toBe(0); // canonical never warns
    } finally {
      console.warn = orig;
    }
  });
});

describe('topicEffortFor — il selettore per-topic sul percorso PTY', () => {
  // Il bug che questa funzione chiude: `resolveClaudeEffort()` veniva chiamata
  // NUDA nello spawn del terminale, quindi il primo ramo della catena (l'override
  // per-topic, migration 033) non veniva mai valutato. Un topic a "medium" apriva
  // un PTY a xhigh, mentre la stessa topic in chat rispettava la scelta.
  const dbWith = (rows: Record<string, { effort?: string | null }>) => ({
    prepare: (_sql: string) => ({
      get: (...args: unknown[]) => rows[String(args[0])],
    }),
  });

  test("legge l'effort del topic e lo fa vincere sul default", () => {
    const db = dbWith({ 't1': { effort: 'medium' } });
    expect(topicEffortFor(db, 't1')).toBe('medium');
    expect(resolveClaudeEffort(topicEffortFor(db, 't1'))).toBe('medium');
  });

  test('un topic senza effort cade sul default globale', () => {
    const db = dbWith({ 't1': { effort: null } });
    expect(topicEffortFor(db, 't1')).toBeNull();
    expect(resolveClaudeEffort(topicEffortFor(db, 't1'))).toBe('xhigh');
  });

  test('topicId assente: nessuna query, nessun errore', () => {
    const boom = { prepare: () => { throw new Error('non deve essere chiamata'); } };
    expect(topicEffortFor(boom, undefined)).toBeNull();
    expect(topicEffortFor(boom, null)).toBeNull();
    expect(topicEffortFor(boom, '')).toBeNull();
  });

  test('un topic inesistente o una query che fallisce non bloccano lo spawn', () => {
    expect(topicEffortFor(dbWith({}), 'mai-visto')).toBeNull();
    const broken = { prepare: () => { throw new Error('no such column: effort'); } };
    expect(topicEffortFor(broken, 't1')).toBeNull();
    expect(resolveClaudeEffort(topicEffortFor(broken, 't1'))).toBe('xhigh');
  });
});

/**
 * La direttiva di lingua — l'unico posto in cui la scelta dell'utente diventa
 * testo per il modello.
 *
 * Le tre bocche che parlano (`providers/claude-code.ts`, `routes/terminal.ts`,
 * `services/task-dispatcher.ts` e il blocco sintetico di `context/assemble.ts`)
 * chiedono tutte QUESTA funzione: se una se la riscrivesse, tornerebbe il
 * difetto di partenza — chat in inglese perché così era scritta la costante,
 * board in italiano perché così era scritto il kickoff, e il selettore che non
 * sposta né l'uno né l'altro.
 *
 * Il caso che conta è `auto`: deve tornare STRINGA VUOTA. Una direttiva
 * inventata quando l'utente non ha scelto niente è peggio di nessuna direttiva
 * — e i chiamanti si appoggiano al vuoto per non concatenare una riga bianca.
 */
describe('resolveMcpOutputTokens — il tetto ai risultati dei tool MCP', () => {
  test('di default il tetto c\'è: 25.000 token della CLI sono ~100 kB a chiamata, e non scattano mai', () => {
    expect(resolveMcpOutputTokens()).toBe(DEFAULT_MCP_OUTPUT_TOKENS);
  });

  test('`off` lo spegne — è la via con cui il gate si vede FALLIRE', () => {
    for (const v of ['off', 'none', 'default', 'OFF']) {
      process.env.TOPICS_MCP_OUTPUT_TOKENS = v;
      expect(resolveMcpOutputTokens()).toBeNull();
    }
  });

  test('un intero lo sposta', () => {
    process.env.TOPICS_MCP_OUTPUT_TOKENS = '1500';
    expect(resolveMcpOutputTokens()).toBe(1500);
  });

  test('un valore illeggibile NON lo spegne in silenzio: chi scrive un numero vuole un tetto', () => {
    for (const v of ['molti', '0', '-3', '']) {
      process.env.TOPICS_MCP_OUTPUT_TOKENS = v;
      expect(resolveMcpOutputTokens()).toBe(DEFAULT_MCP_OUTPUT_TOKENS);
    }
  });
});

describe('languageDirective', () => {
  test("'auto' non è una lingua: nessuna direttiva", () => {
    expect(languageDirective('auto')).toBe('');
  });

  test('italiano e inglese danno una riga sola, e nomina la lingua', () => {
    expect(languageDirective('it')).toContain('italiano');
    expect(languageDirective('en')).toContain('English');
    for (const lang of ['it', 'en'] as const) {
      expect(languageDirective(lang).split('\n')).toHaveLength(1);
    }
  });
});

describe('topicsAgentSystemPrompt', () => {
  test('la parte sui processi c\'è sempre — la lingua è additiva, non sostitutiva', () => {
    for (const lang of ['auto', 'it', 'en'] as const) {
      expect(topicsAgentSystemPrompt(lang)).toContain('mcp__topics__run_script');
    }
  });

  test("con 'auto' il prompt è ESATTAMENTE quello di prima: nessuna coda", () => {
    const auto = topicsAgentSystemPrompt('auto');
    expect(auto.endsWith('or the command is a short one-off.')).toBe(true);
  });

  test('con una lingua scelta la direttiva chiude il prompt', () => {
    expect(topicsAgentSystemPrompt('it').endsWith(languageDirective('it'))).toBe(true);
    expect(topicsAgentSystemPrompt('en').endsWith(languageDirective('en'))).toBe(true);
  });

  /**
   * COME SI ASPETTA, detto all'agente.
   *
   * Le due attese sono diverse per CHI GUARDA: `wait_for_process` tiene il
   * turno (clessidra, e non puoi parlargli finché non torna), `Monitor` lo
   * chiude e si fa risvegliare. Su un build da venti minuti la prima è una
   * chat bloccata per venti minuti.
   *
   * Il consiglio si può dare solo da quando la risposta del Monitor arriva
   * davvero in chat (`providers/claude/woken-turn.ts`): prima si sarebbe
   * mandato l'agente a parlare nel vuoto.
   */
  test('dice COME aspettare: Monitor per le attese lunghe, wait_for_process per le corte', () => {
    const p = topicsAgentSystemPrompt('auto');
    expect(p).toContain('Monitor');
    expect(p).toContain('mcp__topics__wait_for_process');
    // E il divieto che rende il consiglio azionabile invece che teorico.
    expect(p).toContain('Never sleep-and-poll');
  });

  test("il Monitor è offerto SE C'È, non promesso", () => {
    // È dietro un flag lato CLI (`tengu_amber_sentinel`): su una macchina dove
    // è spento quel tool NON esiste, e un prompt che lo desse per scontato
    // manderebbe l'agente a cercare uno strumento assente. La via d'uscita
    // dev'essere nominata nella stessa frase.
    const p = topicsAgentSystemPrompt('auto');
    expect(p).toContain('available to you');
    const dopo = p.slice(p.indexOf('available to you'));
    expect(dopo).toContain('mcp__topics__wait_for_process');
  });
});

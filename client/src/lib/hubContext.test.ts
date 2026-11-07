/**
 * The agents' context as pure reads of the hub's `/api/contesto`: the weight
 * per harness with the home sessions' memory as Claude Code's extra and not as
 * a fifth harness, the file labels in place of ids and paths, the old rules
 * oldest first, and the check's answers. Inputs are the hub's own shapes,
 * trimmed, with placeholder files.
 * @covers HUBBR-17
 */
import { describe, expect, test } from 'bun:test';
import { CHECK_STALE_MS, checkStart, contextCheck, contextView, doctorVerdict, fileAgeDays, fileGroups, harnessWeights, plainRule, shortTokens, unlistedRef } from './hubContext';

const HUB = {
  at: 1_793_901_551_906,
  files: [
    { id: 'claude-md', label: 'CLAUDE.md globale', path: '~/.claude/CLAUDE.md', group: 'Claude Code', loaders: ['Claude Code', 'Muse (via claude-cli)'], tokens: 4443, note: '', mtime: 1_793_000_000_000 },
    { id: 'inc:tools.md', label: 'TOOLS.md', path: '~/.claude/tools.md', group: 'Claude Code', loaders: ['Claude Code', 'Muse (via claude-cli)'], tokens: 6282, note: 'incluso da CLAUDE.md' },
    { id: 'memory-index', label: 'Indice della memoria', path: '~/.claude/memory/MEMORY.md', group: 'Claude Code', loaders: ['Claude Code (sessioni nate in ~)'], tokens: 4907, note: '' },
    { id: 'broken', label: '', path: '~/x.md' },
  ],
  subagentPrompts: [{ id: 'subagent:oracle.md', label: 'Prompt del sottoagente oracle', path: '~/.claude/agents/oracle.md', group: 'Prompt dei sottoagenti', loaders: [], tokens: 439, note: '' }],
  otherSources: [{ id: 'project:acme-web', label: 'CLAUDE.md · acme-web', path: '~/Projects/acme-web/CLAUDE.md', group: 'CLAUDE.md dei progetti', loaders: [], tokens: 302, note: 'letto nelle sessioni di quel progetto' }],
  skills: { count: 41, tokens: 1780, loaders: ['Claude Code'], items: [{ name: 'light', tokens: 12 }, { name: 'heavy', tokens: 90 }, { tokens: 5 }] },
  duplicates: [{ text: 'Mai inviare email senza conferma', files: ['claude-md', 'project:acme-web'] }, { text: 'solo in un file', files: ['claude-md'] }],
  oldRules: [
    { file: 'memory-index', line: 77, text: '- [una scheda di maggio](reference_exec_stall.md): causa non provata', date: '2026-05-01', days: 188 },
    { file: 'project:studio-x', line: 212, text: '**Last Updated**: 2025-10-29', date: '2025-10-29', days: 372 },
  ],
  doctor: { ok: false, checks: [{ ok: true, text: 'nessun link rotto' }, { ok: false, text: 'skill fuori posto: demo' }], error: null },
  totals: { byLoader: { 'Claude Code': 14888, 'Muse (via claude-cli)': 11162, Codex: 14890, jcode: 14890, 'Claude Code (sessioni nate in ~)': 4907 } },
  contradictions: {
    at: 1_792_976_303_647,
    items: [
      { a: { file: '~/.claude/CLAUDE.md', text: 'niente closers' }, b: { file: '~/.claude/output-styles/kind.md', text: 'chiudi con un prossimo passo' }, why: 'una vieta i closers, l\'altra li chiede' },
      { a: { file: '~/x' }, b: { file: '~/y', text: 'y' }, why: 'senza testo da un lato' },
      { a: { file: '~/.jcode/AGENTS.md', text: 'a' }, b: { file: '~/.jcode/workspace-gtm/AGENTS.md', text: '`b`' }, why: 'due AGENTS.md diversi' },
    ],
    running: false,
  },
};

describe('harnessWeights', () => {
  test('a loader that qualifies another is its extra, one that qualifies nothing is a harness of its own', () => {
    const w = harnessWeights(HUB.totals.byLoader);
    expect(w.map((h) => h.name)).toEqual(['Codex', 'jcode', 'Claude Code', 'Muse']);
    const cc = w.find((h) => h.name === 'Claude Code')!;
    expect(cc.tokens).toBe(14888);
    expect(cc.extra).toEqual({ tokens: 4907, home: true });
    expect(w.find((h) => h.name === 'Muse')!.extra).toBeNull();
  });

  test('garbage in, nothing out', () => {
    expect(harnessWeights(null)).toEqual([]);
    expect(harnessWeights({ a: 'x', b: 0 })).toEqual([]);
  });
});

describe('contextView', () => {
  const v = contextView(HUB)!;

  test('Claude Code weighs about fifteen thousand tokens: the tail of the row', () => {
    expect(v.claudeCode).toBe(14888);
    expect(shortTokens(v.claudeCode!, 'it')).toBe('15 k');
    expect(shortTokens(4907, 'it')).toBe('4,9 k');
    expect(shortTokens(950, 'en')).toBe('950');
  });

  test('files read at start apart from those read on demand; a file without a label is dropped', () => {
    expect(v.files.map((f) => f.label)).toEqual(['CLAUDE.md globale', 'TOOLS.md', 'Indice della memoria']);
    expect(v.files[0]!.readers).toEqual(['Claude Code', 'Muse']);
    expect(v.files[1]!.note).toBe('incluso da CLAUDE.md');
    expect(v.onDemand.map((f) => f.id)).toEqual(['subagent:oracle.md', 'project:acme-web']);
    expect(v.skills).toEqual({ count: 41, tokens: 1780, items: [{ name: 'heavy', tokens: 90 }, { name: 'light', tokens: 12 }] });
  });

  test('a file keeps who loads it with the hub qualifier, and when it last changed', () => {
    expect(v.files[0]!.loaders).toEqual(['Claude Code', 'Muse (via claude-cli)']);
    expect(v.files[2]!.loaders).toEqual(['Claude Code (sessioni nate in ~)']);
    expect(v.files[0]!.mtime).toBe(1_793_000_000_000);
    expect(v.files[1]!.mtime).toBeNull();
    expect(fileAgeDays(null, 5)).toBeNull();
    expect(fileAgeDays(0, 86_400_000 * 61.5)).toBe(61);
    expect(fileAgeDays(10, 0)).toBe(0);
  });

  test('files grouped by who loads them, in the hub order, each with its tokens', () => {
    const f = (id: string, group: string, tokens: number) => ({ ...v.files[0]!, id, group, tokens });
    const groups = fileGroups([f('a', 'Codex e jcode', 5), f('b', 'Altro', 1), f('c', 'Claude Code', 3), f('d', 'Claude Code', 4)]);
    expect(groups.map((g) => [g.name, g.files.length, g.tokens])).toEqual([['Claude Code', 2, 7], ['Codex e jcode', 1, 5], ['Altro', 1, 1]]);
  });

  test('duplicates, old rules and contradictions name files by their label, never by id or path', () => {
    expect(v.duplicates).toEqual([{ text: 'Mai inviare email senza conferma', where: ['CLAUDE.md globale', 'CLAUDE.md · acme-web'] }]);
    expect(v.oldRules.map((r) => [r.where, r.line, r.days])).toEqual([['rules · studio-x', 212, 372], ['Indice della memoria', 77, 188]]);
    expect(v.check.items).toHaveLength(2);
    expect(v.check.items[0]!.a.where).toBe('CLAUDE.md globale');
    expect(v.check.items[0]!.b.where).toBe('kind · Claude Code');
    expect(v.check.at).toBe(1_792_976_303_647);
  });

  test('two unlisted files of the same name stay apart, by whose they are', () => {
    const [a, b] = [v.check.items[1]!.a.where, v.check.items[1]!.b.where];
    expect(a).toBe('rules · jcode');
    expect(b).toBe('rules · jcode gtm');
    expect(v.check.items[1]!.b.text).toBe('b');
    expect(unlistedRef('~/.codex/USER.md')).toEqual({ kind: 'profile', owner: 'Codex', name: 'USER' });
    expect(unlistedRef('~/Projects/acme-web/AGENTS.md')).toEqual({ kind: 'rules', owner: 'acme-web', name: 'AGENTS' });
    expect(unlistedRef('subagent:oracle.md')).toEqual({ kind: 'other', owner: '', name: 'oracle' });
  });

  test('old rules read as words: no bold marks, list dash or link target', () => {
    expect(v.oldRules.map((r) => r.text)).toEqual(['Last Updated: 2025-10-29', 'una scheda di maggio: causa non provata']);
    expect(plainRule('## Titolo con `codice` e *enfasi*')).toBe('Titolo con codice e enfasi');
    expect(plainRule('1. passo __uno__')).toBe('passo uno');
    expect(plainRule('Giudici: lettori gratuiti (**mai O')).toBe('Giudici: lettori gratuiti (mai O');
    expect(plainRule('~/.claude/*.md resta com\'è')).toBe('~/.claude/*.md resta com\'è');
  });

  test('the failing checks of the agents\' hub', () => {
    expect(v.doctor).toEqual({ state: 'fail', total: 2, failing: ['skill fuori posto: demo'], error: null });
  });

  test('agents-doctor is green only when it answered ok: running is pending, an error or a bare not-ok is red', () => {
    expect(doctorVerdict({ ok: false, checks: [], error: null, pending: true })!.state).toBe('pending');
    expect(doctorVerdict({ ok: false, checks: [], error: 'agents-doctor: timeout 30s' })).toEqual({ state: 'fail', total: 0, failing: [], error: 'agents-doctor: timeout 30s' });
    expect(doctorVerdict({ ok: false, checks: [{ ok: true, text: 'a' }] })!.state).toBe('fail');
    expect(doctorVerdict({ ok: true, checks: [{ ok: true, text: 'a' }], error: null })).toEqual({ state: 'ok', total: 1, failing: [], error: null });
    expect(doctorVerdict(null)).toBeNull();
  });

  test('not an object, no view', () => {
    expect(contextView(null)).toBeNull();
    expect(contextView([])).toBeNull();
  });
});

describe('the check', () => {
  test('running, failed and never run, as the hub writes them', () => {
    expect(contextCheck({ at: null, items: [], running: true, startedAt: 5 }, undefined, 6)).toEqual({ at: null, running: true, error: null, items: [] });
    expect(contextCheck({ at: 9, items: [], running: false, error: 'risposta senza JSON' }).error).toBe('risposta senza JSON');
    expect(contextCheck(undefined)).toEqual({ at: null, running: false, error: null, items: [] });
  });

  test('a check left running by a hub that restarted is over after 20 minutes, so it can start again', () => {
    const now = 1_000_000_000;
    expect(contextCheck({ running: true, startedAt: now - CHECK_STALE_MS + 1 }, undefined, now).running).toBe(true);
    expect(contextCheck({ running: true, startedAt: now - CHECK_STALE_MS }, undefined, now).running).toBe(false);
    expect(contextCheck({ running: true }, undefined, now).running).toBe(false);
  });

  test('the start: taken, already running, refused in demo, refused with an error', () => {
    expect(checkStart(200, { ok: true })).toEqual({ ok: true, already: false });
    expect(checkStart(200, { ok: true, already: true })).toEqual({ ok: true, already: true });
    expect(checkStart(200, { ok: false, error: 'in demo il controllo non parte' })).toEqual({ ok: false, why: 'in demo il controllo non parte' });
    expect(checkStart(500, { error: 'nessun file da leggere' })).toEqual({ ok: false, why: 'nessun file da leggere' });
    expect(checkStart(502, null)).toEqual({ ok: false, why: 'HTTP 502' });
  });
});

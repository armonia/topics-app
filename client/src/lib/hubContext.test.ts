/**
 * The agents' context as pure reads of the hub's `/api/contesto`: the weight
 * per harness with the home sessions' memory as Claude Code's extra and not as
 * a fifth harness, the file labels in place of ids and paths, the old rules
 * oldest first, and the check's answers. Inputs are the hub's own shapes,
 * trimmed, with placeholder files.
 * @covers HUBBR-17
 */
import { describe, expect, test } from 'bun:test';
import { checkStart, contextCheck, contextView, harnessWeights, shortTokens } from './hubContext';

const HUB = {
  at: 1_793_901_551_906,
  files: [
    { id: 'claude-md', label: 'CLAUDE.md globale', path: '~/.claude/CLAUDE.md', group: 'Claude Code', loaders: ['Claude Code', 'OpenClaw (via claude-cli)'], tokens: 4443, note: '' },
    { id: 'inc:tools.md', label: 'TOOLS.md', path: '~/.claude/tools.md', group: 'Claude Code', loaders: ['Claude Code', 'OpenClaw (via claude-cli)'], tokens: 6282, note: 'incluso da CLAUDE.md' },
    { id: 'memory-index', label: 'Indice della memoria', path: '~/.claude/memory/MEMORY.md', group: 'Claude Code', loaders: ['Claude Code (sessioni nate in ~)'], tokens: 4907, note: '' },
    { id: 'broken', label: '', path: '~/x.md' },
  ],
  subagentPrompts: [{ id: 'subagent:oracle.md', label: 'Prompt del sottoagente oracle', path: '~/.claude/agents/oracle.md', group: 'Prompt dei sottoagenti', loaders: [], tokens: 439, note: '' }],
  otherSources: [{ id: 'project:acme-web', label: 'CLAUDE.md · acme-web', path: '~/Projects/acme-web/CLAUDE.md', group: 'CLAUDE.md dei progetti', loaders: [], tokens: 302, note: 'letto nelle sessioni di quel progetto' }],
  skills: { count: 41, tokens: 1780, loaders: ['Claude Code'], items: [] },
  duplicates: [{ text: 'Mai inviare email senza conferma', files: ['claude-md', 'project:acme-web'] }, { text: 'solo in un file', files: ['claude-md'] }],
  oldRules: [
    { file: 'memory-index', line: 77, text: 'una scheda di maggio', date: '2026-05-01', days: 188 },
    { file: 'project:studio-x', line: 212, text: 'Last Updated 2025-10-29', date: '2025-10-29', days: 372 },
  ],
  doctor: { ok: false, checks: [{ ok: true, text: 'nessun link rotto' }, { ok: false, text: 'skill fuori posto: demo' }], error: null },
  totals: { byLoader: { 'Claude Code': 14888, 'OpenClaw (via claude-cli)': 11162, Codex: 14890, jcode: 14890, 'Claude Code (sessioni nate in ~)': 4907 } },
  contradictions: {
    at: 1_792_976_303_647,
    items: [
      { a: { file: '~/.claude/CLAUDE.md', text: 'niente closers' }, b: { file: '~/.claude/output-styles/kind.md', text: 'chiudi con un prossimo passo' }, why: 'una vieta i closers, l\'altra li chiede' },
      { a: { file: '~/x' }, b: { file: '~/y', text: 'y' }, why: 'senza testo da un lato' },
    ],
    running: false,
  },
};

describe('harnessWeights', () => {
  test('a loader that qualifies another is its extra, one that qualifies nothing is a harness of its own', () => {
    const w = harnessWeights(HUB.totals.byLoader);
    expect(w.map((h) => h.name)).toEqual(['Codex', 'jcode', 'Claude Code', 'OpenClaw']);
    const cc = w.find((h) => h.name === 'Claude Code')!;
    expect(cc.tokens).toBe(14888);
    expect(cc.extra).toEqual({ tokens: 4907, home: true });
    expect(w.find((h) => h.name === 'OpenClaw')!.extra).toBeNull();
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
    expect(v.files[0]!.readers).toEqual(['Claude Code', 'OpenClaw']);
    expect(v.files[1]!.note).toBe('incluso da CLAUDE.md');
    expect(v.onDemand.map((f) => f.id)).toEqual(['subagent:oracle.md', 'project:acme-web']);
    expect(v.skills).toEqual({ count: 41, tokens: 1780 });
  });

  test('duplicates, old rules and contradictions name files by their label, never by id or path', () => {
    expect(v.duplicates).toEqual([{ text: 'Mai inviare email senza conferma', where: ['CLAUDE.md globale', 'CLAUDE.md · acme-web'] }]);
    expect(v.oldRules.map((r) => [r.where, r.days])).toEqual([['studio-x', 372], ['Indice della memoria', 188]]);
    expect(v.check.items).toHaveLength(1);
    expect(v.check.items[0]!.a.where).toBe('CLAUDE.md globale');
    expect(v.check.items[0]!.b.where).toBe('kind.md');
    expect(v.check.at).toBe(1_792_976_303_647);
  });

  test('the failing checks of the agents\' hub', () => {
    expect(v.doctor).toEqual({ total: 2, failing: ['skill fuori posto: demo'] });
  });

  test('not an object, no view', () => {
    expect(contextView(null)).toBeNull();
    expect(contextView([])).toBeNull();
  });
});

describe('the check', () => {
  test('running, failed and never run, as the hub writes them', () => {
    expect(contextCheck({ at: null, items: [], running: true, startedAt: 5 })).toEqual({ at: null, running: true, error: null, items: [] });
    expect(contextCheck({ at: 9, items: [], running: false, error: 'risposta senza JSON' }).error).toBe('risposta senza JSON');
    expect(contextCheck(undefined)).toEqual({ at: null, running: false, error: null, items: [] });
  });

  test('the start: taken, already running, refused in demo, refused with an error', () => {
    expect(checkStart(200, { ok: true })).toEqual({ ok: true, already: false });
    expect(checkStart(200, { ok: true, already: true })).toEqual({ ok: true, already: true });
    expect(checkStart(200, { ok: false, error: 'in demo il controllo non parte' })).toEqual({ ok: false, why: 'in demo il controllo non parte' });
    expect(checkStart(500, { error: 'nessun file da leggere' })).toEqual({ ok: false, why: 'nessun file da leggere' });
    expect(checkStart(502, null)).toEqual({ ok: false, why: 'HTTP 502' });
  });
});

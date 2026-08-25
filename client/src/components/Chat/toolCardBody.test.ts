/**
 * «La skill non apre nulla»: il chevron prometteva un corpo che non esisteva.
 *
 * Chi decide se una riga di tool ha qualcosa da aprire deve dire la STESSA cosa
 * alla card (che disegna il corpo) e alla riga (che disegna il gesto per
 * aprirlo): finché la card tornava `null` per conto suo, il chevron restava lì
 * e apriva il vuoto.
 *
 * @covers CHAT-02
 */

import { describe, expect, test } from 'bun:test';
import type { ToolCallDetail } from '../../types';
import { skillInstructions, toolCardHasBody } from './toolCardBody';

describe('skillInstructions', () => {
  test('«Launching skill: X» vale quanto il vuoto', () => {
    expect(skillInstructions('Launching skill: recap')).toBeNull();
    expect(skillInstructions('  Launching skill: caveman  ')).toBeNull();
  });

  test('il corpo vero passa, ripulito ai bordi', () => {
    expect(skillInstructions('  Fai un riassunto in 2 righe.\n')).toBe('Fai un riassunto in 2 righe.');
  });

  test('assente o vuoto: niente', () => {
    expect(skillInstructions(undefined)).toBeNull();
    expect(skillInstructions('   ')).toBeNull();
  });
});

describe('toolCardHasBody', () => {
  test('una Skill senza istruzioni non offre il gesto; con le istruzioni sì', () => {
    expect(toolCardHasBody({ type: 'skill', skill: 'recap', result: 'Launching skill: recap' })).toBe(false);
    expect(toolCardHasBody({ type: 'skill', skill: 'recap' })).toBe(false);
    expect(toolCardHasBody({ type: 'skill', skill: 'recap', result: 'Fai un riassunto.' })).toBe(true);
  });

  test('uno SlashCommand senza output non ha corpo', () => {
    expect(toolCardHasBody({ type: 'slash_command', command: '/compact' })).toBe(false);
    expect(toolCardHasBody({ type: 'slash_command', command: '/compact', result: 'fatto' })).toBe(true);
  });

  test('un MCP senza argomenti né risultato non ha corpo', () => {
    expect(toolCardHasBody({ type: 'mcp', server: 'topics', tool: 'ping' })).toBe(false);
    expect(toolCardHasBody({ type: 'mcp', server: 'topics', tool: 'ping', args: {} })).toBe(false);
    expect(toolCardHasBody({ type: 'mcp', server: 'topics', tool: 'get', args: { id: 1 } })).toBe(true);
    expect(toolCardHasBody({ type: 'mcp', server: 'topics', tool: 'get', result: 'ok' })).toBe(true);
  });

  test('uno sconosciuto nudo non ha corpo', () => {
    expect(toolCardHasBody({ type: 'unknown', raw: {} })).toBe(false);
    expect(toolCardHasBody({ type: 'unknown', raw: { result: 'ok' } })).toBe(true);
  });

  test('tutto il resto un corpo ce l\'ha sempre: almeno il percorso o il comando', () => {
    const sempre: ToolCallDetail[] = [
      { type: 'shell', command: 'ls' },
      { type: 'read', filePath: '/a.ts' },
      { type: 'edit', filePath: '/a.ts' },
      { type: 'write', filePath: '/a.ts' },
      { type: 'search', query: 'foo' },
      { type: 'fetch', url: 'https://x' },
      { type: 'todo', items: [] },
      { type: 'sub_agent', actions: [] },
      { type: 'plan', text: 'x' },
      { type: 'monitor', description: 'd' },
      { type: 'bash_output', shellId: 's' },
      { type: 'kill_shell', shellId: 's' },
      { type: 'notebook_edit', notebookPath: '/n.ipynb' },
      { type: 'lsp', operation: 'hover' },
    ];
    for (const d of sempre) expect(toolCardHasBody(d), d.type).toBe(true);
  });
});

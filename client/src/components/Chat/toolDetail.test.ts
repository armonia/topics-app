/**
 * Client mirror of `deriveToolDetail` + display labels — parity check for the
 * background / harness tools that previously fell through to `unknown`
 * (Monitor, BashOutput, KillShell, NotebookEdit, Skill, SlashCommand, LSP).
 *
 * The server is the source of truth at the stream boundary; this mirror is the
 * defensive fallback for legacy rows / providers without server-built detail.
 * Both must agree, and a server-built detail must survive `resolveToolDetail`
 * (schema validation) instead of being dropped back to the generic view.
 */

import { describe, expect, test } from 'bun:test';
import { deriveToolDetail, buildToolDisplayLabel, resolveToolDetail } from './toolDetail';
import type { ToolCall } from '../../types';

describe('deriveToolDetail — background / harness tools', () => {
  test('background Bash carries the background flag + label', () => {
    const d = deriveToolDetail('Bash', { command: 'npm run dev', run_in_background: true });
    expect(d.type).toBe('shell');
    if (d.type === 'shell') expect(d.background).toBe(true);
    expect(buildToolDisplayLabel(d).name).toBe('Shell (background)');
  });

  test('Monitor', () => {
    const d = deriveToolDetail('Monitor', { description: 'errors', ws: { url: 'wss://x' }, persistent: true });
    expect(d.type).toBe('monitor');
    if (d.type === 'monitor') {
      expect(d.description).toBe('errors');
      expect(d.wsUrl).toBe('wss://x');
      expect(d.persistent).toBe(true);
    }
    expect(buildToolDisplayLabel(d).name).toBe('Monitor');
  });

  test('BashOutput / KillShell', () => {
    const bo = deriveToolDetail('BashOutput', { bash_id: 'sh_1', filter: 'ERR' }, 'line');
    expect(bo.type).toBe('bash_output');
    if (bo.type === 'bash_output') expect(bo.shellId).toBe('sh_1');
    const ks = deriveToolDetail('KillBash', { shell_id: 'sh_2' });
    expect(ks.type).toBe('kill_shell');
    if (ks.type === 'kill_shell') expect(ks.shellId).toBe('sh_2');
  });

  test('NotebookEdit / Skill / SlashCommand / LSP', () => {
    expect(deriveToolDetail('NotebookEdit', { notebook_path: '/a.ipynb' }).type).toBe('notebook_edit');
    expect(deriveToolDetail('Skill', { skill: 'deploy' }).type).toBe('skill');
    expect(deriveToolDetail('SlashCommand', { command: '/review' }).type).toBe('slash_command');
    expect(deriveToolDetail('LSP', { operation: 'hover' }).type).toBe('lsp');
  });

  test('unknown tools still fall through', () => {
    expect(deriveToolDetail('WhoKnows', { x: 1 }).type).toBe('unknown');
  });
});

describe('resolveToolDetail — server-built detail survives validation', () => {
  test('a server monitor detail is not dropped to the client fallback', () => {
    const tc: ToolCall = {
      id: 't1',
      name: 'Monitor',
      args: { description: 'x' },
      status: 'running',
      detail: { type: 'monitor', description: 'errors in deploy.log', persistent: true },
    };
    const d = resolveToolDetail(tc);
    expect(d.type).toBe('monitor');
    if (d.type === 'monitor') expect(d.description).toBe('errors in deploy.log');
  });
});

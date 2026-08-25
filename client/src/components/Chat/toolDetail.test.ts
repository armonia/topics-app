/**
 * Client mirror of `deriveToolDetail` + display labels — parity check for the
 * background / harness tools that previously fell through to `unknown`
 * (Monitor, BashOutput, KillShell, NotebookEdit, Skill, SlashCommand, LSP).
 *
 * The server is the source of truth at the stream boundary; this mirror is the
 * defensive fallback for legacy rows / providers without server-built detail.
 * Both must agree, and a server-built detail must survive `resolveToolDetail`
 * (schema validation) instead of being dropped back to the generic view.
 *
 * @covers TOOL-PARITY-01
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

  test('wait_for_process: e\' un\'ATTESA, non un MCP generico', () => {
    const d = deriveToolDetail(
      'mcp__topics__wait_for_process',
      { process_id: 'p-42', until: 'ready', timeout_ms: 30000 },
      'still running',
    );
    expect(d.type).toBe('wait');
    if (d.type === 'wait') {
      expect(d.processId).toBe('p-42');
      expect(d.until).toBe('ready');
      expect(d.timeoutMs).toBe(30000);
      expect(d.result).toBe('still running');
    }
    const label = buildToolDisplayLabel(d);
    expect(label.name).toBe('Wait');
    expect(label.summary).toContain('p-42');
  });

  test('un MCP che non e\' l\'attesa resta un MCP', () => {
    expect(deriveToolDetail('mcp__topics__list_processes', {}).type).toBe('mcp');
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

// ── TaskCreate / TaskUpdate (CLI 2.1.220) ──────────────────────────────────
//
// Il vecchio `TodoWrite` portava l'intera lista; questi due agiscono su un task
// per volta. Non riconoscerli faceva cadere la todo nella card generica — JSON
// grezzo a schermo.
describe('toolDetail — TaskCreate / TaskUpdate', () => {
  test('TaskCreate diventa una voce todo `pending`', () => {
    const d = deriveToolDetail('TaskCreate', { subject: 'Sistemare il parser', description: 'lungo…' });
    expect(d).toEqual({ type: 'todo', items: [{ content: 'Sistemare il parser', status: 'pending' }] });
  });

  test('TaskCreate porta activeForm quando c’è (è la riga dello spinner)', () => {
    const d = deriveToolDetail('TaskCreate', { subject: 'Girare i test', activeForm: 'Girando i test' });
    expect(d).toMatchObject({ type: 'todo', items: [{ activeForm: 'Girando i test' }] });
  });

  test('TaskUpdate con subject e status diventa la voce con QUELLO stato', () => {
    const d = deriveToolDetail('TaskUpdate', { taskId: '1', subject: 'Sistemare il parser', status: 'completed' });
    expect(d).toEqual({ type: 'todo', items: [{ content: 'Sistemare il parser', status: 'completed' }] });
  });

  test('TaskUpdate SENZA subject non finge una voce vuota', () => {
    // È il caso più comune (`{taskId, status}`): una riga di todo senza todo
    // sarebbe peggio della card generica.
    const d = deriveToolDetail('TaskUpdate', { taskId: '1', status: 'in_progress' });
    expect(d?.type).not.toBe('todo');
  });

  test('status "deleted" non si traveste da completato', () => {
    // Cancellare non è finire: mapparlo su `completed` direbbe una cosa falsa.
    const d = deriveToolDetail('TaskUpdate', { taskId: '1', subject: 'Roba', status: 'deleted' });
    expect(d?.type).not.toBe('todo');
  });

  test('il nome è riconosciuto senza badare a maiuscole e underscore', () => {
    for (const n of ['taskcreate', 'TASKCREATE', 'task_create', 'Task_Update']) {
      expect(deriveToolDetail(n, { subject: 'x' })?.type, n).toBe('todo');
    }
  });

  test('non ruba il caso `Task` (sub-agent), che è un tool diverso', () => {
    expect(deriveToolDetail('Task', { subagent_type: 'Explore', description: 'cerca' })?.type).toBe('sub_agent');
  });
});

describe('percorsi lunghi: si accorciano in MEZZO, non in coda', () => {
  test('il nome del file sopravvive', () => {
    const d = deriveToolDetail('Read', { file_path: '/Users/x/Projects/topics-app/client/src/components/Chat/MessageMetaFooter.tsx' });
    const { summary } = buildToolDisplayLabel(d);
    expect(summary).toContain('MessageMetaFooter.tsx');
    expect(summary).toContain('…');
    expect(summary!.length).toBeLessThan(45);
  });

  test('un percorso corto non viene toccato', () => {
    const d = deriveToolDetail('Read', { file_path: '/Users/x/Projects/topics-app/server.ts' });
    expect(buildToolDisplayLabel(d).summary).toBe('server.ts');
  });

  test('resta la cartella di testa, così si sa DOVE si è', () => {
    const d = deriveToolDetail('Edit', { file_path: '/Users/x/Projects/topics-app/client/src/state/pane/adapters/hooks/useProjectTabStatus.ts' });
    expect(buildToolDisplayLabel(d).summary).toMatch(/^client\/…\//);
  });

  test('senza abbastanza segmenti si lascia intero: un moncone sarebbe peggio', () => {
    const long = '/Users/x/' + 'a'.repeat(80) + '.ts';
    const d = deriveToolDetail('Read', { file_path: long });
    expect(buildToolDisplayLabel(d).summary).toBe('a'.repeat(80) + '.ts');
  });
});

describe('il piano scritto su file È un piano, non una scrittura', () => {
  // Da quando la CLI non espone più ExitPlanMode in plan mode (2.1.223,
  // verificato sul wire), il modello consegna il piano scrivendolo in
  // ~/.claude/plans/<slug>.md — e lì dentro spariva, come riga `Write` verso
  // una cartella che nessuno apre.
  test('una Write in .claude/plans/ diventa detail plan col testo del piano', () => {
    const d = deriveToolDetail('Write', {
      file_path: '/Users/utente/.claude/plans/context-you-are-working-deep-locket.md',
      content: '# Piano\n\n1. Prima cosa\n2. Seconda cosa',
    });
    expect(d.type).toBe('plan');
    if (d.type === 'plan') expect(d.text).toContain('1. Prima cosa');
    expect(buildToolDisplayLabel(d).name).toBe('Plan');
  });

  test('la riga chiusa mostra il piano SENZA la sintassi markdown', () => {
    // A card chiusa `# ` e `**` non strutturano niente: mangiano gli 80
    // caratteri che si leggono davvero.
    const d = deriveToolDetail('Write', {
      file_path: '/Users/utente/.claude/plans/roba.md',
      content: '# Piano\n\n1. **Primo passo** — leggere i file\n2. **Secondo passo** — scrivere',
    });
    const summary = buildToolDisplayLabel(d).summary!;
    expect(summary.startsWith('Piano 1. Primo passo — leggere i file')).toBe(true);
    expect(summary).not.toContain('#');
    expect(summary).not.toContain('**');
    expect(summary.length).toBeLessThanOrEqual(80);
  });

  test('una Write normale resta una Write', () => {
    const d = deriveToolDetail('Write', { file_path: '/Users/x/Projects/app/README.md', content: '# Ciao' });
    expect(d.type).toBe('write');
  });

  test('senza contenuto non si inventa un piano vuoto', () => {
    const d = deriveToolDetail('Write', { file_path: '/Users/x/.claude/plans/p.md' });
    expect(d.type).toBe('write');
  });
});

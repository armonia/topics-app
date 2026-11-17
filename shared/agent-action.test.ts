/**
 * classifyToolAction against tool names as the providers really send them:
 * Claude Code built-ins, Codex item types, the native engine's snake_case
 * tools, and MCP names direct and through the gateway.
 *
 * @covers STATUS-VISUAL-01k
 */
import { describe, expect, test } from 'bun:test';
import { AGENT_ACTIONS, classifyToolAction, isAgentAction, type AgentAction } from './agent-action';

const TABLE: Array<[string, AgentAction]> = [
  // Claude Code built-ins
  ['Read', 'read'], ['Grep', 'read'], ['Glob', 'read'], ['LS', 'read'], ['NotebookRead', 'read'],
  ['Edit', 'edit'], ['Write', 'edit'], ['MultiEdit', 'edit'], ['NotebookEdit', 'edit'],
  ['Bash', 'run'], ['BashOutput', 'run'], ['KillShell', 'run'], ['Monitor', 'run'],
  ['WebSearch', 'web'], ['WebFetch', 'web'],
  ['Task', 'delegate'], ['Agent', 'delegate'],
  ['AskUserQuestion', 'wait'], ['ExitPlanMode', 'wait'],
  ['TodoWrite', 'tool'], ['Skill', 'tool'],
  // Codex items
  ['command_execution', 'run'], ['file_change', 'edit'], ['web_search', 'web'], ['apply_patch', 'edit'],
  ['local_shell_call', 'run'], ['reasoning', 'think'], ['write', 'edit'],
  // Codex names a command_execution after the command line itself
  ['/bin/zsh -lc "bun test shared"', 'run'], ['ls -la', 'run'], ['git status --short', 'run'],
  // Muse prefixes its tool names
  ['tool.bash', 'run'], ['tool:read_file', 'read'],
  // aliases the tool detail parser already accepts (shared/tool-detail.ts)
  ['view', 'read'], ['str_replace', 'edit'], ['apply_diff', 'edit'], ['exec_command', 'run'], ['search', 'web'],
  // Native engine / Topics tools, snake_case
  ['read_file', 'read'], ['write_file', 'edit'], ['edit_file', 'edit'], ['bash', 'run'], ['grep', 'read'],
  ['glob', 'read'], ['web_fetch', 'web'], ['run_command', 'run'], ['run_script', 'run'],
  ['wait_for_process', 'run'], ['spawn_agent', 'delegate'], ['send_to_agent', 'delegate'],
  ['open_browser_pane', 'browse'], ['browser_act', 'browse'], ['browser_observe', 'browse'],
  ['create_task', 'tool'], ['update_task', 'tool'], ['todo_write', 'tool'], ['skill', 'tool'],
  // MCP, direct and through the gateway
  ['mcp__topics__spawn_agent', 'delegate'],
  ['mcp__topics__browser_eval', 'browse'],
  ['mcp__topics__open_browser_pane', 'browse'],
  ['mcp__topics__create_task', 'tool'],
  ['mcp__exa__web_search_exa', 'web'],
  ['mcp__exa__web_search_advanced_exa', 'web'],
  ['mcp__context7__query-docs', 'web'],
  ['mcp__context7__resolve-library-id', 'web'],
  ['mcp__wigolo__search', 'web'],
  ['mcp__fetch__fetch', 'web'],
  ['mcp__playwright__browser_click', 'browse'],
  ['mcp__claude-in-chrome__javascript_tool', 'browse'],
  ['mcp__chrome-devtools__take_screenshot', 'browse'],
  ['mcp__gateway__beeper__send_message', 'tool'],
  ['mcp__gateway__beeper__search', 'tool'],
  ['mcp__gateway__kiwi__search-flight', 'tool'],
  ['mcp__gateway__suno__audio-create', 'tool'],
  ['mcp__gateway__topics-board__board_tasks', 'tool'],
  ['mcp__gateway__playwright__navigate', 'browse'],
  ['mcp__gateway__wigolo__fetch_page', 'web'],
];

describe('classifyToolAction', () => {
  for (const [name, action] of TABLE) {
    test(`${name} → ${action}`, () => {
      expect(classifyToolAction(name)).toBe(action);
    });
  }

  test('the tool part wins over the server: a browser tool of a non-browser server', () => {
    expect(classifyToolAction('mcp__topics__browser_get_text')).toBe('browse');
  });

  test('an empty or unknown name is a generic tool, never a throw', () => {
    expect(classifyToolAction('')).toBe('tool');
    expect(classifyToolAction('   ')).toBe('tool');
    expect(classifyToolAction('mcp__')).toBe('tool');
    expect(classifyToolAction('SomethingNew')).toBe('tool');
  });

  test('every result is one of the declared actions', () => {
    for (const [name] of TABLE) expect(AGENT_ACTIONS).toContain(classifyToolAction(name));
  });
});

describe('isAgentAction', () => {
  test('accepts the eleven words and nothing else', () => {
    for (const a of AGENT_ACTIONS) expect(isAgentAction(a)).toBe(true);
    expect(isAgentAction('search')).toBe(false);
    expect(isAgentAction(undefined)).toBe(false);
  });
});

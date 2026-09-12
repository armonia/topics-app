/** @covers GUEST-19 */
import { describe, expect, test } from 'bun:test';
import type { BoardTask } from '../../lib/board';
import type { BoardFilters } from './constants';
import { runInitiatorName, taskMatchesFilters } from './taskFilter';

const base = {
  priority: 3, assignedTo: 'agent', text: 'Visible task', projectId: 'project-one',
  lastActorPersonName: 'Last author', lastActorDeviceName: 'Author device',
  runInitiatorPersonName: 'Run initiator', runComputerName: 'Execution node', labels: [],
} as unknown as BoardTask;

const filters: BoardFilters = {
  priority: [3], assignedTo: ['agent'], text: 'visible', projectId: ['project-one'], labels: [],
  person: [], computer: [], initiator: ['Run initiator'], runComputer: ['Execution node'],
};

describe('delegated-run board filters', () => {
  test('initiator and execution computer combine with existing axes using AND', () => {
    expect(taskMatchesFilters(base, filters)).toBe(true);
    expect(taskMatchesFilters({ ...base, runComputerName: 'Other node' }, filters)).toBe(false);
    expect(taskMatchesFilters({ ...base, assignedTo: 'other-agent' }, filters)).toBe(false);
  });

  test('suggestion inputs can be derived from the visible rows before filtering', () => {
    const visible = [base];
    const hidden = { ...base, id: 'hidden', runInitiatorPersonName: 'Hidden person' };
    expect(visible.filter((task) => taskMatchesFilters(task, filters))).toEqual([base]);
    expect(new Set(visible.map((task) => task.runInitiatorPersonName))).not.toContain(hidden.runInitiatorPersonName);
  });

  test('a device capability keeps a visible and filterable initiator', () => {
    const deviceRun = {
      ...base,
      runInitiatorPersonName: null,
      runInitiatorDeviceName: 'Authorized device',
    };
    const deviceFilters = { ...filters, initiator: ['Authorized device'] };
    expect(runInitiatorName(deviceRun)).toBe('Authorized device');
    expect(taskMatchesFilters(deviceRun, deviceFilters)).toBe(true);
  });
});

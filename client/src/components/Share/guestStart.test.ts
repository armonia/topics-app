/**
 * @covers GUEST-14
 * @covers GUEST-18
 */
import { describe, expect, test } from 'bun:test';
import { canGuestStart, guestStartRequest } from './guestStart';
import type { SharedTask } from './GuestCard';

const task = (agentStart: SharedTask['agentStart']): SharedTask => ({
  id: 'task one', text: 'Visible task', status: 'todo', project_id: 'project-one',
  preview_image: null, level: 'read', agentStart,
});

describe('guest delegated start surface', () => {
  test('only an effective executable capability reveals Start', () => {
    expect(canGuestStart(task(null))).toBe(false);
    expect(canGuestStart(task({
      capabilityId: 'cap-one', computerName: 'Node one', model: 'model-one',
      effort: 'medium', maxDurationMinutes: 30, executable: false,
    }))).toBe(false);
    expect(canGuestStart(task({
      capabilityId: 'cap-one', computerName: 'Node one', model: 'model-one',
      effort: 'medium', maxDurationMinutes: 30, executable: true,
    }))).toBe(true);
  });

  test('the Start request has an empty body and no caller-selected policy', () => {
    const [url, init] = guestStartRequest('task one');
    expect(url).toBe('/api/tasks/task%20one/run');
    expect(init).toEqual({ method: 'POST', credentials: 'same-origin' });
    expect(init.body).toBeUndefined();
    expect(init.headers).toBeUndefined();
  });
});

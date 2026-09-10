/**
 * The task feed store: not-yet-read is not the same as empty, patching one
 * task in place, and the feed having exactly one owner.
 *
 * @covers KANBAN-06
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import type { BoardTask } from './board';
import {
  __resetBoardTasks, applyBoardTaskFrame, canAbsorbBoardTaskFrame, getBoardTasks,
  getBoardTasksError, hasLoadedBoardTasks, markBoardTasksFailed, patchBoardTask,
  requestBoardTasksRefresh, setBoardTasks, setBoardTasksRefresher, subscribeBoardTasks,
} from './boardTasksStore';

const task = (id: string, over: Partial<BoardTask> = {}): BoardTask =>
  ({ id, projectId: 'pX', text: id, status: 'todo', kanbanOrder: 0, ...over } as BoardTask);

beforeEach(() => { __resetBoardTasks(); });

describe('«non ho ancora letto» non è «non c\'è niente»', () => {
  test('a boot the list is empty and NOTHING has been read', () => {
    expect(getBoardTasks()).toEqual([]);
    expect(hasLoadedBoardTasks()).toBe(false);
  });

  test('a read that comes back empty-handed still stops the wait', () => {
    // Without this the cross-project board would spin on its waiting ring for
    // ever: the store never receives a write, so "loaded" never arrives.
    let woken = 0;
    subscribeBoardTasks(() => { woken++; });
    markBoardTasksFailed('server unreachable');
    expect(hasLoadedBoardTasks()).toBe(true);
    expect(getBoardTasks()).toEqual([]);
    expect(woken).toBe(1);
    markBoardTasksFailed('server unreachable');
    expect(woken).toBe(1); // already settled on the same failure: no empty wake-up
  });
});

/**
 * STOPPING THE WAITING RING IS NOT SAYING WHAT HAPPENED.
 *
 * The "settled" state on its own draws an empty board, or worse yesterday's
 * board (the seed from the local copy is born `loaded`), indistinguishable
 * from one just read. The two reads - the one that came back and the one that
 * never did - have to stay tellable apart by whoever draws, which is the only
 * way one of them can say so and the other stay quiet.
 */
describe('"read it, there is nothing" is not "I could not read"', () => {
  test('the failed read keeps the rows it had and says why', () => {
    setBoardTasks([task('a'), task('b')]);
    markBoardTasksFailed('Load failed');
    expect(getBoardTasks().map((t) => t.id)).toEqual(['a', 'b']);
    expect(getBoardTasksError()).toBe('Load failed');
  });

  test('a read that comes back clears the message, empty list included', () => {
    markBoardTasksFailed('Load failed');
    setBoardTasks([]);
    expect(hasLoadedBoardTasks()).toBe(true);
    expect(getBoardTasksError()).toBeNull();
  });

  test('a different failure replaces the message, and wakes the readers', () => {
    markBoardTasksFailed('Load failed');
    let woken = 0;
    subscribeBoardTasks(() => { woken++; });
    markBoardTasksFailed('500 internal error');
    expect(getBoardTasksError()).toBe('500 internal error');
    expect(woken).toBe(1);
  });
});

describe('patchBoardTask', () => {
  test('the optimistic patch is visible to EVERY reader of the store', () => {
    setBoardTasks([task('a'), task('b')]);
    patchBoardTask('b', { status: 'done' });
    expect(getBoardTasks().map((t) => t.status)).toEqual(['todo', 'done']);
  });

  test('an id that is not in the feed wakes nobody', () => {
    setBoardTasks([task('a')]);
    let woken = 0;
    subscribeBoardTasks(() => { woken++; });
    patchBoardTask('ghost', { status: 'done' });
    expect(woken).toBe(0);
    expect(getBoardTasks()[0].status).toBe('todo');
  });
});

/**
 * THE FRAME IS THE ANSWER, WHEN IT STAYS INSIDE THE FEED'S CUT.
 *
 * `task:updated` carries the whole row, so absorbing it spares a 73 KB re-read
 * of the cross-project feed. What must NOT be absorbed is a frame that moves
 * the row in or out of that cut - a new id, another column, another parent -
 * because then it is the OTHER rows that move too, and only a read knows how.
 */
describe('absorbing a task:updated instead of re-reading the feed', () => {
  test('same column, same parent: the row is written in place', () => {
    setBoardTasks([task('a'), task('b')]);
    const applied = applyBoardTaskFrame(task('b', { text: 'renamed', priority: 3 }));
    expect(applied).toBe(true);
    expect(getBoardTasks().map((t) => t.text)).toEqual(['a', 'renamed']);
  });

  test('a field the frame does not carry survives the merge', () => {
    // A client newer than its server: the row keeps what it had instead of
    // losing it to an absent key.
    setBoardTasks([task('a', { dispatchState: 'working' })]);
    const frame = task('a');
    delete (frame as { dispatchState?: unknown }).dispatchState;
    applyBoardTaskFrame(frame);
    expect(getBoardTasks()[0].dispatchState).toBe('working');
  });

  test('an id the store never saw is not absorbed', () => {
    setBoardTasks([task('a')]);
    expect(canAbsorbBoardTaskFrame(task('ghost'))).toBe(false);
    expect(applyBoardTaskFrame(task('ghost'))).toBe(false);
    expect(getBoardTasks()).toHaveLength(1);
  });

  test('a status that moved is not absorbed: other rows move with it', () => {
    setBoardTasks([task('a')]);
    expect(canAbsorbBoardTaskFrame(task('a', { status: 'done' }))).toBe(false);
    expect(getBoardTasks()[0].status).toBe('todo');
  });

  test('a row that gained a parent is not absorbed: it leaves the columns', () => {
    setBoardTasks([task('a')]);
    expect(canAbsorbBoardTaskFrame(task('a', { parentTaskId: 'p1' }))).toBe(false);
  });

  test('a frame with no task at all is not absorbed', () => {
    setBoardTasks([task('a')]);
    expect(canAbsorbBoardTaskFrame(undefined)).toBe(false);
    expect(applyBoardTaskFrame(null)).toBe(false);
  });
});

describe('one owner of the feed, N askers', () => {
  test('without an owner the request is a no-op, not a throw', () => {
    expect(() => requestBoardTasksRefresh()).not.toThrow();
  });

  test('the request reaches the owner', () => {
    let reads = 0;
    setBoardTasksRefresher(() => { reads++; });
    requestBoardTasksRefresh();
    requestBoardTasksRefresh();
    expect(reads).toBe(2);
  });

  test('an owner that unmounts LATE does not unhook the one that replaced it', () => {
    // Sotto StrictMode (e a ogni rimonta) il montaggio del nuovo arriva prima
    // dello smontaggio del vecchio: se la disiscrizione fosse incondizionata
    // lascerebbe lo store senza proprietario, e ogni richiesta cadrebbe nel
    // vuoto senza che nulla lo dica.
    let vecchio = 0;
    let nuovo = 0;
    const oldUnhook = setBoardTasksRefresher(() => { vecchio++; });
    setBoardTasksRefresher(() => { nuovo++; });
    oldUnhook();
    requestBoardTasksRefresh();
    expect([vecchio, nuovo]).toEqual([0, 1]);
  });
});

import { beforeEach, describe, expect, test } from 'bun:test';
import type { BoardTask } from './board';
import {
  __resetBoardTasks, getBoardTasks, hasLoadedBoardTasks, markBoardTasksSettled,
  patchBoardTask, requestBoardTasksRefresh, setBoardTasks, setBoardTasksRefresher,
  subscribeBoardTasks,
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
    // Senza questo la board generale filerebbe per sempre sul giro d'attesa:
    // lo store non riceve mai una scrittura, quindi «caricato» non arriva mai.
    let woken = 0;
    subscribeBoardTasks(() => { woken++; });
    markBoardTasksSettled();
    expect(hasLoadedBoardTasks()).toBe(true);
    expect(getBoardTasks()).toEqual([]);
    expect(woken).toBe(1);
    markBoardTasksSettled();
    expect(woken).toBe(1); // già assestato: nessun risveglio a vuoto
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
    const unhookVecchio = setBoardTasksRefresher(() => { vecchio++; });
    setBoardTasksRefresher(() => { nuovo++; });
    unhookVecchio();
    requestBoardTasksRefresh();
    expect([vecchio, nuovo]).toEqual([0, 1]);
  });
});

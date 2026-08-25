import { describe, expect, it } from 'bun:test';
import {
  locateTerminalPane,
  locateByPaneId,
  type ProjectPanesStore,
} from './terminalLocator';
import { projectPanesLocalKey } from './projectLayoutSync';

/** In-memory ProjectPanesStore backed by a plain object, mirroring the
 *
 * @covers TERM-01
 *  `topics-project-panes-<hash>` localStorage channel. */
function makeStore(entries: Record<string, unknown>): ProjectPanesStore {
  const map = new Map<string, string>();
  for (const [k, v] of Object.entries(entries)) map.set(k, JSON.stringify(v));
  return {
    keys: () => [...map.keys()],
    getItem: (k) => map.get(k) ?? null,
  };
}

/** Build a persisted project record hosting the given terminal pane ids. */
function projectRecord(...paneIds: string[]) {
  return { nonChatPanes: paneIds.map((id) => ({ id, type: 'terminal' })), openChatTopicIds: [] };
}

describe('locateTerminalPane', () => {
  it('reports none for an empty session id', () => {
    expect(locateTerminalPane('', [], [], makeStore({})).kind).toBe('none');
  });

  it('reports none when the session is open nowhere', () => {
    const store = makeStore({});
    expect(locateTerminalPane('S1', ['chat:a', 'terminal:OTHER'], ['/p'], store)).toEqual({
      kind: 'none',
    });
  });

  it('finds a standalone app-level tab', () => {
    const store = makeStore({});
    const loc = locateTerminalPane('S1', ['terminal:S1', 'chat:a'], [], store);
    expect(loc).toEqual({ kind: 'standalone' });
  });

  it('standalone takes precedence over a stale project record', () => {
    // Same session listed BOTH app-level and in a project layout — the live
    // app-level surface wins (project record is likely a stale snapshot).
    const store = makeStore({ [projectPanesLocalKey('/proj')]: projectRecord('terminal:S1') });
    const loc = locateTerminalPane('S1', ['terminal:S1'], ['/proj'], store);
    expect(loc).toEqual({ kind: 'standalone' });
  });

  it('finds a session inside a KNOWN project (path passed)', () => {
    const store = makeStore({
      [projectPanesLocalKey('/proj')]: projectRecord('terminal:S1', 'browser:ctx'),
    });
    const loc = locateTerminalPane('S1', ['chat:a'], ['/proj'], store);
    expect(loc).toEqual({ kind: 'project', projectPath: '/proj' });
  });

  it('finds a session inside an UNKNOWN project via the full scan', () => {
    // Session lives in /other, but the caller only knows /proj. The scan still
    // detects the duplicate; it just cannot name the window (one-way hash).
    const store = makeStore({
      [projectPanesLocalKey('/other')]: projectRecord('terminal:S1'),
      [projectPanesLocalKey('/proj')]: projectRecord('terminal:S2'),
    });
    const loc = locateTerminalPane('S1', ['chat:a'], ['/proj'], store);
    expect(loc).toEqual({ kind: 'project-unknown' });
  });

  it('attributes the path when the hosting project IS in knownProjectPaths', () => {
    const store = makeStore({
      [projectPanesLocalKey('/other')]: projectRecord('terminal:S1'),
    });
    // /other passed as known → full scan attributes it to a named path.
    const loc = locateTerminalPane('S1', [], ['/proj', '/other'], store);
    expect(loc).toEqual({ kind: 'project', projectPath: '/other' });
  });

  it('ignores malformed / non-JSON project records', () => {
    const bad: ProjectPanesStore = {
      keys: () => [projectPanesLocalKey('/p')],
      getItem: () => '{not json',
    };
    expect(locateTerminalPane('S1', [], ['/p'], bad).kind).toBe('none');
  });

  it('ignores records whose nonChatPanes is missing or not an array', () => {
    const store = makeStore({
      [projectPanesLocalKey('/a')]: { nonChatPanes: null },
      [projectPanesLocalKey('/b')]: { foo: 'bar' },
    });
    expect(locateTerminalPane('S1', [], ['/a', '/b'], store).kind).toBe('none');
  });

  it('does not confuse a session-id substring with a full match', () => {
    // pane id equality is exact — `terminal:S1` must not match `terminal:S12`.
    const store = makeStore({ [projectPanesLocalKey('/p')]: projectRecord('terminal:S12') });
    expect(locateTerminalPane('S1', ['terminal:S12'], ['/p'], store).kind).toBe('none');
  });
});

describe('locateByPaneId', () => {
  it('returns none for a non-terminal pane id', () => {
    expect(locateByPaneId('chat:abc', ['chat:abc'], [], makeStore({})).kind).toBe('none');
  });

  it('delegates to locateTerminalPane for a terminal pane id', () => {
    const loc = locateByPaneId('terminal:S1', ['terminal:S1'], [], makeStore({}));
    expect(loc).toEqual({ kind: 'standalone' });
  });
});

/**
 * Unit tests for the agent finite-state machine (v3 foundations AGENT-01
 * foundation). Locks the transition contract — every legal edge in the
 * design is exercised, every illegal edge from a representative sample is
 * rejected, terminal states are confirmed sealed.
 *
 * Run with: `bun test tests/unit/agent-fsm.test.ts`
 */
import { describe, expect, test } from 'bun:test';
import {
  AGENT_SESSION_STATES,
  AGENT_PROFILE_STATES,
  canTransitionSession,
  canTransitionProfile,
  nextSessionStates,
  nextProfileStates,
  isTerminalSessionState,
  parseAgentSessionState,
  parseAgentProfileState,
  applySessionTransition,
  applyProfileTransition,
  type AgentSessionState,
  type AgentProfileState,
} from '../../server/agent-fsm';

// ----- State constants ------------------------------------------------------

describe('state constants — match SQL CHECK constraints', () => {
  test('AGENT_SESSION_STATES matches the documented set', () => {
    expect(new Set(AGENT_SESSION_STATES)).toEqual(
      new Set(['active', 'paused', 'completed', 'error', 'stale']),
    );
  });

  test('AGENT_PROFILE_STATES matches the documented set', () => {
    expect(new Set(AGENT_PROFILE_STATES)).toEqual(
      new Set(['available', 'busy', 'paused', 'offline']),
    );
  });
});

// ----- Terminal-state predicate ---------------------------------------------

describe('isTerminalSessionState', () => {
  test('completed and error are terminal', () => {
    expect(isTerminalSessionState('completed')).toBe(true);
    expect(isTerminalSessionState('error')).toBe(true);
  });

  test('active, paused, stale are NOT terminal', () => {
    expect(isTerminalSessionState('active')).toBe(false);
    expect(isTerminalSessionState('paused')).toBe(false);
    expect(isTerminalSessionState('stale')).toBe(false);
  });
});

// ----- Session transitions --------------------------------------------------

describe('session transitions — legal edges', () => {
  const legalEdges: Array<[AgentSessionState, AgentSessionState]> = [
    ['active', 'paused'],
    ['active', 'completed'],
    ['active', 'error'],
    ['active', 'stale'],
    ['paused', 'active'],
    ['paused', 'completed'],
    ['paused', 'error'],
    ['paused', 'stale'],
    ['stale', 'active'], // heartbeat resumed
  ];

  for (const [from, to] of legalEdges) {
    test(`${from} → ${to} is allowed`, () => {
      expect(canTransitionSession(from, to)).toBe(true);
      const r = applySessionTransition(from, to);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.state).toBe(to);
    });
  }

  test('self-loop is allowed (idempotent writes)', () => {
    for (const s of AGENT_SESSION_STATES) {
      expect(canTransitionSession(s, s)).toBe(true);
    }
  });
});

describe('session transitions — illegal edges', () => {
  const illegalEdges: Array<[AgentSessionState, AgentSessionState]> = [
    // Terminal states never transition
    ['completed', 'active'],
    ['completed', 'paused'],
    ['completed', 'error'],
    ['completed', 'stale'],
    ['error', 'active'],
    ['error', 'completed'],
    ['error', 'paused'],
    ['error', 'stale'],
    // Stale can only resume to active, not jump directly to terminal
    ['stale', 'completed'],
    ['stale', 'error'],
    ['stale', 'paused'],
  ];

  for (const [from, to] of illegalEdges) {
    test(`${from} → ${to} is rejected`, () => {
      expect(canTransitionSession(from, to)).toBe(false);
      const r = applySessionTransition(from, to);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toContain(`${from} → ${to}`);
      }
    });
  }
});

describe('nextSessionStates', () => {
  test('lists all legal forward edges for active', () => {
    expect(new Set(nextSessionStates('active'))).toEqual(
      new Set(['paused', 'completed', 'error', 'stale']),
    );
  });

  test('returns empty for terminal states', () => {
    expect(nextSessionStates('completed')).toEqual([]);
    expect(nextSessionStates('error')).toEqual([]);
  });

  test('stale only allows resuming to active', () => {
    expect(nextSessionStates('stale')).toEqual(['active']);
  });
});

// ----- Profile transitions --------------------------------------------------

describe('profile transitions — legal edges', () => {
  const legalEdges: Array<[AgentProfileState, AgentProfileState]> = [
    ['available', 'busy'],
    ['available', 'paused'],
    ['available', 'offline'],
    ['busy', 'available'],
    ['busy', 'paused'],
    ['busy', 'offline'],
    ['paused', 'available'],
    ['paused', 'offline'],
    ['offline', 'available'],
  ];

  for (const [from, to] of legalEdges) {
    test(`${from} → ${to} is allowed`, () => {
      expect(canTransitionProfile(from, to)).toBe(true);
      const r = applyProfileTransition(from, to);
      expect(r.ok).toBe(true);
    });
  }
});

describe('profile transitions — illegal edges', () => {
  test('paused → busy is rejected (must unpause first)', () => {
    expect(canTransitionProfile('paused', 'busy')).toBe(false);
    const r = applyProfileTransition('paused', 'busy');
    expect(r.ok).toBe(false);
  });

  test('offline → busy is rejected (must come back available first)', () => {
    expect(canTransitionProfile('offline', 'busy')).toBe(false);
  });

  test('offline → paused is rejected', () => {
    expect(canTransitionProfile('offline', 'paused')).toBe(false);
  });
});

// ----- Zod parser -----------------------------------------------------------

describe('parseAgentSessionState', () => {
  test('accepts every documented state', () => {
    for (const s of AGENT_SESSION_STATES) {
      const r = parseAgentSessionState(s);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.data).toBe(s);
    }
  });

  test('rejects unknown state with path-qualified error', () => {
    const r = parseAgentSessionState('halted');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.length).toBeGreaterThan(0);
  });

  test('rejects non-string', () => {
    expect(parseAgentSessionState(null).ok).toBe(false);
    expect(parseAgentSessionState(42).ok).toBe(false);
    expect(parseAgentSessionState({}).ok).toBe(false);
  });
});

describe('parseAgentProfileState', () => {
  test('accepts every documented state', () => {
    for (const s of AGENT_PROFILE_STATES) {
      const r = parseAgentProfileState(s);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.data).toBe(s);
    }
  });

  test('rejects unknown state', () => {
    expect(parseAgentProfileState('zombie').ok).toBe(false);
  });
});

// ----- applyTransition reason strings ---------------------------------------

describe('applyTransition reason includes allowed targets', () => {
  test('session reason names the legal targets', () => {
    const r = applySessionTransition('active', 'invalid' as AgentSessionState);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain('paused');
      expect(r.reason).toContain('completed');
    }
  });

  test('session reason says (terminal) for completed/error', () => {
    const r = applySessionTransition('completed', 'active');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('terminal');
  });
});

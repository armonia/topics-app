/**
 * @covers NATDEL-03
 */
import { test, expect, describe } from 'bun:test';
import { createNativeDelegateRegistry, handleNativeDelegationFrame, isNativeDelegateFrameAllowed, type BrowserOpMessage } from './browser-native-delegate';

test('register / isDelegated / unregister', () => {
  const r = createNativeDelegateRegistry();
  expect(r.isDelegated('ctx')).toBe(false);
  r.register('ctx', () => {});
  expect(r.isDelegated('ctx')).toBe(true);
  expect(r.size()).toBe(1);
  r.unregister('ctx');
  expect(r.isDelegated('ctx')).toBe(false);
  expect(r.size()).toBe(0);
});

test('delegateOp forwards the op and resolves on the matching result', async () => {
  const sent: BrowserOpMessage[] = [];
  const r = createNativeDelegateRegistry({ genOpId: () => 'X' });
  r.register('ctx', (m) => sent.push(m));

  const p = r.delegateOp('ctx', 'browser_eval', { expression: '1+1' });
  expect(sent).toHaveLength(1);
  expect(sent[0]).toEqual({ type: 'browser_op', opId: 'X', tool: 'browser_eval', args: { expression: '1+1' } });

  // Client replies with the matching opId.
  r.resolveOp({ opId: 'X', result: { value: 2 } });
  expect(await p).toEqual({ value: 2 });
});

test('an error result surfaces as a structured { error }', async () => {
  const r = createNativeDelegateRegistry({ genOpId: () => 'Y' });
  r.register('ctx', () => {});
  const p = r.delegateOp('ctx', 'browser_act', {});
  r.resolveOp({ opId: 'Y', error: 'unsupported on native pane' });
  expect(await p).toEqual({ error: 'unsupported on native pane' });
});

test('delegateOp on an unregistered context resolves with an error (never hangs)', async () => {
  const r = createNativeDelegateRegistry();
  expect(await r.delegateOp('nope', 'browser_eval', {})).toEqual({ error: 'no native executor for context' });
});

test('timeout resolves with a structured error', async () => {
  const r = createNativeDelegateRegistry({ timeoutMs: 10, genOpId: () => 'T' });
  r.register('ctx', () => {});
  const out = (await r.delegateOp('ctx', 'browser_eval', {})) as { error: string };
  expect(out.error).toContain('timed out');
});

test('unregister fails the in-flight ops of that context', async () => {
  const r = createNativeDelegateRegistry({ genOpId: () => 'Z' });
  r.register('ctx', () => {});
  const p = r.delegateOp('ctx', 'browser_eval', {});
  r.unregister('ctx');
  expect(await p).toEqual({ error: 'native browser pane disconnected' });
});

// Reconnect race (the reason `owner` exists): the pane re-registers on a NEW
// socket, then the OLD socket's late close / heartbeat-reap fires unregister.
// Without the owner guard that would drop the fresh registration and reroute
// agent ops to the headless Playwright context instead of the live native pane.
test('unregister with a stale owner is a no-op (newer socket re-registered)', () => {
  const r = createNativeDelegateRegistry();
  const oldWs = { id: 'old' };
  const newWs = { id: 'new' };
  r.register('ctx', () => {}, oldWs);
  r.register('ctx', () => {}, newWs); // reconnect overwrites send + owner
  r.unregister('ctx', oldWs);         // stale cleanup — must NOT touch it
  expect(r.isDelegated('ctx')).toBe(true);
  r.unregister('ctx', newWs);         // the actual owner CAN drop it
  expect(r.isDelegated('ctx')).toBe(false);
});

test('unregister without an owner stays unconditional (legacy callers)', () => {
  const r = createNativeDelegateRegistry();
  r.register('ctx', () => {}, { id: 'ws' });
  r.unregister('ctx');
  expect(r.isDelegated('ctx')).toBe(false);
});

test('a stale/unknown result is ignored (no throw)', () => {
  const r = createNativeDelegateRegistry();
  expect(() => r.resolveOp({ opId: 'ghost', result: 1 }, undefined)).not.toThrow();
});

// The exact classifier server.ts runs on inbound /ws/browser frames.
test('handleNativeDelegationFrame: register frame registers this socket', () => {
  const r = createNativeDelegateRegistry();
  const out = handleNativeDelegationFrame({ type: 'register_native_executor' }, 'ctx', () => {}, r);
  expect(out).toBe('registered');
  expect(r.isDelegated('ctx')).toBe(true);
});

test('handleNativeDelegationFrame: result frame resolves the matching pending op', async () => {
  const r = createNativeDelegateRegistry({ genOpId: () => 'A' });
  const owner = {};
  r.register('ctx', () => {}, owner);
  const p = r.delegateOp('ctx', 'browser_eval', {});
  const out = handleNativeDelegationFrame({ type: 'browser_op_result', opId: 'A', result: 'ok' }, 'ctx', () => {}, r, owner);
  expect(out).toBe('result');
  expect(await p).toBe('ok');
});

test('an op result counts only from the socket registered for its context', async () => {
  const registry = createNativeDelegateRegistry({ genOpId: () => 'op-id' });
  const registeredSocket = {};
  const otherSocket = {};
  registry.register('ctx', () => {}, registeredSocket);
  const pending = registry.delegateOp('ctx', 'browser_eval', {});

  registry.resolveOp({ opId: 'op-id', result: 'wrong' }, otherSocket);
  registry.resolveOp({ opId: 'op-id', result: 'right' }, registeredSocket);

  expect(await pending).toBe('right');
});

test('native executor socket accepts only delegate frame types', () => {
  for (const type of ['register_native_executor', 'browser_op_result', 'take_control', 'native_dom_host', 'host_dom_events', 'host_dom_events_chunk', 'host_page', 'host_local_use', 'set_native_host_sharing']) {
    expect(isNativeDelegateFrameAllowed({ type })).toBe(true);
  }
  for (const type of ['nav', 'input', 'set_engine', 'resize']) {
    expect(isNativeDelegateFrameAllowed({ type })).toBe(false);
  }
});

test('generated op ids are random UUIDs', () => {
  const registry = createNativeDelegateRegistry();
  let opId = '';
  registry.register('ctx', (message) => { opId = message.opId; });
  void registry.delegateOp('ctx', 'browser_eval', {});
  expect(opId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  registry.unregister('ctx');
});

test('handleNativeDelegationFrame: a non-delegation frame falls through (null)', () => {
  const r = createNativeDelegateRegistry();
  expect(handleNativeDelegationFrame({ type: 'agent_active', active: true }, 'ctx', () => {}, r)).toBeNull();
  expect(handleNativeDelegationFrame(null, 'ctx', () => {}, r)).toBeNull();
  expect(handleNativeDelegationFrame('nope', 'ctx', () => {}, r)).toBeNull();
});

// ── Proprietà sulla REGISTRAZIONE (non solo sulla rimozione) ────────────────
//
// L'asimmetria che questi test chiudono: `unregister` aveva una guardia di
// proprietà e `register` no. Chi poteva aprire /ws/browser/:ctx su loopback col
// contextId di UN'ALTRA pane ne diventava l'esecutore, sovrascriveva la
// registrazione legittima e ne riceveva le tool-call — `browser_load_state`
// compreso, cioè lo stato di sessione e i cookie.
//
// La difficoltà vera non è rifiutare: è rifiutare SENZA rompere la
// riconnessione, che è esattamente il caso per cui la guardia di `unregister`
// esiste. Da qui la liveness iniettata: un socket chiuso non è un proprietario.
describe("register — guardia di proprietà", () => {
  const ALIVE = () => true;
  const DEAD = () => false;

  test("un secondo socket su un contextId servito da un esecutore VIVO è rifiutato", () => {
    const r = createNativeDelegateRegistry();
    const legittimo: BrowserOpMessage[] = [];
    const intruso: BrowserOpMessage[] = [];

    expect(r.register("ctx1", (m) => legittimo.push(m), "sock-a", ALIVE)).toBe(true);
    expect(r.register("ctx1", (m) => intruso.push(m), "sock-b", ALIVE)).toBe(false);

    // E il rifiuto deve VALERE: le tool-call continuano ad andare al legittimo.
    void r.delegateOp("ctx1", "browser_load_state", {});
    expect(legittimo).toHaveLength(1);
    expect(intruso).toHaveLength(0);
  });

  test("la RICONNESSIONE funziona ancora: il socket vecchio è chiuso, il nuovo subentra", () => {
    const r = createNativeDelegateRegistry();
    const vecchio: BrowserOpMessage[] = [];
    const nuovo: BrowserOpMessage[] = [];

    r.register("ctx1", (m) => vecchio.push(m), "sock-a", DEAD);
    expect(r.register("ctx1", (m) => nuovo.push(m), "sock-b", ALIVE)).toBe(true);

    void r.delegateOp("ctx1", "browser_screenshot", {});
    expect(nuovo).toHaveLength(1);
    expect(vecchio).toHaveLength(0);
  });

  test("lo STESSO socket può ri-registrarsi (refresh), anche se vivo", () => {
    const r = createNativeDelegateRegistry();
    r.register("ctx1", () => {}, "sock-a", ALIVE);
    expect(r.register("ctx1", () => {}, "sock-a", ALIVE)).toBe(true);
  });

  test("un contextId LIBERO si registra sempre", () => {
    const r = createNativeDelegateRegistry();
    expect(r.register("ctx-nuovo", () => {}, "sock-a", ALIVE)).toBe(true);
    expect(r.isDelegated("ctx-nuovo")).toBe(true);
  });

  test("dopo unregister il contextId torna libero per chiunque", () => {
    const r = createNativeDelegateRegistry();
    r.register("ctx1", () => {}, "sock-a", ALIVE);
    r.unregister("ctx1", "sock-a");
    expect(r.register("ctx1", () => {}, "sock-b", ALIVE)).toBe(true);
  });

  test("senza prova di liveness si consente (comportamento storico), ma il valore lo dice", () => {
    // Un chiamante non aggiornato non deve rompersi; il subentro viene loggato.
    const r = createNativeDelegateRegistry();
    r.register("ctx1", () => {}, "sock-a");
    expect(r.register("ctx1", () => {}, "sock-b")).toBe(true);
  });

  test("registrazioni su contextId DIVERSI non si disturbano", () => {
    const r = createNativeDelegateRegistry();
    expect(r.register("ctx1", () => {}, "sock-a", ALIVE)).toBe(true);
    expect(r.register("ctx2", () => {}, "sock-b", ALIVE)).toBe(true);
    expect(r.size()).toBe(2);
  });
});

/**
 * v3 foundations WS-04 — CI contract test.
 *
 * Locks the wire-protocol shape of every Zod schema shipped through WS-01
 * and WS-02. Any change to a variant (added/removed field, renamed
 * discriminator, swapped optional/required) breaks the corresponding
 * assertion in this file with a diff that names the offender.
 *
 * Why structured assertions instead of a hash? A hash tells you SOMETHING
 * changed; a structured diff tells you EXACTLY what changed. The trade-off
 * is a slightly larger test file, but the PR-review value pays it back —
 * a reviewer sees "field `exitCode` moved from optional to required" and
 * can immediately judge whether that's a breaking change.
 *
 * To intentionally change a schema:
 *   1. Update the schema source.
 *   2. Update the corresponding expected snapshot in this file.
 *   3. If the change is backward-incompatible (field removed, narrowed,
 *      or made required), bump SERVER_PROTOCOL_VERSION in
 *      server/ws-capabilities.ts and document the change in
 *      .planning/WS-PROTOCOL.md.
 *
 * Run with: `bun test tests/unit/ws-contract.test.ts`
  * @covers WIRE-07
 */
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { browserWsMessageSchema } from '../../shared/browser-ws-messages';
import { chatWsInboundSchema } from '../../server/schemas/chat-ws-inbound';
import { toolCallDetailSchema } from '../../shared/tool-call-detail';
import {
  welcomeMessageSchema,
  helloMessageSchema,
  upgradeRequiredSchema,
} from '../../shared/ws-handshake';
import {
  SERVER_PROTOCOL_VERSION,
  SERVER_CAPABILITIES,
} from '../../server/ws-capabilities';

// ----- Helper: extract a stable contract signature from a Zod object --------
//
// A signature is `{ requiredKeys, optionalKeys, enumValues }` per object
// shape. We sort keys so the snapshot is order-independent. Optional fields
// are detected by checking `isOptional()` on each field's def.

interface FieldShape {
  requiredKeys: string[];
  optionalKeys: string[];
  enums: Record<string, string[]>;
  arrayKeys: string[];
  numberKeys: string[];
  literalKeys: Record<string, string | number | boolean | null>;
}

// I due sapori di zod espongono la stessa def sotto DUE nomi: `_def` nella
// variante piena, `def` in `zod/mini` (che `shared/ws-*` usa perché finisce nel
// bundle client). Leggerne uno solo faceva sembrare senza literal — e quindi
// "cambiato" — uno schema identico: il contratto è lo stesso, cambia l'involucro.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function defOf(field: any): any {
  return field?._def ?? field?.def;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isOptional(field: any): boolean {
  if (!field || typeof field !== 'object') return false;
  // Zod 4: `isOptional()` is the canonical API. Also check the def.type
  // as a fallback for nested wrappers (and for zod/mini, which has no methods).
  if (typeof field.isOptional === 'function') {
    return field.isOptional();
  }
  return defOf(field)?.type === 'optional';
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function unwrapField(field: any): any {
  // Strip optional/nullable wrappers to inspect the inner type. Zod 4
  // uses `def.type === 'optional' | 'nullable'` and `def.innerType`.
  let inner = field;
  while (
    inner &&
    (defOf(inner)?.type === 'optional' || defOf(inner)?.type === 'nullable') &&
    defOf(inner).innerType
  ) {
    inner = defOf(inner).innerType;
  }
  return inner;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function objectSignature(schema: any): FieldShape {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const shape: Record<string, any> = schema.shape ?? {};
  const required: string[] = [];
  const optional: string[] = [];
  const enums: Record<string, string[]> = {};
  const arrays: string[] = [];
  const numbers: string[] = [];
  const literals: Record<string, string | number | boolean | null> = {};

  for (const [key, field] of Object.entries(shape)) {
    (isOptional(field) ? optional : required).push(key);
    const inner = unwrapField(field);
    const innerDef = defOf(inner);
    const tn = innerDef?.type;
    if (tn === 'enum') {
      // Zod 4: enum entries are stored as { value: value } object.
      const entries = innerDef.entries ?? {};
      const values = Object.values(entries) as string[];
      enums[key] = [...values].sort();
    }
    if (tn === 'array') arrays.push(key);
    if (tn === 'number' || tn === 'int') numbers.push(key);
    if (tn === 'literal') {
      // Zod 4: def.values is an array (supports multi-value literal); take [0].
      const v = innerDef.values?.[0] ?? inner.value;
      literals[key] = v;
    }
  }

  return {
    requiredKeys: required.sort(),
    optionalKeys: optional.sort(),
    enums,
    arrayKeys: arrays.sort(),
    numberKeys: numbers.sort(),
    literalKeys: literals,
  };
}

// ----- Contract: server-side capabilities -----------------------------------

describe('WS-04 contract: server capabilities and protocol version', () => {
  test('SERVER_PROTOCOL_VERSION is locked at 1', () => {
    // Bumping this constant requires also documenting the breaking change
    // in WS-PROTOCOL.md per the contract.
    expect(SERVER_PROTOCOL_VERSION).toBe(1);
  });

  test('SERVER_CAPABILITIES is the frozen v1 set', () => {
    // Add a new capability when shipping a feature; remove only via the
    // deprecation policy (ship both for one major version).
    expect([...SERVER_CAPABILITIES].sort()).toEqual([
      'ask-user-tool',
      'browser-ws-v1',
      'chat-fast-mode',
      'stream-catchup-v1',
      'tool-detail-v1',
      'ws-validation-v1',
    ]);
  });
});

/**
 * Le varianti di una union discriminata. `zod` le espone su `.options`,
 * `zod/mini` sotto `.def.options`: gli schemi condivisi sono in mini (finiscono
 * nel bundle client), quindi si passa da qui invece di inchiodare il test a un
 * dialetto.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function variantsOf(schema: any): any[] {
  return schema.options ?? schema.def?.options ?? [];
}

// ----- Contract: browser-ws-messages (Phase 30 BROWSER-CHAT-02) -------------

describe('WS-04 contract: browserWsMessageSchema (Phase 30)', () => {
  test('discriminator literals are frozen', () => {
    const types = variantsOf(browserWsMessageSchema).map((opt) =>
      objectSignature(opt).literalKeys.type,
    );
    // Twelve variants joined the browser WS protocol since the 6-variant
    // freeze, all additive (server↔pane co-browse control channel):
    //   resize                              — pane viewport resize
    //   download                            — a file download the pane offers
    //   set_engine / engine                 — Native↔Chromium engine toggle + status
    //   set_stream                          — screencast on/off
    //   set_watching                        — is this pane on screen (the ONLY
    //                                         input of the cross-device viewer
    //                                         count; set_stream is the transport
    //                                         and pauses while still watching)
    //   set_render / render_mode            — pixel vs DOM co-browse render toggle + status
    //   dom_event                           — rrweb DOM co-browse event
    //   webrtc_offer / webrtc_answer / webrtc_ice — shared-session WebRTC transport
    //   focus_field                         — che campo ha preso il fuoco di là
    //                                         dopo il click, cioè quale tastiera
    //                                         deve aprire il telefono sul ramo
    //                                         video (dove non c'è nessun mirror
    //                                         DOM da interrogare)
    //   viewers                             — the cross-device viewer count,
    //                                         pushed by the server on every
    //                                         change; replaced the 2s poll of
    //                                         /viewers (44% of API traffic)
    //   focus_query                         — la stessa domanda chiesta a voce.
    //                                         Da quando l'input del ramo video
    //                                         va sul DataChannel, il click non
    //                                         passa più dal server e il campo a
    //                                         fuoco nessuno lo leggeva più
    expect([...types].sort()).toEqual([
      'agent_active',
      'console',
      'dom_event',
      'download',
      'engine',
      'focus_field',
      'focus_query',
      'frame',
      'input',
      'nav',
      'render_mode',
      'resize',
      'set_engine',
      'set_render',
      'set_stream',
      'set_watching',
      'take_control',
      'viewers',
      'webrtc_answer',
      'webrtc_ice',
      'webrtc_offer',
    ]);
  });

  test('frame: required = data + metadata + type, no optionals', () => {
    const frame = variantsOf(browserWsMessageSchema).find((o) =>
      objectSignature(o).literalKeys.type === 'frame',
    );
    expect(frame).toBeDefined();
    if (!frame) return;
    const sig = objectSignature(frame);
    expect(sig.requiredKeys).toEqual(['data', 'metadata', 'type']);
    expect(sig.optionalKeys).toEqual([]);
  });

  test('input.action enum is locked', () => {
    const input = variantsOf(browserWsMessageSchema).find((o) =>
      objectSignature(o).literalKeys.type === 'input',
    );
    if (!input) throw new Error('input variant missing');
    const sig = objectSignature(input);
    expect(sig.enums.action).toEqual(['click', 'keypress', 'mousemove', 'scroll', 'type']);
  });

  test('nav.phase enum is locked', () => {
    const nav = variantsOf(browserWsMessageSchema).find((o) =>
      objectSignature(o).literalKeys.type === 'nav',
    );
    if (!nav) throw new Error('nav variant missing');
    const sig = objectSignature(nav);
    // 'error' joined with web-path nav-error surfacing (PR #8): the server
    // resolves goto/launch failures as an error-phase frame the pane renders.
    expect(sig.enums.phase).toEqual(['error', 'request', 'response']);
  });

  test('console.level enum is locked', () => {
    const cons = variantsOf(browserWsMessageSchema).find((o) =>
      objectSignature(o).literalKeys.type === 'console',
    );
    if (!cons) throw new Error('console variant missing');
    const sig = objectSignature(cons);
    expect(sig.enums.level).toEqual(['error', 'log', 'warn']);
  });

  test('take_control has only `type` field', () => {
    const tc = variantsOf(browserWsMessageSchema).find((o) =>
      objectSignature(o).literalKeys.type === 'take_control',
    );
    if (!tc) throw new Error('take_control variant missing');
    const sig = objectSignature(tc);
    expect(sig.requiredKeys).toEqual(['type']);
    expect(sig.optionalKeys).toEqual([]);
  });
});

// ----- Contract: chat-ws-inbound (main /ws inbound + handshake hello) -------

describe('WS-04 contract: chatWsInboundSchema (main /ws)', () => {
  // presence:announce landed in 724284d3 (cross-window presence protocol),
  // taking the union from 8 → 9 variants.
  test('exactly 9 variants in the v3 set', () => {
    expect(chatWsInboundSchema.options.length).toBe(9);
  });

  test('discriminator literals are frozen', () => {
    const types = chatWsInboundSchema.options.map((opt) =>
      objectSignature(opt).literalKeys.type,
    );
    expect([...types].sort()).toEqual([
      'drag:drop',
      'drag:end',
      'drag:start',
      'focus',
      'hello',
      'ping',
      'presence:announce',
      'subscribe',
      'typing',
    ]);
  });

  test('hello: required fields match welcome message expectations', () => {
    const hello = chatWsInboundSchema.options.find((o) =>
      objectSignature(o).literalKeys.type === 'hello',
    );
    if (!hello) throw new Error('hello variant missing');
    const sig = objectSignature(hello);
    // The REQUIRED set is unchanged — 724284d3 added only OPTIONAL presence
    // fields (windowId/windowLabel/detached/topicIds/focusedTopicId) so old
    // clients keep parsing, e fe9cb377 ha aggiunto `tabs` con la stessa
    // regola: una finestra annuncia TUTTE le sue tab (terminali e browser
    // compresi), non solo le chat, e un peer più vecchio che non la manda
    // continua a essere accettato. topicIds is an optional array; hence
    // arrayKeys now includes it alongside the still-required capabilities.
    expect(sig.requiredKeys).toEqual(['capabilities', 'clientVersion', 'protocolVersion', 'type']);
    expect([...sig.optionalKeys].sort()).toEqual([
      'detached',
      'focusedTopicId',
      // `spaceId`: la finestra dichiara anche a quale spazio appartiene.
      // Opzionale come gli altri campi di presenza — un client più vecchio che
      // non lo manda resta valido.
      'spaceId',
      'tabs',
      'topicIds',
      'windowId',
      'windowLabel',
    ]);
    // `tabs` è un array come `topicIds`: la finestra ne manda uno per pane.
    expect([...sig.arrayKeys].sort()).toEqual(['capabilities', 'tabs', 'topicIds']);
    expect(sig.numberKeys).toEqual(['protocolVersion']);
  });
});

// ----- Contract: tool-call-detail (NORM-01) ---------------------------------

describe('WS-04 contract: toolCallDetailSchema (NORM-01)', () => {
  test('exactly 19 variants', () => {
    expect(variantsOf(toolCallDetailSchema).length).toBe(19);
  });

  test('discriminator literals are frozen', () => {
    const types = variantsOf(toolCallDetailSchema).map((opt) =>
      objectSignature(opt).literalKeys.type,
    );
    // Seven variants joined since the original 11-variant freeze, each a real
    // Claude Code tool now surfaced in the chat tool-call UI:
    //   bash_output   — BashOutput (poll a backgrounded shell)
    //   kill_shell    — KillShell (stop a backgrounded shell)
    //   monitor       — Monitor (streaming watch events)
    //   notebook_edit — NotebookEdit (Jupyter cells)
    //   skill         — Skill invocation
    //   slash_command — user-typed slash command
    //   lsp           — LSP language-server query
    //   wait          — WaitForProcess (block until a process ends)
    expect([...types].sort()).toEqual([
      'bash_output',
      'edit',
      'fetch',
      'kill_shell',
      'lsp',
      'mcp',
      'monitor',
      'notebook_edit',
      'plan',
      'read',
      'search',
      'shell',
      'skill',
      'slash_command',
      'sub_agent',
      'todo',
      'unknown',
      'wait',
      'write',
    ]);
  });

  test('shell: command required, cwd/output/exitCode optional', () => {
    const shell = variantsOf(toolCallDetailSchema).find((o) =>
      objectSignature(o).literalKeys.type === 'shell',
    );
    if (!shell) throw new Error('shell variant missing');
    const sig = objectSignature(shell);
    expect(sig.requiredKeys).toEqual(['command', 'type']);
    // `background` joined the shell variant (a Bash run with run_in_background)
    // — additive + optional, so backward-compatible with older clients.
    expect([...sig.optionalKeys].sort()).toEqual(['background', 'cwd', 'exitCode', 'output']);
  });

  test('search.toolName enum is locked', () => {
    const search = variantsOf(toolCallDetailSchema).find((o) =>
      objectSignature(o).literalKeys.type === 'search',
    );
    if (!search) throw new Error('search variant missing');
    const sig = objectSignature(search);
    expect(sig.enums.toolName).toEqual(['glob', 'grep', 'search', 'web_search']);
    expect(sig.enums.mode).toEqual(['content', 'count', 'files_with_matches']);
  });

  test('todo.items is required (an empty array is valid)', () => {
    const todo = variantsOf(toolCallDetailSchema).find((o) =>
      objectSignature(o).literalKeys.type === 'todo',
    );
    if (!todo) throw new Error('todo variant missing');
    const sig = objectSignature(todo);
    expect(sig.requiredKeys).toEqual(['items', 'type']);
  });

  test('sub_agent.actions is required, result is optional', () => {
    const subAgent = variantsOf(toolCallDetailSchema).find((o) =>
      objectSignature(o).literalKeys.type === 'sub_agent',
    );
    if (!subAgent) throw new Error('sub_agent variant missing');
    const sig = objectSignature(subAgent);
    expect(sig.requiredKeys).toEqual(['actions', 'type']);
    expect([...sig.optionalKeys].sort()).toEqual(['description', 'result', 'subAgentType']);
  });
});

// ----- Contract: handshake schemas (WS-02) ---------------------------------

describe('WS-04 contract: ws-handshake schemas (WS-02)', () => {
  test('welcomeMessageSchema shape is locked', () => {
    const sig = objectSignature(welcomeMessageSchema);
    expect(sig.requiredKeys).toEqual([
      'capabilities',
      'clientId',
      'protocolVersion',
      'serverTime',
      'serverVersion',
      'type',
    ]);
    expect(sig.optionalKeys).toEqual([]);
    expect(sig.literalKeys.type).toBe('welcome');
  });

  test('helloMessageSchema shape is locked', () => {
    const sig = objectSignature(helloMessageSchema);
    expect(sig.requiredKeys).toEqual([
      'capabilities',
      'clientVersion',
      'protocolVersion',
      'type',
    ]);
    expect(sig.optionalKeys).toEqual([]);
    expect(sig.literalKeys.type).toBe('hello');
  });

  test('upgradeRequiredSchema shape is locked', () => {
    const sig = objectSignature(upgradeRequiredSchema);
    expect(sig.requiredKeys).toEqual([
      'currentClientProtocolVersion',
      'message',
      'minClientProtocolVersion',
      'type',
    ]);
    expect(sig.literalKeys.type).toBe('upgrade-required');
  });
});

// ----- Sanity: assert objectSignature works on a synthetic schema -----------
// (Meta-test so a future Zod version bump that breaks our signature helper
// doesn't silently make every contract assertion pass.)

describe('WS-04 contract: signature helper meta-test', () => {
  test('detects required vs optional correctly', () => {
    const s = z.object({
      a: z.string(),
      b: z.string().optional(),
      c: z.number(),
      d: z.number().optional(),
    });
    const sig = objectSignature(s);
    expect(sig.requiredKeys).toEqual(['a', 'c']);
    expect(sig.optionalKeys).toEqual(['b', 'd']);
    expect(sig.numberKeys).toEqual(['c', 'd']);
  });

  test('extracts enum values', () => {
    const s = z.object({
      color: z.enum(['red', 'green', 'blue']),
    });
    const sig = objectSignature(s);
    expect(sig.enums.color).toEqual(['blue', 'green', 'red']);
  });
});

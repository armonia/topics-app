/**
 * @covers CCS-03, CCS-04
 *
 * La derivazione della fase dagli hook (CCS-03) e il reaper delle fasi rimaste
 * indietro (CCS-04): sono le due meta' della macchina a stati, entrambe qui.
 */
import { describe, expect, it } from 'bun:test';
import {
  ALL_PHASES,
  BUSY_SPINNER_PHASES,
  applyHook,
  applyJsonlEvent,
  deriveTranscriptPath,
  isBusySpinnerPhase,
  markDormant,
  markPtyCrash,
  makeInitialState,
  parseJsonlLine,
  reapStaleSession,
  reviveOnPtyActivity,
  splitJsonlChunk,
  type ClaudeSessionState,
  type ClaudeSessionPhase,
  type HookPayload,
} from './claude-session-state';

const T0 = 1_700_000_000_000;
const TICK = 1_000;

function freshState(overrides: Partial<ClaudeSessionState> = {}): ClaudeSessionState {
  return { ...makeInitialState('cli-abc', 'topic-1', T0), ...overrides };
}

function hook(name: string, extra: Partial<HookPayload> = {}): HookPayload {
  return { hook_event_name: name as any, session_id: 'cli-abc', ...extra };
}

describe('makeInitialState', () => {
  it('seeds a starting session with rev 0', () => {
    const s = makeInitialState('cli-x', 'topic-x', T0, '/tmp/x.jsonl');
    expect(s.phase).toBe('starting');
    expect(s.rev).toBe(0);
    expect(s.jsonlOffset).toBe(0);
    expect(s.jsonlPath).toBe('/tmp/x.jsonl');
    expect(s.createdAt).toBe(T0);
  });
});

describe('applyHook — phase transitions', () => {
  it('UserPromptSubmit moves starting → running and bumps rev', () => {
    const s0 = freshState();
    const s1 = applyHook(s0, hook('UserPromptSubmit'), T0 + TICK);
    expect(s1.phase).toBe('running');
    expect(s1.rev).toBe(1);
    expect(s1.phaseUpdatedAt).toBe(T0 + TICK);
    expect(s1.lastHookAt).toBe(T0 + TICK);
  });

  it('PreToolUse captures tool name and input', () => {
    const s0 = freshState({ phase: 'running', rev: 1 });
    const s1 = applyHook(s0, hook('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } }), T0 + TICK);
    expect(s1.phase).toBe('tool-running');
    expect(s1.lastTool).toEqual({ name: 'Bash', input: { command: 'ls' }, startedAt: T0 + TICK });
    expect(s1.rev).toBe(2);
  });

  it('PostToolUse returns tool-running → running and clears tool', () => {
    const s0 = freshState({ phase: 'tool-running', rev: 2, lastTool: { name: 'Bash', startedAt: T0 } });
    const s1 = applyHook(s0, hook('PostToolUse', { tool_name: 'Bash' }), T0 + TICK);
    expect(s1.phase).toBe('running');
    expect(s1.lastTool).toBeUndefined();
    expect(s1.rev).toBe(3);
  });

  it('PreToolUse AskUserQuestion parks at awaiting-approval (act-now), not tool-running', () => {
    // The bug: Claude asking the user a question showed a "working" spinner
    // instead of the amber "tocca a te" tier. AskUserQuestion means Claude is
    // BLOCKED on a human answer — it must enter awaiting-approval.
    const s0 = freshState({ phase: 'running', rev: 1 });
    const s1 = applyHook(s0, hook('PreToolUse', {
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ question: 'Which framework?', options: [{ label: 'React' }, { label: 'Vue' }] }] },
    }), T0 + TICK);
    expect(s1.phase).toBe('awaiting-approval');
    expect(s1.pendingApproval?.kind).toBe('other');
    expect(s1.pendingApproval?.prompt).toBe('Which framework?');
    expect(s1.pendingApproval?.requestedAt).toBe(T0 + TICK);
    // No working spinner: the active-tool field is cleared, not set.
    expect(s1.lastTool).toBeUndefined();
    expect(s1.rev).toBe(2);
  });

  it('PreToolUse AskUserQuestion with a malformed input still parks at awaiting-approval', () => {
    const s0 = freshState({ phase: 'running', rev: 1 });
    const s1 = applyHook(s0, hook('PreToolUse', { tool_name: 'AskUserQuestion', tool_input: {} }), T0 + TICK);
    expect(s1.phase).toBe('awaiting-approval');
    expect(s1.pendingApproval?.prompt).toBe('Claude is asking a question');
    expect(s1.rev).toBe(2);
  });

  it('PreToolUse ExitPlanMode parks at awaiting-approval with the plan as the prompt', () => {
    const s0 = freshState({ phase: 'running', rev: 1 });
    const s1 = applyHook(s0, hook('PreToolUse', {
      tool_name: 'ExitPlanMode',
      tool_input: { plan: '## Refactor auth\n1. Extract helper' },
    }), T0 + TICK);
    expect(s1.phase).toBe('awaiting-approval');
    expect(s1.pendingApproval?.kind).toBe('plan');
    expect(s1.pendingApproval?.prompt).toBe('## Refactor auth\n1. Extract helper');
    expect(s1.rev).toBe(2);
  });

  it('ExitPlanMode with no plan text falls back to a generic approval prompt', () => {
    const s0 = freshState({ phase: 'running', rev: 1 });
    const s1 = applyHook(s0, hook('PreToolUse', { tool_name: 'ExitPlanMode', tool_input: {} }), T0 + TICK);
    expect(s1.phase).toBe('awaiting-approval');
    expect(s1.pendingApproval?.kind).toBe('plan');
    expect(s1.pendingApproval?.prompt).toBe('Approve plan?');
  });

  it('a NON-human-input PreToolUse still goes to tool-running (working)', () => {
    // Guard against over-broad routing: only AskUserQuestion / ExitPlanMode are
    // "waiting on you". A Bash/Read/Edit PreToolUse is real work → spinner.
    const s0 = freshState({ phase: 'running', rev: 1 });
    const s1 = applyHook(s0, hook('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } }), T0 + TICK);
    expect(s1.phase).toBe('tool-running');
    expect(s1.lastTool?.name).toBe('Bash');
  });

  it('a non-human PreToolUse after a DENIED permission clears the stale approval', () => {
    // Deny path: a Notification parked us at awaiting-approval, the user denied,
    // and Claude moved straight to a DIFFERENT tool (no PostToolUse cleared the
    // approval). The tool-running transition must drop the now-dead pendingApproval
    // so it can't ride along as stale state into the working phase.
    const s0 = freshState({
      phase: 'awaiting-approval',
      rev: 5,
      pendingApproval: { kind: 'bash', prompt: 'Run `rm -rf build`?', requestedAt: T0 },
    });
    const s1 = applyHook(s0, hook('PreToolUse', { tool_name: 'Read', tool_input: { path: 'x' } }), T0 + TICK);
    expect(s1.phase).toBe('tool-running');
    expect(s1.lastTool?.name).toBe('Read');
    expect(s1.pendingApproval).toBeUndefined();
  });

  it('PostToolUse for AskUserQuestion (user answered) returns awaiting-approval → running', () => {
    const s0 = freshState({
      phase: 'awaiting-approval',
      rev: 2,
      pendingApproval: { kind: 'other', prompt: 'Which framework?', requestedAt: T0 },
    });
    const s1 = applyHook(s0, hook('PostToolUse', { tool_name: 'AskUserQuestion' }), T0 + TICK);
    expect(s1.phase).toBe('running');
    expect(s1.pendingApproval).toBeUndefined();
    expect(s1.lastTool).toBeUndefined();
    expect(s1.rev).toBe(3);
  });

  it('full AskUserQuestion cycle: running → awaiting-approval → running → awaiting-user on Stop', () => {
    let s = freshState({ phase: 'running', rev: 1 });
    s = applyHook(s, hook('PreToolUse', {
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ question: 'A or B?', options: [{ label: 'A' }, { label: 'B' }] }] },
    }), T0 + 100);
    expect(s.phase).toBe('awaiting-approval');
    s = applyHook(s, hook('PostToolUse', { tool_name: 'AskUserQuestion' }), T0 + 200);
    expect(s.phase).toBe('running');
    expect(s.pendingApproval).toBeUndefined();
    s = applyHook(s, hook('Stop'), T0 + 300);
    expect(s.phase).toBe('awaiting-user');
  });

  it('PostToolUse without prior PreToolUse defensively clears tool', () => {
    const s0 = freshState({ phase: 'running', rev: 1, lastTool: { name: 'Bash', startedAt: T0 } });
    const s1 = applyHook(s0, hook('PostToolUse'), T0 + TICK);
    expect(s1.phase).toBe('running');
    expect(s1.lastTool).toBeUndefined();
    expect(s1.rev).toBe(2);
  });

  it('Notification with permission_request enters awaiting-approval', () => {
    const s0 = freshState({ phase: 'running', rev: 1 });
    const s1 = applyHook(s0, hook('Notification', {
      permission_request: { kind: 'edit', prompt: 'Approve write to foo.ts?' },
    }), T0 + TICK);
    expect(s1.phase).toBe('awaiting-approval');
    expect(s1.pendingApproval).toEqual({
      kind: 'edit',
      prompt: 'Approve write to foo.ts?',
      requestedAt: T0 + TICK,
    });
    expect(s1.rev).toBe(2);
  });

  it('Notification with permission-like title detects approval', () => {
    const s0 = freshState({ phase: 'running', rev: 1 });
    const s1 = applyHook(s0, hook('Notification', { title: 'Permission required' }), T0 + TICK);
    expect(s1.phase).toBe('awaiting-approval');
    expect(s1.pendingApproval?.prompt).toBe('Permission required');
    // Without explicit kind or kind-hint in title, default is 'other'.
    expect(s1.pendingApproval?.kind).toBe('other');
  });

  it('Notification without approval signal updates last_hook_at only', () => {
    const s0 = freshState({ phase: 'running', rev: 1 });
    const s1 = applyHook(s0, hook('Notification', { message: 'Reminder: long-running task' }), T0 + TICK);
    expect(s1.phase).toBe('running');
    expect(s1.rev).toBe(1);
    expect(s1.lastHookAt).toBe(T0 + TICK);
  });

  it('UserPromptSubmit clears pending approval', () => {
    const s0 = freshState({
      phase: 'awaiting-approval',
      rev: 2,
      pendingApproval: { kind: 'edit', prompt: 'X', requestedAt: T0 },
    });
    const s1 = applyHook(s0, hook('UserPromptSubmit'), T0 + TICK);
    expect(s1.phase).toBe('running');
    expect(s1.pendingApproval).toBeUndefined();
    expect(s1.rev).toBe(3);
  });

  it('UserPromptSubmit clears a stale error when resuming after a failure', () => {
    const s0 = freshState({
      phase: 'error',
      rev: 4,
      error: { code: 'pty-crashed', message: 'PTY exited with code 137', failedAt: T0 },
    });
    const s1 = applyHook(s0, hook('UserPromptSubmit'), T0 + TICK);
    expect(s1.phase).toBe('running');
    expect(s1.error).toBeUndefined();
    expect(s1.rev).toBe(5);
  });

  it('UserPromptSubmit with no prior error does not bump rev for the error field alone', () => {
    // error:undefined in the delta must be a no-op when there was no error —
    // otherwise every prompt would churn rev. rev still bumps for the phase
    // change (running already? then it must be a true no-op).
    const s0 = freshState({ phase: 'running', rev: 9 });
    const s1 = applyHook(s0, hook('UserPromptSubmit'), T0 + TICK);
    // phase unchanged (running→running) AND no error to clear → identity no-op.
    expect(s1.phase).toBe('running');
    expect(s1.rev).toBe(9);
  });

  it('Stop transitions to awaiting-user', () => {
    const s0 = freshState({ phase: 'running', rev: 1 });
    const s1 = applyHook(s0, hook('Stop'), T0 + TICK);
    expect(s1.phase).toBe('awaiting-user');
    expect(s1.rev).toBe(2);
  });

  it('SessionEnd transitions to completed and clears transient state', () => {
    const s0 = freshState({
      phase: 'tool-running',
      rev: 5,
      lastTool: { name: 'Bash', startedAt: T0 },
      pendingApproval: { kind: 'edit', prompt: 'X', requestedAt: T0 },
    });
    const s1 = applyHook(s0, hook('SessionEnd'), T0 + TICK);
    expect(s1.phase).toBe('completed');
    expect(s1.lastTool).toBeUndefined();
    expect(s1.pendingApproval).toBeUndefined();
    expect(s1.rev).toBe(6);
  });

  it('SubagentStop is recorded but does not move phase', () => {
    const s0 = freshState({ phase: 'running', rev: 1 });
    const s1 = applyHook(s0, hook('SubagentStop'), T0 + TICK);
    expect(s1.phase).toBe('running');
    expect(s1.rev).toBe(1);
    expect(s1.lastHookAt).toBe(T0 + TICK);
  });

  it('SessionStart on existing session resets transient fields', () => {
    const s0 = freshState({
      phase: 'error',
      rev: 7,
      lastTool: { name: 'X', startedAt: T0 },
      error: { code: 'pty-crashed', message: 'x', failedAt: T0 },
    });
    const s1 = applyHook(s0, hook('SessionStart', { transcript_path: '/tmp/new.jsonl' }), T0 + TICK);
    expect(s1.phase).toBe('starting');
    expect(s1.lastTool).toBeUndefined();
    expect(s1.error).toBeUndefined();
    expect(s1.jsonlPath).toBe('/tmp/new.jsonl');
    expect(s1.rev).toBe(8);
  });

  it('unknown hook event is a no-op except for last_hook_at', () => {
    const s0 = freshState({ phase: 'running', rev: 1 });
    const s1 = applyHook(s0, { hook_event_name: 'NewExperimentalEvent' as any, session_id: 'cli-abc' }, T0 + TICK);
    expect(s1.phase).toBe('running');
    expect(s1.rev).toBe(1);
    expect(s1.lastHookAt).toBe(T0 + TICK);
  });

  it('re-applying the same hook is idempotent on phase (rev still bumps because we treat it as new event)', () => {
    // Idempotency at the *hook delivery* layer is handled by the dedup window
    // in the service layer. The pure state derivation always advances on a
    // genuine state change. Here we verify that a no-op hook (Stop applied
    // when already awaiting-user) does NOT bump rev.
    const s0 = freshState({ phase: 'awaiting-user', rev: 4 });
    const s1 = applyHook(s0, hook('Stop'), T0 + TICK);
    // Stop → awaiting-user transition is a no-op when already awaiting-user,
    // because no structural field changed. We DO still update last_hook_at,
    // but the rev should not advance.
    expect(s1.phase).toBe('awaiting-user');
    expect(s1.rev).toBe(4);
    expect(s1.lastHookAt).toBe(T0 + TICK);
  });
});

describe('turnStartedAt — il cronometro del TURNO, non dell\'ultima azione', () => {
  it('parte quando la sessione entra nel lavoro', () => {
    const s0 = freshState();
    expect(s0.turnStartedAt).toBeUndefined();
    const s1 = applyHook(s0, hook('UserPromptSubmit'), T0 + TICK);
    expect(s1.phase).toBe('running');
    expect(s1.turnStartedAt).toBe(T0 + TICK);
  });

  it('NON si riazzera a ogni tool: e il difetto che esiste per risolvere', () => {
    // Dentro un turno la fase rimbalza running ↔ tool-running a ogni tool, e
    // `phaseUpdatedAt` con lei. Chi voleva sapere «da quanto sta lavorando?»
    // leggeva quindi la durata dell'ULTIMA azione — «3s» su un turno di venti
    // minuti.
    const start = T0 + TICK;
    let s = applyHook(freshState(), hook('UserPromptSubmit'), start);
    s = applyHook(s, hook('PreToolUse', { tool_name: 'Bash', tool_input: {} }), start + 60_000);
    s = applyHook(s, hook('PostToolUse', { tool_name: 'Bash' }), start + 90_000);
    s = applyHook(s, hook('PreToolUse', { tool_name: 'Read', tool_input: {} }), start + 120_000);
    expect(s.turnStartedAt).toBe(start);
    // La prova che i due campi misurano cose diverse:
    expect(s.phaseUpdatedAt).toBe(start + 120_000);
  });

  it('un turno NUOVO ridata l\'inizio', () => {
    const primo = T0 + TICK;
    let s = applyHook(freshState(), hook('UserPromptSubmit'), primo);
    s = applyHook(s, hook('Stop'), primo + 300_000);
    expect(s.turnStartedAt).toBe(primo);
    const secondo = primo + 900_000;
    s = applyHook(s, hook('UserPromptSubmit'), secondo);
    expect(s.turnStartedAt).toBe(secondo);
  });

  it('a turno finito il valore resta: nessuno lo legge, e cancellarlo non serve', () => {
    const start = T0 + TICK;
    let s = applyHook(freshState(), hook('UserPromptSubmit'), start);
    s = applyHook(s, hook('Stop'), start + 120_000);
    expect(s.phase).toBe('awaiting-user');
    expect(s.turnStartedAt).toBe(start);
  });
});

describe('applyHook — Monitor lifecycle (watching phase + monitorArmed flag)', () => {
  it('MonitorArmed moves to watching and sets the armed flag', () => {
    const s0 = freshState({ phase: 'running', rev: 1, lastTool: { name: 'Bash', startedAt: T0 } });
    const s1 = applyHook(s0, hook('MonitorArmed'), T0 + TICK);
    expect(s1.phase).toBe('watching');
    expect(s1.monitorArmed).toBe(true);
    expect(s1.lastTool).toBeUndefined();
    expect(s1.rev).toBe(2);
  });

  it('Stop keeps the session in watching while a monitor is armed', () => {
    // The monitor is armed DURING the turn, then Stop fires. Without the flag,
    // Stop would clobber watching → awaiting-user (ring off). The flag guards it.
    let s = freshState({ phase: 'running', rev: 1 });
    s = applyHook(s, hook('MonitorArmed'), T0 + TICK);
    expect(s.phase).toBe('watching');
    s = applyHook(s, hook('Stop'), T0 + 2 * TICK);
    expect(s.phase).toBe('watching');
    expect(s.monitorArmed).toBe(true);
  });

  it('Stop ends in watching even when work continued after arming', () => {
    // Arm early, keep working (tool-running), then Stop → still watching.
    let s = freshState({ phase: 'running', rev: 1 });
    s = applyHook(s, hook('MonitorArmed'), T0 + TICK);
    s = applyHook(s, hook('PreToolUse', { tool_name: 'Bash' }), T0 + 2 * TICK);
    expect(s.phase).toBe('tool-running');
    expect(s.monitorArmed).toBe(true);
    s = applyHook(s, hook('Stop'), T0 + 3 * TICK);
    expect(s.phase).toBe('watching');
  });

  it('MonitorClosed from watching returns to awaiting-user and clears the flag', () => {
    let s = freshState({ phase: 'running', rev: 1 });
    s = applyHook(s, hook('MonitorArmed'), T0 + TICK);
    s = applyHook(s, hook('MonitorClosed'), T0 + 2 * TICK);
    expect(s.phase).toBe('awaiting-user');
    expect(s.monitorArmed).toBe(false);
  });

  it('MonitorClosed while live (already running) just drops the flag, keeps phase', () => {
    // The monitor fired and woke a turn (running) before closing — don't yank it
    // back to awaiting-user; only clear the armed flag.
    let s = freshState({ phase: 'watching', rev: 3, monitorArmed: true });
    s = applyHook(s, hook('UserPromptSubmit'), T0 + TICK); // woken → running
    expect(s.phase).toBe('running');
    expect(s.monitorArmed).toBe(true); // still armed across the woken turn
    s = applyHook(s, hook('MonitorClosed'), T0 + 2 * TICK);
    expect(s.phase).toBe('running');
    expect(s.monitorArmed).toBe(false);
  });

  it('MonitorArmed does not override awaiting-approval, but still arms the flag', () => {
    // A pending permission outranks a background watch: stay amber, but remember
    // the monitor so a later Stop parks in watching, not awaiting-user.
    const s0 = freshState({
      phase: 'awaiting-approval', rev: 2,
      pendingApproval: { kind: 'bash', prompt: 'run?', requestedAt: T0 },
    });
    const s1 = applyHook(s0, hook('MonitorArmed'), T0 + TICK);
    expect(s1.phase).toBe('awaiting-approval');
    expect(s1.monitorArmed).toBe(true);
    expect(s1.pendingApproval).toBeDefined();
  });

  it('SessionStart clears a stale armed flag', () => {
    const s0 = freshState({ phase: 'watching', rev: 5, monitorArmed: true });
    const s1 = applyHook(s0, hook('SessionStart'), T0 + TICK);
    expect(s1.phase).toBe('starting');
    expect(s1.monitorArmed).toBe(false);
  });
});

/**
 * LA SPIA ERA CABLATA A UN INTERRUTTORE STACCATO.
 *
 * Il blocco qui sopra prova la macchina di `watching` attraverso i due hook
 * `MonitorArmed`/`MonitorClosed` — che Claude Code NON EMETTE PIÙ: sul binario
 * 2.1.237 la lista degli eventi hook ne conta 31 e nessuno dei due c'è. Quei
 * test erano verdi e la fase, in produzione, non si accendeva mai: una chat che
 * sorvegliava un build si leggeva uguale a una che aveva smesso di rispondere.
 *
 * Il segnale che ARRIVA DAVVERO è il `PreToolUse` di `Monitor`. Questo blocco
 * pinna quella via, ed è la ragione per cui il vecchio resta: il giorno che i
 * due hook tornassero, entrambe le strade devono continuare a valere.
 */
describe('applyHook — un Monitor che parte arma l\'attesa (via PreToolUse)', () => {
  it('il PreToolUse di Monitor arma il flag, senza cambiare la fase', () => {
    // Il tool sta PARTENDO: la fase è `tool-running` come per ogni altro. La
    // differenza è che questo, finendo, lascia qualcosa dietro di sé.
    const s0 = freshState({ phase: 'running', rev: 1 });
    const s1 = applyHook(s0, hook('PreToolUse', { tool_name: 'Monitor' }), T0 + TICK);
    expect(s1.phase).toBe('tool-running');
    expect(s1.monitorArmed).toBe(true);
  });

  it('e allo Stop la chat resta in ascolto invece di sembrare finita', () => {
    // È tutto il punto: senza il flag, questo `Stop` direbbe `awaiting-user` —
    // «tocca a te» — mentre in realtà c'è un build sotto sorveglianza e la
    // risposta arriverà da sola.
    let s = freshState({ phase: 'running', rev: 1 });
    s = applyHook(s, hook('PreToolUse', { tool_name: 'Monitor' }), T0 + TICK);
    s = applyHook(s, hook('PostToolUse', { tool_name: 'Monitor' }), T0 + 2 * TICK);
    expect(s.phase).toBe('running');
    s = applyHook(s, hook('Stop'), T0 + 3 * TICK);
    expect(s.phase).toBe('watching');
    expect(s.monitorArmed).toBe(true);
  });

  it('un tool qualunque NON arma niente', () => {
    // La regola deve restare stretta: se `Bash` armasse un'attesa, ogni chat
    // finirebbe in `watching` per sempre — una spia sempre accesa non dice piu'
    // niente, esattamente come una che non si accende mai.
    const s = applyHook(freshState({ phase: 'running', rev: 1 }), hook('PreToolUse', { tool_name: 'Bash' }), T0 + TICK);
    expect(s.monitorArmed).toBeFalsy();
  });

  it('un secondo tool nello stesso turno non disarma il Monitor', () => {
    // L'agente arma la sorveglianza e poi continua a lavorare: quel lavoro non
    // ha spento niente.
    let s = freshState({ phase: 'running', rev: 1 });
    s = applyHook(s, hook('PreToolUse', { tool_name: 'Monitor' }), T0 + TICK);
    s = applyHook(s, hook('PreToolUse', { tool_name: 'Edit' }), T0 + 2 * TICK);
    expect(s.monitorArmed).toBe(true);
    s = applyHook(s, hook('Stop'), T0 + 3 * TICK);
    expect(s.phase).toBe('watching');
  });
});

describe('applyJsonlEvent — replay path', () => {
  it('user event moves to running', () => {
    const s0 = freshState({ phase: 'starting', rev: 0 });
    const s1 = applyJsonlEvent(s0, { type: 'user', raw: {} }, T0 + TICK);
    expect(s1.phase).toBe('running');
    expect(s1.rev).toBe(1);
  });

  it('tool_use event captures tool name', () => {
    const s0 = freshState({ phase: 'running', rev: 1 });
    const s1 = applyJsonlEvent(s0, { type: 'tool_use', name: 'Read', input: { path: 'x' }, raw: {} }, T0 + TICK);
    expect(s1.phase).toBe('tool-running');
    expect(s1.lastTool?.name).toBe('Read');
  });

  it('assistant event after tool_use promotes back to running', () => {
    const s0 = freshState({ phase: 'tool-running', rev: 2, lastTool: { name: 'Read', startedAt: T0 } });
    const s1 = applyJsonlEvent(s0, { type: 'assistant', raw: {} }, T0 + TICK);
    expect(s1.phase).toBe('running');
    expect(s1.lastTool).toBeUndefined();
  });

  it('does not undo a terminal phase', () => {
    const s0 = freshState({ phase: 'completed', rev: 9 });
    const s1 = applyJsonlEvent(s0, { type: 'user', raw: {} }, T0 + TICK);
    expect(s1).toBe(s0);
  });
});

describe('applyJsonlEvent — live tail semantics (wake-up + causal gate)', () => {
  it('a user event wakes a parked session (awaiting-user → running)', () => {
    // The Monitor / background-task / teammate wake-up: no hook fires for it,
    // the transcript's user line is the only signal.
    const s0 = freshState({ phase: 'awaiting-user', rev: 5, phaseUpdatedAt: T0 });
    const s1 = applyJsonlEvent(s0, { type: 'user', ts: T0 + TICK, raw: {} }, T0 + 2 * TICK);
    expect(s1.phase).toBe('running');
    expect(s1.rev).toBe(6);
  });

  it('an assistant event revives ANY resting phase (its user line may have been gated)', () => {
    for (const phase of ['awaiting-user', 'paused', 'dormant', 'starting'] as const) {
      const s0 = freshState({ phase, rev: 5, phaseUpdatedAt: T0 });
      const s1 = applyJsonlEvent(s0, { type: 'assistant', ts: T0 + TICK, raw: {} }, T0 + 2 * TICK);
      expect(s1.phase).toBe('running');
    }
  });

  it('an assistant event clears a stale pendingApproval when leaving paused', () => {
    const s0 = freshState({
      phase: 'paused', rev: 5, phaseUpdatedAt: T0,
      pendingApproval: { kind: 'bash', prompt: 'run ls?', requestedAt: T0 - TICK },
    });
    const s1 = applyJsonlEvent(s0, { type: 'assistant', ts: T0 + TICK, raw: {} }, T0 + 2 * TICK);
    expect(s1.phase).toBe('running');
    expect(s1.pendingApproval).toBeUndefined();
  });

  it('an assistant event while already running is a no-op for the phase machine', () => {
    const s0 = freshState({ phase: 'running', rev: 5, phaseUpdatedAt: T0 });
    const s1 = applyJsonlEvent(s0, { type: 'assistant', ts: T0 + TICK, raw: {} }, T0 + 2 * TICK);
    expect(s1.phase).toBe('running');
    expect(s1.rev).toBe(5); // no transition — rev untouched
  });

  it('CAUSAL GATE: a line older than the last phase change is stale news (Stop-race)', () => {
    // assistant line written at T1, Stop hook parked the session at T2 > T1,
    // the tail reads the line at T2+ε — applying it blind would wrongly revive.
    const s0 = freshState({ phase: 'awaiting-user', rev: 7, phaseUpdatedAt: T0 + 2 * TICK });
    const s1 = applyJsonlEvent(s0, { type: 'assistant', ts: T0 + TICK, raw: {} }, T0 + 3 * TICK);
    expect(s1).toBe(s0);
  });

  it('a line with the SAME timestamp as the phase change still applies (ms-collision)', () => {
    const s0 = freshState({ phase: 'awaiting-user', rev: 7, phaseUpdatedAt: T0 });
    const s1 = applyJsonlEvent(s0, { type: 'user', ts: T0, raw: {} }, T0 + TICK);
    expect(s1.phase).toBe('running');
  });

  it('a line with NO timestamp applies ungated (legacy boot-replay behaviour)', () => {
    const s0 = freshState({ phase: 'awaiting-user', rev: 7, phaseUpdatedAt: T0 + 2 * TICK });
    const s1 = applyJsonlEvent(s0, { type: 'user', raw: {} }, T0 + 3 * TICK);
    expect(s1.phase).toBe('running');
  });

  it('transitions stamp the EVENT time, so in-batch lines stay causally ordered', () => {
    const s0 = freshState({ phase: 'awaiting-user', rev: 5, phaseUpdatedAt: T0 });
    // One sweep reads three lines written at T+1, T+2, T+3 and applies them
    // all with the same wall-clock `now` — event-time stamping is what lets
    // each subsequent line pass the gate against its predecessor.
    const readAt = T0 + 10 * TICK;
    const s1 = applyJsonlEvent(s0, { type: 'user', ts: T0 + TICK, raw: {} }, readAt);
    const s2 = applyJsonlEvent(s1, { type: 'tool_use', name: 'Bash', ts: T0 + 2 * TICK, raw: {} }, readAt);
    const s3 = applyJsonlEvent(s2, { type: 'tool_result', ts: T0 + 3 * TICK, raw: {} }, readAt);
    expect(s1.phaseUpdatedAt).toBe(T0 + TICK);
    expect(s2.phase).toBe('tool-running');
    expect(s2.lastTool?.startedAt).toBe(T0 + 2 * TICK);
    expect(s3.phase).toBe('running');
    expect(s3.phaseUpdatedAt).toBe(T0 + 3 * TICK);
  });

  it('a meta event never moves the phase', () => {
    const s0 = freshState({ phase: 'awaiting-user', rev: 5, phaseUpdatedAt: T0 });
    const s1 = applyJsonlEvent(s0, { type: 'meta', ts: T0 + TICK, raw: {} }, T0 + 2 * TICK);
    expect(s1.phase).toBe('awaiting-user');
    expect(s1.rev).toBe(5);
  });
});

describe('applyJsonlEvent — human-input tools raise the amber, never the spinner', () => {
  it('an AskUserQuestion tool_use parks the session at awaiting-approval with the question as prompt', () => {
    const s0 = freshState({ phase: 'running', rev: 3, phaseUpdatedAt: T0 });
    const s1 = applyJsonlEvent(s0, {
      type: 'tool_use', name: 'AskUserQuestion', ts: T0 + TICK,
      input: { questions: [{ question: 'Quale approccio preferisci?' }] }, raw: {},
    }, T0 + 2 * TICK);
    expect(s1.phase).toBe('awaiting-approval');
    expect(s1.pendingApproval?.prompt).toBe('Quale approccio preferisci?');
    expect(s1.lastTool).toBeUndefined(); // waiting on the user, not running a tool
  });

  it('an ExitPlanMode tool_use parks at awaiting-approval with kind=plan', () => {
    const s0 = freshState({ phase: 'running', rev: 3, phaseUpdatedAt: T0 });
    const s1 = applyJsonlEvent(s0, {
      type: 'tool_use', name: 'ExitPlanMode', ts: T0 + TICK, input: { plan: 'Il piano.' }, raw: {},
    }, T0 + 2 * TICK);
    expect(s1.phase).toBe('awaiting-approval');
    expect(s1.pendingApproval?.kind).toBe('plan');
    expect(s1.pendingApproval?.prompt).toBe('Il piano.');
  });

  it('an assistant line never demotes awaiting-approval (same-message text-block trap)', () => {
    // The message that ASKED the question also carries text blocks whose lines
    // land with timestamps a breath after the PreToolUse hook — they must not
    // flip the amber "answer me" state back into a lying spinner.
    const s0 = freshState({
      phase: 'awaiting-approval', rev: 6, phaseUpdatedAt: T0,
      pendingApproval: { kind: 'other', prompt: 'Q?', requestedAt: T0 },
    });
    const s1 = applyJsonlEvent(s0, { type: 'assistant', ts: T0 + TICK, raw: {} }, T0 + 2 * TICK);
    expect(s1.phase).toBe('awaiting-approval');
    expect(s1.rev).toBe(6);
    expect(s1.pendingApproval?.prompt).toBe('Q?');
  });

  it('the answer’s tool_result resolves awaiting-approval back to running', () => {
    const s0 = freshState({
      phase: 'awaiting-approval', rev: 6, phaseUpdatedAt: T0,
      pendingApproval: { kind: 'other', prompt: 'Q?', requestedAt: T0 },
    });
    const s1 = applyJsonlEvent(s0, { type: 'tool_result', ts: T0 + TICK, raw: {} }, T0 + 2 * TICK);
    expect(s1.phase).toBe('running');
    expect(s1.pendingApproval).toBeUndefined();
  });

  it('end-to-end through parseJsonlLine: the real assistant line shape raises the amber', () => {
    const line = JSON.stringify({
      type: 'assistant', timestamp: new Date(T0 + TICK).toISOString(),
      message: { content: [{ type: 'tool_use', name: 'AskUserQuestion', input: { questions: [{ question: 'Procedo?' }] } }] },
    });
    const ev = parseJsonlLine(line)!;
    const s0 = freshState({ phase: 'running', rev: 3, phaseUpdatedAt: T0 });
    const s1 = applyJsonlEvent(s0, ev, T0 + 2 * TICK);
    expect(s1.phase).toBe('awaiting-approval');
    expect(s1.pendingApproval?.prompt).toBe('Procedo?');
  });
});

describe('parseJsonlLine — real transcript shapes (ground-truthed 2026-07-12)', () => {
  const TS = '2026-07-11T18:51:27.237Z';
  const TS_MS = Date.parse(TS);

  it('extracts the line timestamp as epoch ms', () => {
    const ev = parseJsonlLine(JSON.stringify({
      type: 'assistant', timestamp: TS, message: { content: [{ type: 'text', text: 'ok' }] },
    }))!;
    expect(ev.type).toBe('assistant');
    expect(ev.ts).toBe(TS_MS);
  });

  it('a typed human prompt is a wake-capable user event', () => {
    const ev = parseJsonlLine(JSON.stringify({
      type: 'user', timestamp: TS, promptSource: 'typed', origin: { kind: 'human' },
      message: { role: 'user', content: 'riesci a vedere la chat?' },
    }))!;
    expect(ev.type).toBe('user');
  });

  it('a Monitor task-notification is a wake-capable user event', () => {
    const ev = parseJsonlLine(JSON.stringify({
      type: 'user', timestamp: TS, promptSource: 'system', origin: { kind: 'task-notification' },
      message: { role: 'user', content: '<task-notification>\n<task-id>abc123</task-id>\n…' },
    }))!;
    expect(ev.type).toBe('user');
  });

  it('isMeta lines are meta (never a turn)', () => {
    const ev = parseJsonlLine(JSON.stringify({
      type: 'user', timestamp: TS, isMeta: true,
      message: { role: 'user', content: 'A session-scoped Stop hook is now active…' },
    }))!;
    expect(ev.type).toBe('meta');
  });

  it('a compact summary is meta', () => {
    const ev = parseJsonlLine(JSON.stringify({
      type: 'user', timestamp: TS, isCompactSummary: true,
      message: { role: 'user', content: 'This session is being continued from a previous conversation…' },
    }))!;
    expect(ev.type).toBe('meta');
  });

  it('a local slash-command echo is meta (no model turn follows)', () => {
    const ev = parseJsonlLine(JSON.stringify({
      type: 'user', timestamp: TS,
      message: { role: 'user', content: '<command-name>/compact</command-name>\n<command-message>compact</command-message>' },
    }))!;
    expect(ev.type).toBe('meta');
  });

  it('a local-command caveat is meta', () => {
    const ev = parseJsonlLine(JSON.stringify({
      type: 'user', timestamp: TS, isMeta: true,
      message: { role: 'user', content: '<local-command-caveat>Caveat: the messages below…</local-command-caveat>' },
    }))!;
    expect(ev.type).toBe('meta');
  });

  it('an interrupt marker is meta (user STOPPING a turn, not starting one)', () => {
    const ev = parseJsonlLine(JSON.stringify({
      type: 'user', timestamp: TS,
      message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] },
    }))!;
    expect(ev.type).toBe('meta');
  });

  it('tool_result classification wins over meta checks', () => {
    const ev = parseJsonlLine(JSON.stringify({
      type: 'user', timestamp: TS,
      message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] },
    }))!;
    expect(ev.type).toBe('tool_result');
  });
});

describe('deriveTranscriptPath', () => {
  it('encodes every non-alphanumeric character as a dash', () => {
    expect(deriveTranscriptPath('/Users/z', '/Users/z/Projects/topics-app', 'sid-1'))
      .toBe('/Users/z/.claude/projects/-Users-z-Projects-topics-app/sid-1.jsonl');
    // Dots too — verified against real dirs (.claude → -claude, double dash).
    expect(deriveTranscriptPath('/Users/z', '/Users/z/.claude/jarvis', 'sid-2'))
      .toBe('/Users/z/.claude/projects/-Users-z--claude-jarvis/sid-2.jsonl');
  });
});

describe('reapStaleSession', () => {
  it('demotes tool-running stuck for >10 min to running', () => {
    const s0 = freshState({ phase: 'tool-running', rev: 3, phaseUpdatedAt: T0, lastTool: { name: 'X', startedAt: T0 } });
    const s1 = reapStaleSession(s0, T0 + 11 * 60 * 1000);
    expect(s1.phase).toBe('running');
    expect(s1.lastTool).toBeUndefined();
    expect(s1.rev).toBe(4);
  });

  it('leaves recent tool-running alone', () => {
    const s0 = freshState({ phase: 'tool-running', rev: 3, phaseUpdatedAt: T0 });
    const s1 = reapStaleSession(s0, T0 + 9 * 60 * 1000);
    expect(s1).toBe(s0);
  });

  it('demotes awaiting-approval >10min to paused but keeps pendingApproval', () => {
    const s0 = freshState({
      phase: 'awaiting-approval',
      rev: 3,
      phaseUpdatedAt: T0,
      pendingApproval: { kind: 'plan', prompt: 'Approve plan?', requestedAt: T0 },
    });
    const s1 = reapStaleSession(s0, T0 + 11 * 60 * 1000);
    expect(s1.phase).toBe('paused');
    expect(s1.pendingApproval).toEqual(s0.pendingApproval);
  });

  it('errors out a starting session that never produced an event', () => {
    const s0 = freshState({ phase: 'starting', phaseUpdatedAt: T0 });
    const s1 = reapStaleSession(s0, T0 + 6 * 60 * 1000);
    expect(s1.phase).toBe('error');
    expect(s1.error?.code).toBe('start-timeout');
  });

  it('demotes a running session whose PTY has been idle >10min to dormant', () => {
    const s0 = freshState({ phase: 'running', rev: 3, phaseUpdatedAt: T0, lastTool: { name: 'X', startedAt: T0 } });
    // ptyIdleMs over the threshold → genuinely stuck (missed Stop hook).
    const s1 = reapStaleSession(s0, T0 + 30 * 60 * 1000, undefined, 11 * 60 * 1000);
    expect(s1.phase).toBe('dormant');
    expect(s1.lastTool).toBeUndefined();
    expect(s1.rev).toBe(4);
  });

  it('NEVER reaps a running session whose PTY is still busy, however old the phase', () => {
    // age is huge (a long turn) but the PTY is active → real work, leave it.
    const s0 = freshState({ phase: 'running', rev: 3, phaseUpdatedAt: T0 });
    const s1 = reapStaleSession(s0, T0 + 60 * 60 * 1000, undefined, 0);
    expect(s1).toBe(s0);
  });

  it('leaves a no-PTY-signal running session alone while updatedAt is inside the abandoned window', () => {
    // updatedAt moving = hooks/transcript lines still landing = alive. A long
    // turn keeps advancing updatedAt, so it never trips the abandoned rule.
    const s0 = freshState({ phase: 'running', rev: 3, phaseUpdatedAt: T0, updatedAt: T0 + 59 * 60 * 1000 });
    const s1 = reapStaleSession(s0, T0 + 60 * 60 * 1000, undefined, null);
    expect(s1).toBe(s0);
    // omitting the arg entirely behaves the same (defaults to null).
    expect(reapStaleSession(s0, T0 + 60 * 60 * 1000)).toBe(s0);
  });

  it('demotes an ABANDONED running session (no PTY signal, updatedAt frozen past the window) to dormant', () => {
    // The stuck-forever bug: a headless task / chat session whose process died
    // (or whose Stop hook was missed with no PTY to consult) claimed `running`
    // for days. No hook and no transcript line has advanced updatedAt for the
    // whole abandoned window → corpse, not work.
    const s0 = freshState({ phase: 'running', rev: 3, phaseUpdatedAt: T0, updatedAt: T0, lastTool: { name: 'X', startedAt: T0 } });
    const s1 = reapStaleSession(s0, T0 + 60 * 60 * 1000, undefined, null);
    expect(s1.phase).toBe('dormant');
    expect(s1.lastTool).toBeUndefined();
    expect(s1.rev).toBe(4);
  });

  it('abandoned rule only applies when the PTY signal is absent — a briefly-idle PTY wins', () => {
    // ptyIdleMs present and under runningTimeoutMs → the PTY is the honest
    // signal and says "recently alive", regardless of how old updatedAt is.
    const s0 = freshState({ phase: 'running', rev: 3, phaseUpdatedAt: T0, updatedAt: T0 });
    const s1 = reapStaleSession(s0, T0 + 24 * 60 * 60 * 1000, undefined, 9 * 60 * 1000);
    expect(s1).toBe(s0);
  });

  it('leaves a running session with brief PTY idleness alone', () => {
    const s0 = freshState({ phase: 'running', rev: 3, phaseUpdatedAt: T0 });
    const s1 = reapStaleSession(s0, T0 + 30 * 60 * 1000, undefined, 9 * 60 * 1000);
    expect(s1).toBe(s0);
  });
});

describe('reviveOnPtyActivity', () => {
  it('revives a dormant session back to running', () => {
    const s0 = freshState({ phase: 'dormant', rev: 5 });
    const s1 = reviveOnPtyActivity(s0, T0 + TICK);
    expect(s1.phase).toBe('running');
    expect(s1.rev).toBe(6);
  });

  it('is a no-op for any non-dormant phase (does not clobber awaiting-user)', () => {
    for (const phase of ['running', 'tool-running', 'awaiting-user', 'awaiting-approval', 'paused', 'completed', 'error'] as const) {
      const s0 = freshState({ phase, rev: 5 });
      expect(reviveOnPtyActivity(s0, T0 + TICK)).toBe(s0);
    }
  });
});

describe('markPtyCrash / markDormant', () => {
  it('markPtyCrash transitions active session to error with code', () => {
    const s0 = freshState({ phase: 'running', rev: 4 });
    const s1 = markPtyCrash(s0, 137, T0 + TICK);
    expect(s1.phase).toBe('error');
    expect(s1.error?.code).toBe('pty-crashed');
    expect(s1.error?.message).toContain('137');
    expect(s1.rev).toBe(5);
  });

  it('markPtyCrash is a no-op on a completed session', () => {
    const s0 = freshState({ phase: 'completed', rev: 9 });
    const s1 = markPtyCrash(s0, 1, T0 + TICK);
    expect(s1).toBe(s0);
  });

  it('markDormant moves active session to dormant', () => {
    const s0 = freshState({ phase: 'awaiting-user', rev: 4 });
    const s1 = markDormant(s0, T0 + TICK);
    expect(s1.phase).toBe('dormant');
    expect(s1.rev).toBe(5);
  });
});

describe('parseJsonlLine', () => {
  it('parses an assistant text message as assistant', () => {
    const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } });
    expect(parseJsonlLine(line)).toEqual({ type: 'assistant', raw: JSON.parse(line) });
  });

  it('parses an assistant tool_use as tool_use with name + input', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] },
    });
    const parsed = parseJsonlLine(line)!;
    expect(parsed.type).toBe('tool_use');
    if (parsed.type === 'tool_use') {
      expect(parsed.name).toBe('Bash');
      expect(parsed.input).toEqual({ command: 'ls' });
    }
  });

  it('parses a user tool_result block as tool_result', () => {
    const line = JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'abc', content: 'output' }] },
    });
    expect(parseJsonlLine(line)?.type).toBe('tool_result');
  });

  it('returns null on empty / whitespace lines', () => {
    expect(parseJsonlLine('')).toBeNull();
    expect(parseJsonlLine('   ')).toBeNull();
  });

  it('tolerates malformed JSON without throwing', () => {
    const ev = parseJsonlLine('{not json');
    expect(ev?.type).toBe('other');
  });

  it('falls back to "other" for unknown top-level types', () => {
    const line = JSON.stringify({ type: 'something-new', payload: {} });
    expect(parseJsonlLine(line)?.type).toBe('other');
  });
});

describe('splitJsonlChunk', () => {
  it('splits complete lines and preserves the partial last line', () => {
    const { lines, remainder } = splitJsonlChunk('{"a":1}\n{"b":2}\n{"c":');
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
    expect(remainder).toBe('{"c":');
  });

  it('returns no lines when there is no newline', () => {
    const { lines, remainder } = splitJsonlChunk('{"partial');
    expect(lines).toEqual([]);
    expect(remainder).toBe('{"partial');
  });

  it('handles trailing newline as empty remainder', () => {
    const { lines, remainder } = splitJsonlChunk('{"a":1}\n');
    expect(lines).toEqual(['{"a":1}']);
    expect(remainder).toBe('');
  });

  it('ignores blank lines between events', () => {
    const { lines } = splitJsonlChunk('{"a":1}\n\n{"b":2}\n');
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });
});

describe('isBusySpinnerPhase — the boot-reconcile predicate', () => {
  it('is true for exactly the "working" spinner phases', () => {
    expect(isBusySpinnerPhase('starting')).toBe(true);
    expect(isBusySpinnerPhase('running')).toBe(true);
    expect(isBusySpinnerPhase('tool-running')).toBe(true);
  });

  it('is false for resting/attention/terminal phases (never demote a real "your turn")', () => {
    expect(isBusySpinnerPhase('awaiting-user')).toBe(false);
    expect(isBusySpinnerPhase('awaiting-approval')).toBe(false);
    expect(isBusySpinnerPhase('paused')).toBe(false);
    expect(isBusySpinnerPhase('completed')).toBe(false);
    expect(isBusySpinnerPhase('error')).toBe(false);
    expect(isBusySpinnerPhase('dormant')).toBe(false);
  });

  it('BUSY_SPINNER_PHASES and isBusySpinnerPhase agree across every phase', () => {
    const set = new Set<ClaudeSessionPhase>(BUSY_SPINNER_PHASES);
    for (const p of ALL_PHASES) {
      expect(isBusySpinnerPhase(p)).toBe(set.has(p));
    }
  });

  it('a phantom running session (frozen updatedAt, no PTY) is a busy-spinner phase → boot reconcile targets it', () => {
    // Mirrors the outage repro: a chat session (ptyIdleMs=null) stuck on running.
    // reapStaleSession only clears it after abandonedTimeoutMs; the boot reconcile
    // keys off this predicate to demote it immediately once the broker confirms
    // the child is dead.
    const phantom = freshState({ phase: 'running', updatedAt: T0, phaseUpdatedAt: T0 });
    expect(isBusySpinnerPhase(phantom.phase)).toBe(true);
    // markDormant is the transition the reconcile applies via noteDormant.
    const demoted = markDormant(phantom, T0 + 60 * 60_000);
    expect(demoted.phase).toBe('dormant');
    expect(isBusySpinnerPhase(demoted.phase)).toBe(false);
  });
});

describe('end-to-end scenario', () => {
  it('full session lifecycle hits the expected phases and rev sequence', () => {
    let s = makeInitialState('cli-1', 'topic-1', T0);
    expect(s.phase).toBe('starting');
    expect(s.rev).toBe(0);

    s = applyHook(s, hook('SessionStart', { transcript_path: '/tmp/x.jsonl' }), T0 + 10);
    expect(s.phase).toBe('starting');
    expect(s.jsonlPath).toBe('/tmp/x.jsonl');
    expect(s.rev).toBe(1); // SessionStart updated jsonlPath → rev bumped

    s = applyHook(s, hook('UserPromptSubmit'), T0 + 100);
    expect(s.phase).toBe('running');
    expect(s.rev).toBe(2);

    s = applyHook(s, hook('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } }), T0 + 200);
    expect(s.phase).toBe('tool-running');
    expect(s.rev).toBe(3);

    s = applyHook(s, hook('PostToolUse', { tool_name: 'Bash' }), T0 + 300);
    expect(s.phase).toBe('running');
    expect(s.rev).toBe(4);

    s = applyHook(s, hook('Notification', { permission_request: { kind: 'edit', prompt: 'OK?' } }), T0 + 400);
    expect(s.phase).toBe('awaiting-approval');
    expect(s.pendingApproval?.kind).toBe('edit');
    expect(s.rev).toBe(5);

    s = applyHook(s, hook('UserPromptSubmit'), T0 + 500);
    expect(s.phase).toBe('running');
    expect(s.pendingApproval).toBeUndefined();
    expect(s.rev).toBe(6);

    s = applyHook(s, hook('Stop'), T0 + 600);
    expect(s.phase).toBe('awaiting-user');
    expect(s.rev).toBe(7);

    s = applyHook(s, hook('SessionEnd'), T0 + 700);
    expect(s.phase).toBe('completed');
    expect(s.rev).toBe(8);
  });
});

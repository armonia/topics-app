/**
 * The two ways a bubble is emptied without becoming a second bubble.
 *
 * Both exist because the id on the wire can name a row this window already
 * has: a reattach after a restart (still open) and a spontaneous turn picking
 * up the «no answer» headstone (already closed). Getting either wrong shows
 * the same thing on screen — the same turn twice.
 */
import { describe, it, expect } from 'bun:test';
import { clearPartialForReattach, reviveClosedBubble } from './streamReattachReset';
import type { ChatMessage } from '../types';

const msg = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 'm1', role: 'assistant', content: 'testo', timestamp: '2026-08-21T10:51:11.448Z', ...over,
} as ChatMessage);

describe('reviveClosedBubble', () => {
  const notice = msg({ id: 'lapide', content: '⚠️ Nessuna risposta: …', partial: false, blocks: [{ kind: 'error', text: 'x' }] } as Partial<ChatMessage>);

  it('reopens the closed bubble in place, keeping its id and its position', () => {
    const thread = [msg({ id: 'u1', role: 'user', content: 'procedi' }), notice, msg({ id: 'dopo', content: 'coda' })];
    const out = reviveClosedBubble(thread, 'lapide');
    expect(out).not.toBe(thread);
    expect(out.length).toBe(3);
    expect(out[1].id).toBe('lapide');
    expect(out[1].content).toBe('');
    expect(out[1].partial).toBe(true);
    expect(out[1].blocks).toBeUndefined();
    // The neighbours are untouched: it is one turn coming back to life, not a
    // thread being rebuilt.
    expect(out[0]).toBe(thread[0]);
    expect(out[2]).toBe(thread[2]);
  });

  it('an unknown id changes nothing, and returns the SAME array', () => {
    const thread = [notice];
    expect(reviveClosedBubble(thread, 'altro')).toBe(thread);
    expect(reviveClosedBubble(thread, '')).toBe(thread);
  });

  it('a bubble still streaming is left to the reattach path', () => {
    const thread = [msg({ id: 'viva', partial: true })];
    expect(reviveClosedBubble(thread, 'viva')).toBe(thread);
  });

  it('a message of the human is never reopened', () => {
    const thread = [msg({ id: 'u1', role: 'user', partial: false })];
    expect(reviveClosedBubble(thread, 'u1')).toBe(thread);
  });
});

describe('clearPartialForReattach', () => {
  it('empties the live bubble and leaves an already empty one alone', () => {
    const pieno = [msg({ partial: true, content: 'meta turno' })];
    expect(clearPartialForReattach(pieno)[0].content).toBe('');
    const vuoto = [msg({ partial: true, content: '' })];
    expect(clearPartialForReattach(vuoto)).toBe(vuoto);
  });
});

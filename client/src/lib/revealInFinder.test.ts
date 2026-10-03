/**
 * "Show in Finder" only where the Finder that opens is in front of whoever
 * clicked: the desktop shell on a loopback server.
 *
 * @covers FILE-03
 */
import { describe, expect, test } from 'bun:test';
import { revealOffered } from './revealInFinder';

describe('revealOffered', () => {
  test('the desktop shell on the same machine offers it', () => {
    expect(revealOffered('tauri', 'http://127.0.0.1:13333')).toBe(true);
    expect(revealOffered('tauri', 'http://localhost:3333')).toBe(true);
  });

  test('a web client (phone, other computer, LAN) does not: the server would open Finder on its own Mac', () => {
    expect(revealOffered('web', '')).toBe(false);
    expect(revealOffered('web', 'https://192.168.1.2:3333')).toBe(false);
  });

  test('a desktop shell reaching a server elsewhere does not', () => {
    expect(revealOffered('tauri', 'https://192.168.1.2:3333')).toBe(false);
    expect(revealOffered('tauri', 'not a url')).toBe(false);
  });
});

/**
 * The System pane opens beside the work, toggles from the strip, and "open
 * full view" widens the same pane instead of opening another one.
 * @covers HUBBR-05
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { _readSystemPaneForTests, closeSystemPane, openSystemPane, toggleSystemPane, toggleSystemPaneMaximized } from './systemPane';

afterEach(() => closeSystemPane());

describe('HUBBR-05: the System pane state', () => {
  test('opens beside the work, not maximized', () => {
    openSystemPane();
    expect(_readSystemPaneForTests()).toEqual({ open: true, maximized: false });
  });

  test('the strip toggles it', () => {
    toggleSystemPane();
    expect(_readSystemPaneForTests().open).toBe(true);
    toggleSystemPane();
    expect(_readSystemPaneForTests()).toEqual({ open: false, maximized: false });
  });

  test('open full view widens the same pane and comes back; a second open keeps the size', () => {
    openSystemPane();
    toggleSystemPaneMaximized();
    expect(_readSystemPaneForTests()).toEqual({ open: true, maximized: true });
    openSystemPane();
    expect(_readSystemPaneForTests().maximized).toBe(true);
    toggleSystemPaneMaximized();
    expect(_readSystemPaneForTests()).toEqual({ open: true, maximized: false });
  });

  test('closing forgets the size, so the next open is beside the work again', () => {
    openSystemPane();
    toggleSystemPaneMaximized();
    closeSystemPane();
    openSystemPane();
    expect(_readSystemPaneForTests()).toEqual({ open: true, maximized: false });
  });
});

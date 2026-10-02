/**
 * THE STEPPER: a number you move one step at a time, as a spinbutton.
 *
 * It replaces two sliders whose value was only readable in a label above them
 * (font size, chat width). Arrow up and down move one step, Page Up and Page
 * Down four, Home and End go to the ends, and the value never leaves its range.
 *
 * @covers USERMENU-07
 * @covers USERMENU-08
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { Stepper } from './Stepper';
import { stepperValue } from './controlKeys';

const RANGE = { min: 12, max: 18, step: 1 };

describe('Stepper', () => {
  test('a spinbutton that says its value, its range and its text', () => {
    const html = renderToStaticMarkup(
      <Stepper value={13} {...RANGE} onChange={() => {}} ariaLabel="Text size" format={(v) => `${v} px`} testId="st" />,
    );
    expect(html).toContain('role="spinbutton"');
    expect(html).toContain('aria-valuenow="13"');
    expect(html).toContain('aria-valuemin="12"');
    expect(html).toContain('aria-valuemax="18"');
    expect(html).toContain('aria-valuetext="13 px"');
    expect(html).toContain('aria-label="Text size"');
    expect(html).toContain('tabindex="0"');
  });

  test('the two buttons are not tab stops and are disabled at the ends', () => {
    const atMin = renderToStaticMarkup(<Stepper value={12} {...RANGE} onChange={() => {}} ariaLabel="x" testId="st" />);
    expect(atMin).toMatch(/data-testid="st-down"[^>]*disabled=""|disabled=""[^>]*data-testid="st-down"/);
    expect(atMin.match(/tabindex="-1"/g)?.length).toBe(2);
  });

  test('keys move by one step, pages by four, and the value stays in range', () => {
    expect(stepperValue('ArrowUp', 13, RANGE)).toBe(14);
    expect(stepperValue('ArrowDown', 13, RANGE)).toBe(12);
    expect(stepperValue('ArrowDown', 12, RANGE)).toBe(12);
    expect(stepperValue('PageUp', 13, RANGE)).toBe(17);
    expect(stepperValue('PageUp', 16, RANGE)).toBe(18);
    expect(stepperValue('PageDown', 13, RANGE)).toBe(12);
    expect(stepperValue('Home', 15, RANGE)).toBe(12);
    expect(stepperValue('End', 15, RANGE)).toBe(18);
    expect(stepperValue('ArrowLeft', 15, RANGE)).toBeNull();
    expect(stepperValue('PageUp', 600, { min: 600, max: 1320, step: 20 })).toBe(680);
  });

  test('no duration written by hand', () => {
    const source = readFileSync(join(import.meta.dir, 'Stepper.tsx'), 'utf8');
    expect(source).not.toMatch(/\d+ms|duration-\d|cubic-bezier/);
  });
});

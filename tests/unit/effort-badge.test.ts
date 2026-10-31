/**
 * @covers COMPOSER-BAR-01
 * The effort chip is never conditional on a known tier: the chat bar and the
 * drawer composer both mount EffortBadge unconditionally, and the badge falls
 * back to "auto" through effortBadgeLabel (card 067a1f5b). Source-level checks,
 * like the other component tests here, because the unit tier has no DOM.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

describe("effort chip is always rendered", () => {
  const badge = read("client/src/components/Chat/EffortBadge.tsx");
  const popover = read("client/src/components/Chat/SessionConfigPopover.tsx");
  const drawer = read("client/src/components/Board/TaskDetail.tsx");

  test("badge text goes through the auto fallback and has no early return", () => {
    expect(badge).toContain("{effortBadgeLabel(tier)}");
    expect(badge).not.toMatch(/return null|tier \?|tier &&/);
  });
  test("chat bar mounts the badge with no tier condition", () => {
    expect(popover).toContain("<EffortBadge tier={shownTier}");
    expect(popover).not.toMatch(/shownTier\s*(\?|&&)/);
  });
  test("drawer composer mounts the badge under the field, always", () => {
    expect(drawer).toContain('testId="task-composer-effort-badge"');
    expect(drawer).not.toMatch(/task\.effort\s*(\?|&&)\s*<EffortBadge/);
  });
});

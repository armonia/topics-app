/**
 * @covers COMPOSER-BAR-01
 * The effort chip is never conditional on a known tier: mounted with no tier it
 * must render "auto" (card 067a1f5b). Rendered for real, not read as source, so
 * any rewrite of the early-return kind turns it red. The drawer and the chat
 * resolve the shown tier through the same function.
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { EffortBadge } from "./EffortBadge";
import { resolveShownEffortTier } from "../../lib/effortTiers";

const entries = [
  { name: "claude-code", status: "ready", isDefault: true, models: ["m"], defaultModel: "m", effortTier: "xhigh" },
  { name: "auto-less", status: "ready", isDefault: false, models: ["m"], defaultModel: "m", effortTier: null },
] as never[];

describe("effort chip is always rendered", () => {
  test("no tier renders AUTO", () => {
    const html = renderToStaticMarkup(<EffortBadge tier={null} overridden={false} />);
    expect(html).toContain('data-testid="session-effort-badge"');
    expect(html).toContain(">auto<");
  });
  test("a tier renders as is", () => {
    const html = renderToStaticMarkup(<EffortBadge tier="high" overridden />);
    expect(html).toContain(">high<");
  });
  test("topic without override on an xhigh provider reads xhigh, same as the chat", () => {
    expect(resolveShownEffortTier(entries, null, null, "claude-code")).toBe("xhigh");
    expect(resolveShownEffortTier(entries, "low", null, "claude-code")).toBe("low");
    expect(resolveShownEffortTier(entries, null, null, "auto-less")).toBeNull();
  });
});

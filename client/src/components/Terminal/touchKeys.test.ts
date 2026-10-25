/**
 * @covers TERM-14
 *
 * The touch toolbar must not offer Ctrl+Z on Claude sessions: one tap
 * would freeze the pane for good. Shells keep it for job control.
 */
import { afterAll, describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TopicsProvider } from "../../contexts/TopicsContext";
import type { TerminalSessionInfo } from "../../types";
import { touchKeysForSession } from "./touchKeys";

// Ctrl+Z, built without a literal control byte in source.
const SUSPEND = String.fromCharCode(26);

// Capture the full modules before swapping exports; Bun keeps module mocks process-wide.
const {
  OPEN_TAB_EVENT,
  isExternalLinkGesture,
  resetOpenLinkDedupeForTest,
  openLink,
} = await import("../../lib/openLink");
const realOpenLink = {
  OPEN_TAB_EVENT,
  isExternalLinkGesture,
  resetOpenLinkDedupeForTest,
  openLink,
};

const {
  SELECTED_SURFACE,
  SELECTED_SURFACE_SOFT,
  TAB_RESTING_SURFACE,
  TAB_SELECTED_SURFACE,
  TAB_SELECTED_SURFACE_SOFT,
  RESTING_FILL_MOBILE,
  RESTING_SURFACE,
  RAISED_CONTROL,
  GLYPH_KBD_PADDING,
  SIDEBAR_HOVER,
  SIDEBAR_ACTIVE,
  TIER_DONE_BG,
  TIER_INPUT_BG,
  TIER_ERROR_BG,
  AWAITING_INPUT_SURFACE,
  DONE_UNSEEN_SURFACE,
  ERROR_UNSEEN_SURFACE,
  attentionSurface,
  ON_FILL_TEXT,
  ON_FILL_TEXT_SOFT,
  ROW_PX,
  ROW_GAP,
  TAB_LABEL_TYPE,
  TAB_LABEL,
  ROW_INSET,
  SIDEBAR_SCROLL_TOP_PROPERTY,
  SIDEBAR_SCROLL_BOTTOM_PROPERTY,
  BAND_OWN_PROPERTY,
  MOBILE_SIDEBAR_HEADER_H,
  MOBILE_SIDEBAR_HEADER_H_COMPACT,
  BAR_LABEL_TOP,
  IDENTITY_GLYPH_BOX,
  IDENTITY_GLYPH_INK,
  COLUMN_GAP,
  TAB_GAP_CLASS,
  ROW_H,
  CARD_H,
  SECTION_H,
  SECTION_CARD,
  SIDEBAR_INDENT_STEP,
  ROW_LEAD_TIGHTEN,
  ROW_GLYPH,
  ROW_GLYPH_SLOT,
  SIDEBAR_LABEL_GUTTER_MAX,
  SIDEBAR_LABEL_GUTTER_BARE_MAX,
  ROW_CHEVRON,
  ROW_CHEVRON_SLOT_BARE,
  ROW_CHEVRON_SLOT,
  ROW_ACTION_BOX,
  CHROME_ROW_CONTENT_H,
  chromeRowInset,
  ROW_ACTION_BOX_PX,
  CHROME_ROW_ACTION_INSET,
  CHROME_ROW_ACTION_INSET_LEFT,
  CHROME_ROW_ACTION_RESERVE,
  CHROME_ROW_ACTION_RESERVE_LEFT,
  CHROME_BAR,
  CHROME_BAR_H,
  CHROME_BAR_H_VAR,
  CHROME_ROW_SUB_H,
  CHROME_BAR_SUB,
  CHROME_BAR_SUB_H_CLASS,
  CHROME_BAR_CONSUMED,
  ROW_ACTION_GLYPH,
  ROW_CARD,
  ROW_TRAIL,
  ROW_ACTIONS,
  ROW_ACTIONS_INSET_PX,
  ARCHIVED_ROW,
  TREE_ROW_CARD,
  sidebarRowCard,
} = await import("../../lib/selectionStyles");
const realSelectionStyles = {
  SELECTED_SURFACE,
  SELECTED_SURFACE_SOFT,
  TAB_RESTING_SURFACE,
  TAB_SELECTED_SURFACE,
  TAB_SELECTED_SURFACE_SOFT,
  RESTING_FILL_MOBILE,
  RESTING_SURFACE,
  RAISED_CONTROL,
  GLYPH_KBD_PADDING,
  SIDEBAR_HOVER,
  SIDEBAR_ACTIVE,
  TIER_DONE_BG,
  TIER_INPUT_BG,
  TIER_ERROR_BG,
  AWAITING_INPUT_SURFACE,
  DONE_UNSEEN_SURFACE,
  ERROR_UNSEEN_SURFACE,
  attentionSurface,
  ON_FILL_TEXT,
  ON_FILL_TEXT_SOFT,
  ROW_PX,
  ROW_GAP,
  TAB_LABEL_TYPE,
  TAB_LABEL,
  ROW_INSET,
  SIDEBAR_SCROLL_TOP_PROPERTY,
  SIDEBAR_SCROLL_BOTTOM_PROPERTY,
  BAND_OWN_PROPERTY,
  MOBILE_SIDEBAR_HEADER_H,
  MOBILE_SIDEBAR_HEADER_H_COMPACT,
  BAR_LABEL_TOP,
  IDENTITY_GLYPH_BOX,
  IDENTITY_GLYPH_INK,
  COLUMN_GAP,
  TAB_GAP_CLASS,
  ROW_H,
  CARD_H,
  SECTION_H,
  SECTION_CARD,
  SIDEBAR_INDENT_STEP,
  ROW_LEAD_TIGHTEN,
  ROW_GLYPH,
  ROW_GLYPH_SLOT,
  SIDEBAR_LABEL_GUTTER_MAX,
  SIDEBAR_LABEL_GUTTER_BARE_MAX,
  ROW_CHEVRON,
  ROW_CHEVRON_SLOT_BARE,
  ROW_CHEVRON_SLOT,
  ROW_ACTION_BOX,
  CHROME_ROW_CONTENT_H,
  chromeRowInset,
  ROW_ACTION_BOX_PX,
  CHROME_ROW_ACTION_INSET,
  CHROME_ROW_ACTION_INSET_LEFT,
  CHROME_ROW_ACTION_RESERVE,
  CHROME_ROW_ACTION_RESERVE_LEFT,
  CHROME_BAR,
  CHROME_BAR_H,
  CHROME_BAR_H_VAR,
  CHROME_ROW_SUB_H,
  CHROME_BAR_SUB,
  CHROME_BAR_SUB_H_CLASS,
  CHROME_BAR_CONSUMED,
  ROW_ACTION_GLYPH,
  ROW_CARD,
  ROW_TRAIL,
  ROW_ACTIONS,
  ROW_ACTIONS_INSET_PX,
  ARCHIVED_ROW,
  TREE_ROW_CARD,
  sidebarRowCard,
};

afterAll(() => {
  mock.module("@/lib/openLink", () => realOpenLink);
  mock.module("@/lib/selectionStyles", () => realSelectionStyles);
});

describe("touchKeysForSession", () => {
  test("a claude-code session offers no suspend byte", () => {
    for (const type of ["claude-code", "claude-code-team"] as const) {
      const keys = touchKeysForSession(type);
      expect(keys.some((k) => k.data.includes(SUSPEND))).toBe(false);
    }
  });

  test("a shell keeps Ctrl+Z", () => {
    const keys = touchKeysForSession("shell");
    expect(keys.some((k) => k.label === "Ctrl+Z" && k.data === SUSPEND)).toBe(true);
  });

  test("other agents and unknown sessions keep the full bar", () => {
    for (const type of ["codex", "opencode", undefined] as const) {
      expect(touchKeysForSession(type).some((k) => k.data === SUSPEND)).toBe(true);
    }
  });

  test("the rendered pane uses Claude keys from its roster entry", async () => {
    const globals = globalThis as unknown as Record<string, unknown>;
    const names = ["window", "document", "navigator", "localStorage"];
    const descriptors = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
    const fakeDocument = {
      documentElement: { classList: { contains: () => false } },
      visibilityState: "visible",
      activeElement: null,
      hasFocus: () => true,
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { ontouchstart: true, addEventListener: () => {}, removeEventListener: () => {}, innerWidth: 390 },
    });
    Object.defineProperty(globalThis, "document", { configurable: true, value: fakeDocument });
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { maxTouchPoints: 1, userAgent: "iPhone", language: "en-US" },
    });
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: { getItem: () => null, setItem: () => {} },
    });

    try {
      mock.module("@/lib/openLink", () => ({
        ...realOpenLink,
        openLink: () => {},
        isExternalLinkGesture: () => false,
      }));
      mock.module("@/lib/selectionStyles", () => ({
        ...realSelectionStyles,
        ROW_H: "",
        ROW_PX: "",
        ROW_GAP: "",
      }));
      const { SingleTerminalPane } = await import("./SingleTerminalPane");
      const session = {
        id: "terminal-from-roster",
        type: "claude-code",
        name: "Claude",
        cwd: "/project",
        createdAt: "2026-10-25T10:00:00.000Z",
      } as unknown as TerminalSessionInfo;
      const html = renderToStaticMarkup(
        createElement(TopicsProvider, {
          topics: {},
          terminalSessions: [session],
          children: createElement(SingleTerminalPane, { sessionId: session.id }),
        }),
      );

      expect(html).toContain('aria-label="Ctrl+_"');
      expect(html).not.toContain('aria-label="Ctrl+Z"');
    } finally {
      for (const name of names) {
        const descriptor = descriptors.get(name);
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globals[name];
      }
    }
  });
});

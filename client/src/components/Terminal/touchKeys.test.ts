/**
 * @covers TERM-14
 *
 * The touch toolbar must not offer Ctrl+Z on Claude sessions: one tap
 * would freeze the pane for good. Shells keep it for job control.
 */
import { describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TopicsProvider } from "../../contexts/TopicsContext";
import type { TerminalSessionInfo } from "../../types";
import { touchKeysForSession } from "./touchKeys";

// Ctrl+Z, built without a literal control byte in source.
const SUSPEND = String.fromCharCode(26);

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
      mock.module("@/lib/openLink", () => ({ openLink: () => {}, isExternalLinkGesture: () => false }));
      mock.module("@/lib/selectionStyles", () => ({ ROW_H: "", ROW_PX: "", ROW_GAP: "" }));
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

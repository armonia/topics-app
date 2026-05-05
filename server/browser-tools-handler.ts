/**
 * Phase 30 BROWSER-CHAT-03 -- Handler implementations for the 6 native
 * browser tools.
 *
 * Each handler accepts (browserService, contextId, args), wraps the
 * action in try/finally with agent_active broadcast (via withLock), and
 * returns a structured response or a structured { error } object (failsoft
 * to the agent).
 *
 * Handler bodies are filled in Task 2. This file ships the type-safe
 * skeleton so Task 1 verification can confirm exports + import-resolve.
 */
import type { BrowserService } from "./browser-service";
import type {
  AgentObserveResponse,
  BrowserActAction,
  IndexedElement,
} from "./browser-tools";

const observeCache = new Map<string, IndexedElement[]>();

export function clearObserveCache(contextId: string): void {
  observeCache.delete(contextId);
}

export async function handleBrowserOpen(
  _service: BrowserService,
  _contextId: string,
  _args: { url: string }
): Promise<{ url: string; title: string }> {
  throw new Error("handleBrowserOpen: skeleton (filled in Task 2)");
}

export async function handleBrowserObserve(
  _service: BrowserService,
  _contextId: string,
  _args: { max_elements?: number }
): Promise<AgentObserveResponse> {
  throw new Error("handleBrowserObserve: skeleton (filled in Task 2)");
}

export async function handleBrowserAct(
  _service: BrowserService,
  _contextId: string,
  _args: { element_id: number; action: BrowserActAction; text?: string }
): Promise<{ ok: true; element: IndexedElement }> {
  throw new Error("handleBrowserAct: skeleton (filled in Task 2)");
}

export async function handleBrowserExtract(
  _service: BrowserService,
  _contextId: string,
  _args: { schema: Record<string, unknown>; instruction?: string }
): Promise<{ extracted: unknown } | { error: string }> {
  throw new Error("handleBrowserExtract: skeleton (filled in Task 2)");
}

export async function handleBrowserScreenshot(
  _service: BrowserService,
  _contextId: string,
  _args: { full_page?: boolean }
): Promise<{
  format: "jpeg";
  data: string;
  viewport: { width: number; height: number };
}> {
  throw new Error("handleBrowserScreenshot: skeleton (filled in Task 2)");
}

export async function handleBrowserPoint(
  _service: BrowserService,
  _contextId: string,
  _args: { description: string }
): Promise<{ clicked: true; point: { x: number; y: number } } | { error: string }> {
  throw new Error("handleBrowserPoint: skeleton (filled in Task 2)");
}

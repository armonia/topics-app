import { apiFetch } from './shell/net';
import type { HealthSubsystem } from '../../../shared/system-health';

// Relative on web/PWA/Electron (same-origin). Under the Tauri desktop shell the
// UI is served locally (tauri://localhost), so a global fetch shim rewrites these
// relative paths to the data server origin — see installNetShim() in
// lib/shell/net.ts (PORTING-PLAN.md Tier 1). Callsites stay unchanged.
export const API_BASE = '/api';

export class ApiError extends Error {
  [key: string]: unknown;
  constructor(public status: number, message: string, extra?: Record<string, unknown>) {
    super(message);
    this.name = 'ApiError';
    if (extra) Object.assign(this, extra);
  }
}

export interface SystemHealthResponse {
  checkedAt: string;
  subsystems: HealthSubsystem[];
}

/** The single client door for the system health endpoint, shared by the panel and /health. */
export async function getSystemHealth(
  fetcher: (path: string) => Promise<Response> = apiFetch,
): Promise<SystemHealthResponse> {
  const response = await fetcher(`${API_BASE}/system/health`);
  if (!response.ok) throw new ApiError(response.status, `HTTP ${response.status}`);
  return await response.json() as SystemHealthResponse;
}

/**
 * A non-ok response body, read the way a person would read it.
 *
 * Every endpoint on this server refuses the same way, `{ error, code, ...rest }`,
 * so the envelope is opened ONCE here. `error` becomes the sentence and the
 * rest rides along on the `ApiError`: callers branch on `code`, not on the
 * wording, and the banner prints a sentence instead of a wall of escaped
 * quotes. `chatApi.sendMessage` used to skip this and throw the raw body.
 *
 * A body that is not JSON is passed through untouched: a proxy's plain-text
 * 502 is still the most informative thing anyone has.
 */
export function readErrorBody(
  text: string,
  statusText: string,
): { message: string; extra?: Record<string, unknown> } {
  let message = text || statusText;
  let extra: Record<string, unknown> | undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      if (typeof obj.error === 'string') message = obj.error;
      const { error: _, ...rest } = obj;
      if (Object.keys(rest).length) extra = rest;
    }
  } catch { /* error body is not JSON: keep the status-based message */ }
  return { message, extra };
}

/**
 * The server's refusal code, for callers that must BRANCH on the refusal.
 *
 * It reads the property the envelope put there, never the sentence: the
 * sentence is written for a person and is free to change wording, and a caller
 * that greps it takes a different decision the day somebody rephrases it.
 */
export function apiErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

export async function request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const headers = {
    'Content-Type': 'application/json',
    ...options.headers,
  };
  const response = await apiFetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers,
    // Il cookie di sessione viaggia da solo, ma solo se lo si chiede
    // esplicitamente su una fetch che potrebbe essere cross-origin (il guscio
    // Tauri lo è). Su same-origin è già il default; scriverlo qui rende il
    // percorso identico ovunque invece di dipendere dall'ospite.
    credentials: 'same-origin',
  });

  if (!response.ok) {
    const { message, extra } = readErrorBody(await response.text(), response.statusText);
    // An identity refusal (401 with a code) has already flipped the pairing
    // screen: `apiFetch` noticed it, for this call and for every other `/api`
    // call that meets it (lib/shell/net.ts).
    throw new ApiError(response.status, message, extra);
  }

  return response.json();
}

// ─── Response-envelope convention ─────────────────────────────────────────────
//
// The server wraps most collection responses in a single-key envelope
// (`{ tasks }`, `{ providers }`, `{ webhooks }`, `{ points }`, …). This file is
// deliberately mixed about how that envelope is surfaced to callers:
//
//   • List methods that return the bare array (`dashboardApi.getTimeSeries`)
//     `await request<{ key: T[] }>`
//     and return `.key` — the caller never sees the envelope.
//   • The remaining methods (`searchApi.search`, `providersApi.snapshot`, …)
//     return the envelope verbatim so the caller destructures
//     `{ results }` / `{ providers }` itself.
//
// Both are intentional and load-bearing for existing callers — do NOT
// "normalise" one into the other without updating every call site. When adding
// a new endpoint, match the convention already used by its sibling methods.

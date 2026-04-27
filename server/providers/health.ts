/**
 * Shared HTTP gateway health-check helper. Used by:
 *   - OpenClaw provider's diagnose()
 *   - Legacy /api/system/status route (status.ts)
 */

export type GatewayHealthStatus =
  | "online" | "offline" | "timeout"
  | "connection_refused" | "server_error" | "auth_error";

export interface GatewayHealthResult {
  status: GatewayHealthStatus;
  online: boolean;
  latencyMs: number;
  httpStatus?: number;
  error?: string;
}

/**
 * Ping the gateway base URL and classify the result. Defaults to a 5s timeout.
 */
export async function checkGatewayHealth(
  gatewayUrl: string,
  token?: string,
  timeoutMs = 5000,
): Promise<GatewayHealthResult> {
  const start = Date.now();
  try {
    const resp = await fetch(`${gatewayUrl}/`, {
      method: "GET",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(timeoutMs),
    });
    const latencyMs = Date.now() - start;
    if (resp.ok) return { status: "online", online: true, latencyMs, httpStatus: resp.status };
    if (resp.status === 401 || resp.status === 403) {
      return { status: "auth_error", online: false, latencyMs, httpStatus: resp.status };
    }
    if (resp.status >= 500) {
      return { status: "server_error", online: false, latencyMs, httpStatus: resp.status };
    }
    return { status: "offline", online: false, latencyMs, httpStatus: resp.status };
  } catch (err: any) {
    const latencyMs = Date.now() - start;
    if (err?.name === "AbortError" || err?.name === "TimeoutError") {
      return { status: "timeout", online: false, latencyMs, error: "Timeout" };
    }
    if (err?.code === "ECONNREFUSED" || err?.message?.includes("ECONNREFUSED")) {
      return { status: "connection_refused", online: false, latencyMs, error: "Connection refused" };
    }
    return { status: "offline", online: false, latencyMs, error: err?.message ?? "Network error" };
  }
}

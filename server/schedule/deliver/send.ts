/**
 * SEND ONE TEXT THROUGH THE ADAPTER, ONCE (rules R22 and R23).
 *
 * The register gives the send its key (`claim`), and `delivering` is on disk
 * before the adapter is called. A try is repeated only when the adapter exits
 * with a non-zero code, three times at most; anything that may have gone out
 * is never sent again. What an adapter wrote on stderr is kept as the detail of
 * a failure and goes nowhere else.
 */
import { adapterCall, spawnAdapter, type AdapterRunner, type AdapterValues } from "./adapter";
import type { DeliveryRegistry, DeliveryState } from "./registry";
import type { DeliverySettings } from "./settings";

export const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 2_000;

export interface SendRequest {
  key: string;
  kind: string;
  text: string;
  values: Omit<AdapterValues, "key">;
}

export interface SenderOptions {
  registry: DeliveryRegistry;
  settings: () => DeliverySettings;
  runner?: AdapterRunner;
  env?: Record<string, string | undefined>;
  wait?: (ms: number) => Promise<void>;
}

export function createSender(options: SenderOptions) {
  const runner = options.runner ?? spawnAdapter;
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const { registry } = options;

  /** Returns the state the send ended in; a key that was already claimed returns the state it has. */
  async function send(request: SendRequest): Promise<DeliveryState> {
    const adapter = options.settings().adapter;
    if (!adapter) {
      registry.record(request.key, request.kind, "not_delivered", "No delivery adapter is configured.");
      return registry.get(request.key)?.state ?? "not_delivered";
    }
    if (!registry.claim(request.key, request.kind)) return registry.get(request.key)?.state ?? "unknown";
    let detail = "";
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (attempt > 1) await wait(RETRY_DELAY_MS * (attempt - 1));
      registry.beginAttempt(request.key);
      try {
        const call = adapterCall(adapter, { ...request.values, key: request.key }, request.text, options.env);
        const result = await runner(call);
        if (result.exitCode === 0) { registry.finish(request.key, "delivered"); return "delivered"; }
        detail = `Exit code ${result.exitCode}: ${result.stderr.trim().split("\n").pop() ?? ""}`.slice(0, 300);
      } catch (error) {
        detail = (error instanceof Error ? error.message : String(error)).slice(0, 300);
      }
    }
    registry.finish(request.key, "delivery_failed", detail);
    return "delivery_failed";
  }
  return Object.assign(send, { registry });
}

export type Sender = ((request: SendRequest) => Promise<DeliveryState>) & { registry: DeliveryRegistry };

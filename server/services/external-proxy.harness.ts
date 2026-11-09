/**
 * Shared pieces of the external-proxy tests: the fakes live on ephemeral ports of 127.0.0.1.
 */
import type { ExternalProxyLeaf } from "./external-proxy-ca";
import { startExternalProxy, type ExternalProxyOptions } from "./external-proxy";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A port nobody listens on (it was free a moment ago). */
export async function closedPort(): Promise<number> {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const p = s.port as number;
  s.stop(true);
  return p;
}

/** A proxy on an ephemeral port, its Messages calls pointed at a fake engine and everything else at a fake Anthropic. */
export async function startProxy(leaf: ExternalProxyLeaf, extra: Partial<ExternalProxyOptions> & { enginePort: number; upstreamPort?: number }) {
  const lines: string[] = [];
  const { enginePort, upstreamPort, ...rest } = extra;
  const proxy = await startExternalProxy({
    port: 0,
    tls: { key: leaf.key, cert: leaf.cert },
    messagesUrl: () => `http://127.0.0.1:${enginePort}/v1/messages`,
    upstreamBase: `http://127.0.0.1:${upstreamPort ?? 1}`,
    log: (event, fields) => lines.push(`${event} ${JSON.stringify(fields ?? {})}`),
    ...rest,
  });
  return { proxy, lines };
}

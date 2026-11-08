/**
 * The environment to hand to long-lived child processes (pty-bridge, ai-bridge,
 * server MCP, CLI di sistema).
 *
 * Drops `GATEWAY_TOKEN`: the server no longer reads it, but a launchd job or a stale
 * shell may still export it, and the daemons that start terminals and `claude`
 * sessions pass their whole environment to every child. A secret nobody
 * uses must not reach the agents' commands.
 */
export function withoutGatewayToken(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const { GATEWAY_TOKEN: _token, ...rest } = env;
  return rest;
}

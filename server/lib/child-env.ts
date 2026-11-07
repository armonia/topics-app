/**
 * L'ambiente da passare ai processi figli che durano (pty-bridge, ai-bridge,
 * server MCP, CLI di sistema).
 *
 * Toglie `GATEWAY_TOKEN`: il server non lo legge più, ma un launchd o una shell
 * vecchia può ancora esportarlo, e i demoni che avviano terminali e sessioni
 * `claude` passano il loro ambiente intero a ogni figlio. Un segreto che nessuno
 * usa non deve arrivare ai comandi degli agenti.
 */
export function withoutGatewayToken(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const { GATEWAY_TOKEN: _token, ...rest } = env;
  return rest;
}

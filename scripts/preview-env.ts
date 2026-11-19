/**
 * The environment of a card preview's isolated server.
 *
 * The preview is started BY the production server, so it inherits that
 * server's whole environment, listener ports included. The isolated server
 * then tries to bind the same tunnel port (3434 on the Mac) and dies with
 * «Is port 3434 in use?»: every card read «preview not started» (19/11, 14
 * cards in review at once). The same inheritance would also let a preview
 * join the production relay or read its secrets.
 *
 * So the variables that name a resource owned by the live server are removed,
 * the same list `scripts/start-dev-qa.sh` unsets, plus the other listeners.
 */
export const LIVE_SERVER_ONLY = [
  "TOPICS_TUNNEL_PORT",
  "TOPICS_TUNNEL_HTTP_PORT",
  "TOPICS_MODEL_PROXY_PORT",
  "TOPICS_EXTERNAL_PROXY_PORT",
  "TOPICS_RELAY_URL",
  "TOPICS_SECRETS_DIR",
] as const;

export function previewServerEnv(
  inherited: Record<string, string | undefined>,
  own: Record<string, string>,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...inherited };
  for (const name of LIVE_SERVER_ONLY) delete env[name];
  return { ...env, ...own };
}

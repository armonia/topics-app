/**
 * The config shape for an endpoint somebody declared in Settings.
 *
 * Its own file rather than another entry in `types.ts`: that file sits right
 * under the size the bloat ratchet freezes, and a type that only two modules
 * read does not need to live in the shared catalogue to be found.
 */
import type { DirectEndpointConfig } from "../../shared/direct-endpoints";

/**
 * Like ACP, and unlike every historical provider, `type` is NOT the name: N
 * endpoints share one type, and each registers as `direct-<id>`.
 */
export interface DirectEndpointProviderConfig {
  type: "openai-compatible";
  endpoint: DirectEndpointConfig;
  /** Bearer token, read from its private file by the caller that builds this. */
  token?: string;
}

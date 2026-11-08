/**
 * Keeps the registry and the endpoint file saying the same thing.
 *
 * One function, called at boot and again after any change in Settings: whoever
 * is in the file is registered, whoever left is stopped and removed. Doing it
 * by diffing the whole set rather than per operation means a hand-edited file,
 * or a change that arrives while a turn is running, converges anyway.
 */
import { listDirectEndpoints, readEndpointSecret } from "../services/direct-endpoint-store";
import { isDirectProviderName, providerNameForEndpoint } from "../../shared/direct-endpoints";
import type { DirectEndpointProviderConfig } from "./openai-compatible-config";

interface RegistryPort {
  listProviders(): Array<{ name: string }>;
  registerProvider(config: DirectEndpointProviderConfig): unknown;
  removeProvider(name: string): void;
}

/** The config the factory needs, token included, for every stored endpoint. */
export function directEndpointConfigs(root?: string): DirectEndpointProviderConfig[] {
  return listDirectEndpoints(root).map((endpoint) => ({
    type: "openai-compatible" as const,
    endpoint,
    token: endpoint.auth === "bearer" ? readEndpointSecret(endpoint.id, root) : undefined,
  }));
}

/** Register what the file declares, drop what it no longer declares. */
export function syncDirectEndpointProviders(registry: RegistryPort, root?: string): string[] {
  const configs = directEndpointConfigs(root);
  const wanted = new Set(configs.map((config) => providerNameForEndpoint(config.endpoint)));
  for (const { name } of registry.listProviders()) {
    if (isDirectProviderName(name) && !wanted.has(name)) registry.removeProvider(name);
  }
  for (const config of configs) registry.registerProvider(config);
  return [...wanted];
}

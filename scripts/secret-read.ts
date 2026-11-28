#!/usr/bin/env bun
/**
 * `bun scripts/secret-read.ts <name>`: prints one secret of the store
 * (`server/lib/secret-store.ts`) on stdout, for a tool that is not TypeScript
 * (`deploy/cloud-node/node-pool` reads its Hetzner token this way on the
 * primary, track T5 of `openspec/changes/nodo-principale-a-mano`).
 *
 * The value goes to stdout only, which the caller captures: never to argv,
 * never to a log. The name is not a secret and is the only thing an error
 * names. Run from the app folder, so the store finds its state dir.
 * Exit 0 printed, 1 not found or outside the allowlist, 64 bad usage.
 */
import { createSecretStore } from "../server/lib/secret-store";

const [name, ...extra] = process.argv.slice(2);
if (!name || extra.length > 0) {
  console.error("usage: bun scripts/secret-read.ts <name>");
  process.exit(64);
}
const value = await createSecretStore().read(name);
if (value === null) {
  console.error(`secret-read: ${name} not found`);
  process.exit(1);
}
process.stdout.write(value);

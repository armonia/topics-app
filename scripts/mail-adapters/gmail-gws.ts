#!/usr/bin/env bun
// Reference mailbox adapter for Gmail on the `gws` CLI. Run by the inbox round as
// the command of a mailbox: JSON request on stdin, JSON answer on stdout (see
// server/mail/inbox/contract.ts). Only `list` is implemented. The `gws` binary is
// found on the PATH, or at TOPICS_GWS_CLI. Configuration it needs, such as the
// credentials directory, comes from the mailbox's `adapter.env`.
import { createGmailList, type GwsCall } from "../../server/mail/inbox/gmail-adapter";

const gws: GwsCall = async (resource, method, params) => {
  const cli = process.env.TOPICS_GWS_CLI?.trim() || "gws";
  const child = Bun.spawn([cli, "gmail", "users", resource, method, "--params", JSON.stringify(params)], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`gws ${resource} ${method} exited with ${code}: ${err.slice(0, 200)}`);
  return JSON.parse(out) as unknown;
};

const request = JSON.parse(await new Response(Bun.stdin.stream()).text()) as { op?: string; cursor?: string | null; sinceMs?: number; limit?: number };
if (request.op !== "list") {
  console.error(`unsupported op: ${request.op}`);
  process.exit(2);
}
const answer = await createGmailList(gws)({ cursor: request.cursor ?? null, sinceMs: Number(request.sinceMs), limit: Number(request.limit ?? 100) });
process.stdout.write(JSON.stringify(answer));

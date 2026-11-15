import { compressJson } from "../lib/compress-json";
import type { BootScope } from "../../server";
import type { createHttpCors } from "./http-cors";

type ServerFetch = BootScope["opzioniServer"]["fetch"];

export function createHttpWrappers(d: {
  isRemotePeer: ReturnType<typeof createHttpCors>["isRemotePeer"];
  logRequest: BootScope["logRequest"];
}) {
  const { isRemotePeer, logRequest } = d;

  /**
   * JSON responses leave compressed toward whoever is NOT local.
   *
   * The real handler is left alone: it is wrapped once, here, where every response
   * of both listeners goes through. The reasoning for the rule, and for why
   * loopback stays raw, lives in `server/lib/compress-json.ts`. In short:
   * `/api/history` for a working topic weighs 5.17 MB and 1.39 MB compressed, but
   * the 60 ms of CPU that buys only buys a second and a half when there is a
   * network in between.
   */
  function withJsonCompression(
    handler: ServerFetch,
  ): ServerFetch {
    return async function (this: unknown, req, srv) {
      const res = await handler.call(this as never, req, srv);
      // `undefined` means the WebSocket upgrade succeeded: there is no HTTP
      // response to compress.
      if (!res) return res;
      return compressJson(req, res, isRemotePeer(req, srv));
    } as ServerFetch;
  }

  /**
   * One line per completed `/api/*` request: timestamp, status, duration.
   *
   * Before this the log had a start line for every API request (`[HTTP] -> GET
 * /x`, no time, no outcome) and a completion line ONLY for 404s: under load you
   * could not tell which route was slow or whether a request ever finished, and
   * the file was mostly the 2s viewer poll. The outcome is what a log is for, so
   * the start line is gone and the completion line is here, outside every
   * handler, where every response of both listeners passes. `logRequest`
   * (server/utils.ts, server/lib/http-log.ts) owns the format and keeps the
   * chatty routes quiet unless they fail or are slow.
   *
   * `undefined` is a WebSocket upgrade: no response, nothing to log.
   */
  function withHttpLog(
    handler: ServerFetch,
  ): ServerFetch {
    return async function (this: unknown, req, srv) {
      const t0 = Date.now();
      const res = await handler.call(this as never, req, srv);
      if (res) {
        const pathname = new URL(req.url).pathname;
        if (pathname.startsWith("/api/")) logRequest(req.method, pathname, res.status, t0);
      }
      return res;
    } as ServerFetch;
  }

  return { withJsonCompression, withHttpLog };
}

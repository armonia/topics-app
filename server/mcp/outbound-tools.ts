/**
 * THE TWO TOOLS THAT LEAVE THE MACHINE, kept out of `topics-mcp-server.ts`.
 *
 * Their schemas and their poll loops live here for the same reason the browser
 * tools live in `browser-tool-spec.ts`: the bridge file is a dispatcher, and a
 * family of tools that arrives with its own contract (a confirmation the server
 * imposes, legs that wait for a person) is a family, not four more entries in a
 * list. `check:bloat` counts the lines of the dispatcher and it is right to.
 *
 * WHAT IS *NOT* HERE, deliberately: the policy. No account roster, no path of
 * an executable, no decision about what needs a human. All of that is
 * server-side (`server/routes/outbound.ts`), because a rule enforced inside the
 * agent's own subprocess is a rule the agent enforces on itself.
 */
import { httpJson, HttpAnswerError, type ParsedArgs } from "./topics-http";

/**
 * The annotations, written out instead of imported from the dispatcher.
 *
 * The dispatcher imports THIS file to build its tool list, so importing a value
 * back from it would be the cycle `GATE-08` refuses (and the shared HTTP helper
 * moved to `topics-http.ts` for the same reason). The four booleans are the
 * contract itself anyway, and `readOnlyHint: false` is spelled out because an
 * absent annotation and a false one look the same to the CLI and read
 * differently to a person: one is a line nobody wrote.
 */
const LEAVES_THE_MACHINE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

/** Backoff between retries of a lost leg (ms). Grows, then settles. */
const RETRY_BACKOFF_MS = [500, 1000, 2000, 4000, 5000];
/** How long the server may be unreachable before a leg gives up saying so. */
const TRANSPORT_GRACE_MS = 90_000;
/** One leg. Short enough that no idle-socket timeout ever sees it. */
const LEG_MS = 25_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const OUTBOUND_TOOLS = [
  {
    name: "send_mail",
    description:
      "Send an email from one of the mailboxes this installation declares. THE PERSON CONFIRMS EVERY MESSAGE: the server opens a confirmation before anything is spawned (in the card thread when you are working a task, as a panel in the chat otherwise) and nothing leaves until it is answered, one answer per message. You do not ask separately and you cannot pre-approve: call the tool with the final text and wait. The account is chosen by NAME from the declared roster; an unknown name is refused rather than swapped for another mailbox. Attachments are paths inside this session's workspace, and their BYTES are frozen when the question is asked: what leaves is what the person was shown the name, the size and the fingerprint of, whatever happens to the file afterwards - a frozen copy that no longer matches its fingerprint stops the send. They must be regular files, and there is a ceiling on the total, measured before anything is read. A successful send leaves a one-line trace on the card (who, to whom, subject, outcome) without the body.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient address, or several comma-separated." },
        subject: { type: "string", description: "Subject line." },
        body: { type: "string", description: "Plain-text body, final: this is what gets sent once the person confirms." },
        cc: { type: "string", description: "Optional CC address(es), comma-separated." },
        account: { type: "string", description: "Which declared mailbox sends it, by name. Omit for the default one. An account nobody declared is an error, never a substitution." },
        attachments: {
          type: "array",
          items: { type: "string" },
          description: "Optional file paths, relative to this session's workspace or absolute inside it. A path that resolves outside it is refused.",
        },
      },
      required: ["to", "subject", "body"],
    },
    annotations: { ...LEAVES_THE_MACHINE, title: "Manda una mail (con conferma)" },
  },
  {
    name: "google_call",
    description:
      "One door onto Google Workspace through the `gws` CLI: drive, calendar, sheets, docs, tasks, people, gmail. Shape: service + resource (+ optional sub-resource) + method, with `params` (query) and `body` (request body) as JSON objects. Reads (list, get, search, ...) run straight away. WRITES ASK THE PERSON FIRST, the same one-per-action confirmation `send_mail` uses, and a method that cannot be classified counts as a write; the question shows the call in words, decoding a `raw` message instead of pasting base64 at it. SENDING MAIL IS NOT ON THIS DOOR: every Gmail call that puts a message on the wire is refused here (API paths and the `+send`/`+reply`/`+reply-all`/`+forward` helpers alike), use `send_mail`. The four fields are API NAMES - letters, digits, dot, underscore - and never command-line arguments: a field starting with a dash is refused. A successful write leaves a trace on the card. Examples: service='calendar', resource='events', method='list', params={calendarId:'primary'}; service='drive', resource='files', method='list'.",
    inputSchema: {
      type: "object",
      properties: {
        service: { type: "string", description: "drive | calendar | sheets | docs | tasks | people | gmail." },
        resource: { type: "string", description: "The resource, e.g. 'files', 'events', 'spreadsheets'." },
        subresource: { type: "string", description: "Optional sub-resource, e.g. 'messages' under gmail's 'users'." },
        method: { type: "string", description: "The method, e.g. 'list', 'get', 'create', 'update', 'delete'." },
        params: { type: "object", description: "Query/URL parameters as a JSON object." },
        body: { type: "object", description: "Request body as a JSON object (POST/PATCH/PUT)." },
      },
      required: ["service", "resource", "method"],
    },
    annotations: { ...LEAVES_THE_MACHINE, title: "Chiama Google (scritture con conferma)" },
  },
];

/**
 * Anti-spin cap for the two outbound tools. Legs are `LEG_MS`, so 600 of them
 * is a bit over four hours.
 *
 * DELIBERATELY BELOW the ask TTL, which is the opposite of what `ASK_MAX_LEGS`
 * does, and the difference is the subject: a question the person has not
 * answered is still worth asking tomorrow, while a message nobody confirmed in
 * four hours must not leave on hour twenty-three under a confirmation whose
 * context everybody has forgotten. Running out of legs is reported as "not
 * confirmed", which is the safe direction: nothing was sent.
 */
export const OUTBOUND_MAX_LEGS = 600;

interface OutboundLegResponse {
  pending?: boolean;
  refused?: boolean;
  reason?: string;
  sent?: boolean;
  ok?: boolean;
  account?: string;
  to?: string;
  subject?: string;
  call?: string;
  output?: string;
  traced?: boolean;
}

/**
 * ONE POLL LEG AT A TIME against an outbound route, for the same reason
 * `callAskUserQuestion` does it: under this call there is a PERSON deciding,
 * and a single HTTP request held open with no bytes flowing is exactly what an
 * idle-socket timeout kills - on this side, where the server cannot save it.
 *
 * A read-only Google call answers on the first leg and never sees any of this.
 */
async function pollOutbound(
  args: ParsedArgs,
  tool: string,
  path: string,
  payload: Record<string, unknown>,
  fetchImpl: typeof fetch,
  opts: {
    backoffMs?: number[];
    maxLegs?: number;
    legMs?: number;
    transportGraceMs?: number;
    now?: () => number;
    onProgress?: (leg: number) => void;
  } = {},
): Promise<OutboundLegResponse> {
  const backoff = opts.backoffMs ?? RETRY_BACKOFF_MS;
  const transportGraceMs = opts.transportGraceMs ?? TRANSPORT_GRACE_MS;
  const now = opts.now ?? Date.now;
  const maxLegs = opts.maxLegs ?? OUTBOUND_MAX_LEGS;
  const legMs = opts.legMs ?? LEG_MS;
  const bodyWithLeg = { ...payload, legMs };

  let transportFailures = 0;
  let firstFailureAt: number | null = null;
  for (let leg = 0; leg < maxLegs; leg++) {
    let body: OutboundLegResponse | null | undefined;
    try {
      body = await httpJson<OutboundLegResponse>(args, "POST", path, bodyWithLeg, fetchImpl);
      transportFailures = 0;
      firstFailureAt = null;
    } catch (err) {
      // AN ANSWER IS NEVER RE-SENT. The file said so and did the opposite: a
      // status outside 2xx throws out of `httpJson` exactly like a lost socket,
      // so every talking error (unknown account, missing variable, refused
      // attachment) was counted as a transport failure and the same body was
      // POSTed again.
      // Past the confirmation that is worse than noise: the first leg already
      // ran the CLI and consumed the yes, so the second POST opens a NEW
      // question for the same message, and a person who confirms it sends the
      // mail twice. The error the server wrote is the one the agent needs.
      if (err instanceof HttpAnswerError) throw new Error(`${tool}: ${err.message}`);
      // A dropped socket is retried; a server that has been unreachable for the
      // whole grace window is reported.
      transportFailures++;
      if (firstFailureAt === null) firstFailureAt = now();
      const downMs = now() - firstFailureAt;
      if (downMs > transportGraceMs) {
        throw new Error(
          `${tool}: lost contact with topics-app for ${Math.round(downMs / 1000)}s over ${transportFailures} attempts (${err instanceof Error ? err.message : String(err)})`,
        );
      }
      await sleep(backoff[Math.min(transportFailures - 1, backoff.length - 1)] ?? 0);
      continue;
    }
    if (!body) throw new Error(`${tool}: empty response from topics-app`);
    if (body.refused) {
      throw new Error(`${tool}: nothing was done - ${body.reason || "the person did not confirm"}`);
    }
    if (body.pending) {
      // Nobody has answered yet. Saying so out loud is what stops the MCP
      // client from declaring a call hung under a person who is still reading.
      opts.onProgress?.(leg + 1);
      continue;
    }
    return body;
  }
  throw new Error(`${tool}: nothing was sent - no confirmation after ${maxLegs} poll legs`);
}

/**
 * Send one message. The confirmation is the SERVER's, not this function's: all
 * that happens here is asking the route and coming back until it answers.
 */
export async function callSendMail(
  args: ParsedArgs,
  toolArgs: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
  opts: Parameters<typeof pollOutbound>[5] = {},
): Promise<string> {
  const to = typeof toolArgs?.to === "string" ? toolArgs.to.trim() : "";
  const subject = typeof toolArgs?.subject === "string" ? toolArgs.subject : "";
  const body = typeof toolArgs?.body === "string" ? toolArgs.body : "";
  if (!to) throw new Error("send_mail: 'to' (string) is required");
  if (!subject.trim()) throw new Error("send_mail: 'subject' (string) is required");
  if (!body.trim()) throw new Error("send_mail: 'body' (string) is required");

  const payload: Record<string, unknown> = { to, subject, body };
  if (typeof toolArgs?.cc === "string" && toolArgs.cc.trim()) payload.cc = toolArgs.cc.trim();
  if (typeof toolArgs?.account === "string" && toolArgs.account.trim()) payload.account = toolArgs.account.trim();
  if (Array.isArray(toolArgs?.attachments)) {
    payload.attachments = toolArgs.attachments.filter((a): a is string => typeof a === "string" && !!a.trim());
  }

  const res = await pollOutbound(
    args,
    "send_mail",
    `/api/sessions/${encodeURIComponent(args.sessionKey)}/outbound/mail`,
    payload,
    fetchImpl,
    opts,
  );
  const traced = res.traced ? " A trace was left on the card." : "";
  return `sent from ${res.account ?? "?"} to ${res.to ?? to} - subject "${res.subject ?? subject}".${traced}`;
}

/** One call onto Google. Reads answer immediately; writes wait for a person. */
export async function callGoogleCall(
  args: ParsedArgs,
  toolArgs: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
  opts: Parameters<typeof pollOutbound>[5] = {},
): Promise<string> {
  const service = typeof toolArgs?.service === "string" ? toolArgs.service.trim() : "";
  const resource = typeof toolArgs?.resource === "string" ? toolArgs.resource.trim() : "";
  const method = typeof toolArgs?.method === "string" ? toolArgs.method.trim() : "";
  if (!service) throw new Error("google_call: 'service' (string) is required");
  if (!resource) throw new Error("google_call: 'resource' (string) is required");
  if (!method) throw new Error("google_call: 'method' (string) is required");

  const payload: Record<string, unknown> = { service, resource, method };
  if (typeof toolArgs?.subresource === "string" && toolArgs.subresource.trim()) {
    payload.subresource = toolArgs.subresource.trim();
  }
  if (toolArgs?.params !== undefined && toolArgs.params !== null) payload.params = toolArgs.params;
  if (toolArgs?.body !== undefined && toolArgs.body !== null) payload.body = toolArgs.body;

  const res = await pollOutbound(
    args,
    "google_call",
    `/api/sessions/${encodeURIComponent(args.sessionKey)}/outbound/google`,
    payload,
    fetchImpl,
    opts,
  );
  const output = (res.output ?? "").trim();
  return output ? `${res.call ?? method}:\n${output}` : `${res.call ?? method}: done, no output`;
}

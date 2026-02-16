import type { AppContext, RouteHandler } from "../types";
import type { JournalCollector } from "../journal-collector";

export function createJournalRouter(ctx: AppContext, collector: JournalCollector): RouteHandler {
  const { GATEWAY_URL, GATEWAY_TOKEN, json, readJSON } = ctx;

  return async function journalRouter(req: Request, url: URL, pathname: string, method: string): Promise<Response | null> {

    // GET /api/journal/events?date=YYYY-MM-DD
    if (method === "GET" && pathname === "/api/journal/events") {
      const date = url.searchParams.get("date") || new Date().toISOString().slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: "Invalid date format. Use YYYY-MM-DD." }, 400);
      const events = collector.loadEvents(date);
      return json({ date, events, total: events.length });
    }

    // GET /api/journal/digest?date=YYYY-MM-DD
    if (method === "GET" && pathname === "/api/journal/digest") {
      const date = url.searchParams.get("date") || new Date().toISOString().slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: "Invalid date format. Use YYYY-MM-DD." }, 400);
      const digest = collector.loadDigest(date);
      return json({ date, digest, exists: digest !== null });
    }

    // POST /api/journal/digest/generate
    if (method === "POST" && pathname === "/api/journal/digest/generate") {
      const body = await readJSON(req);
      const date = body?.date || new Date().toISOString().slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: "Invalid date format. Use YYYY-MM-DD." }, 400);

      const events = collector.loadEvents(date);
      if (events.length === 0) return json({ error: "No events found for this date" }, 404);

      // Summarize events for the LLM
      const eventSummary = events.map(e => `[${e.timestamp}] ${e.summary}`).join('\n');

      try {
        const resp = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${GATEWAY_TOKEN}`, "x-openclaw-session-key": `journal:digest:${date}` },
          body: JSON.stringify({
            model: "openclaw",
            stream: false,
            messages: [
              {
                role: "system",
                content: `You are a journal writer for an AI agent system. Write a concise daily narrative summary of the agent's activities. Use a professional but warm tone. Organize by themes or time periods. Keep it under 500 words. Format as markdown with headers and bullet points where appropriate.`
              },
              {
                role: "user",
                content: `Write a daily journal entry for ${date} based on these activity events:\n\n${eventSummary}`
              }
            ],
          }),
        });

        if (!resp.ok) {
          const errText = await resp.text();
          return json({ error: "Failed to generate digest: " + errText }, 502);
        }

        const result = await resp.json() as any;
        const digest = result?.choices?.[0]?.message?.content || "";
        if (!digest) return json({ error: "No content generated" }, 500);

        collector.saveDigest(date, digest);
        return json({ date, digest, generated: true });
      } catch (err: any) {
        return json({ error: "Digest generation failed: " + err.message }, 500);
      }
    }

    return null;
  };
}

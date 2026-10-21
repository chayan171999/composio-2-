import { generateGuide } from "@/lib/agent/generate";
import { checkRateLimit } from "@/lib/ratelimit";
import { saveGuide } from "@/lib/store";

export const runtime = "nodejs";
export const maxDuration = 180;

export async function GET(request: Request) {
  const query = new URL(request.url).searchParams.get("q")?.trim();
  if (!query) {
    return new Response("Missing ?q", { status: 400 });
  }
  if (query.length > 100) {
    return new Response("Query too long", { status: 400 });
  }
  if (!process.env.GROQ_API_KEY) {
    return new Response("GROQ_API_KEY is not configured", { status: 503 });
  }

  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  const limit = checkRateLimit(ip);
  if (!limit.ok) {
    return new Response(`Rate limited — try again in ${limit.retryAfterSec}s`, {
      status: 429,
      headers: { "retry-after": String(limit.retryAfterSec) },
    });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: unknown) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));

      try {
        for await (const event of generateGuide(query)) {
          // Persisting here rather than from the client keeps the store writable
          // only by the generator, so no one can POST an arbitrary guide into it.
          if (event.type === "done") {
            try {
              await saveGuide(event.guide);
            } catch {
              send({
                type: "warning",
                message: "Could not save the guide — the URL will not be shareable.",
              });
            }
          }
          send(event);
        }
      } catch (error) {
        send({
          type: "error",
          message: error instanceof Error ? error.message : "Generation failed.",
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}

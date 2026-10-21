// Groq exposes an OpenAI-compatible endpoint, so this talks to it with fetch
// rather than pulling in another SDK.
const BASE = "https://api.groq.com/openai/v1/chat/completions";

export type GroqMessage = { role: "system" | "user" | "assistant"; content: string };

export type GroqCall = {
  model: string;
  messages: GroqMessage[];
  maxTokens: number;
  /** Ask for a JSON object back. Groq honours this on the gpt-oss models. */
  json?: boolean;
  signal?: AbortSignal;
};

export class GroqError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
    /** Seconds the server asked us to wait, when it said. */
    readonly retryAfterSec?: number,
  ) {
    super(message);
  }
}

export type GroqResult = { text: string; tokens: number };

export async function groqChat(
  apiKey: string,
  { model, messages, maxTokens, json, signal }: GroqCall,
): Promise<GroqResult> {
  const response = await fetch(BASE, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens,
      temperature: 0.2,
      ...(json ? { response_format: { type: "json_object" } } : {}),
    }),
    signal,
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const message: string =
      body?.error?.message ?? `Groq request failed (${response.status})`;

    // 429 here is a per-minute token/request rate, not a daily ceiling, so it
    // clears on its own — unlike the daily quota wall on other free tiers.
    const retryable = response.status === 429 || response.status >= 500;

    // The free tier meters tokens per minute, so a 429 needs to be waited out for
    // as long as the server says — a few seconds of backoff just fails again.
    const header = response.headers.get("retry-after");
    const fromHeader = header ? Number(header) : NaN;
    const fromBody = Number(message.match(/try again in ([\d.]+)s/i)?.[1]);
    const retryAfterSec = [fromHeader, fromBody].find(
      (value) => Number.isFinite(value) && value > 0,
    );

    throw new GroqError(message, response.status, retryable, retryAfterSec);
  }

  const body = await response.json();
  return {
    text: body.choices?.[0]?.message?.content ?? "",
    tokens: body.usage?.total_tokens ?? 0,
  };
}

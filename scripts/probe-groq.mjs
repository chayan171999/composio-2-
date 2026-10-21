// Probes what a Groq free-tier key can actually do, before any code is written
// against it: which models are reachable, whether the built-in retrieval tools
// (Visit Website / browser_search) work or are billed, and the real rate limits.
import { readFileSync } from "fs";

const env = readFileSync(new URL("../.env.local", import.meta.url), "utf-8");
const key = env.match(/^GROQ_API_KEY=(.*)$/m)?.[1]?.trim();
if (!key) {
  console.error("No GROQ_API_KEY in .env.local");
  process.exit(1);
}

const BASE = "https://api.groq.com/openai/v1";
const H = { authorization: `Bearer ${key}`, "content-type": "application/json" };

const DOC = "https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app";

function limits(res) {
  const g = (n) => res.headers.get(n);
  const parts = [
    ["req/min", g("x-ratelimit-limit-requests")],
    ["req left", g("x-ratelimit-remaining-requests")],
    ["tok/min", g("x-ratelimit-limit-tokens")],
    ["tok left", g("x-ratelimit-remaining-tokens")],
  ].filter(([, v]) => v);
  return parts.map(([k, v]) => `${k}=${v}`).join("  ") || "(no limit headers)";
}

async function chat(label, body) {
  const started = Date.now();
  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: H,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90_000),
    });
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = json?.error?.message ?? JSON.stringify(json).slice(0, 180);
      console.log(`FAIL  ${label.padEnd(34)} ${res.status}  ${msg.slice(0, 150)}`);
      return null;
    }
    const text = json.choices?.[0]?.message?.content ?? "";
    const used = json.usage?.total_tokens ?? "?";
    console.log(`PASS  ${label.padEnd(34)} ${secs}s  tokens=${used}`);
    console.log(`      limits: ${limits(res)}`);
    console.log(`      says: ${JSON.stringify(text.replace(/\s+/g, " ").slice(0, 160))}`);
    return json;
  } catch (err) {
    console.log(`FAIL  ${label.padEnd(34)} ${String(err?.message ?? err).slice(0, 120)}`);
    return null;
  }
}

// 1. what models are reachable at all
const modelsRes = await fetch(`${BASE}/models`, { headers: H });
if (!modelsRes.ok) {
  console.error("models list failed:", modelsRes.status, await modelsRes.text());
  process.exit(1);
}
const models = (await modelsRes.json()).data.map((m) => m.id).sort();
console.log(`${models.length} models reachable\n`);
const interesting = models.filter((m) =>
  /compound|gpt-oss|llama-3\.3|llama-3\.1|qwen|kimi/i.test(m),
);
console.log("relevant:", interesting.join(", "), "\n");

// 2. plain generation — is the key alive at all
await chat("plain: llama-3.3-70b", {
  model: "llama-3.3-70b-versatile",
  messages: [{ role: "user", content: "Reply with the single word: ok" }],
  max_tokens: 20,
});

// 3. the decisive test — can it actually read a URL?
await chat("compound: visit website", {
  model: "groq/compound",
  messages: [
    {
      role: "user",
      content: `Visit ${DOC} and list the required fields when registering a GitHub OAuth app. Name the URL you read.`,
    },
  ],
  max_tokens: 700,
});

await chat("compound-mini: visit website", {
  model: "groq/compound-mini",
  messages: [
    {
      role: "user",
      content: `Visit ${DOC} and list the required fields when registering a GitHub OAuth app.`,
    },
  ],
  max_tokens: 700,
});

// 4. browser search on the gpt-oss models
await chat("gpt-oss-120b: browser_search", {
  model: "openai/gpt-oss-120b",
  messages: [
    { role: "user", content: "What fields does GitHub require to register an OAuth app?" },
  ],
  tools: [{ type: "browser_search" }],
  max_tokens: 700,
});

// 5. how expensive is a realistic doc payload? tokens/day is likely the real cap
const page = await fetch(DOC).then((r) => r.text()).catch(() => "");
const stripped = page
  .replace(/<script[\s\S]*?<\/script>/gi, "")
  .replace(/<style[\s\S]*?<\/style>/gi, "")
  .replace(/<[^>]+>/g, " ")
  .replace(/\s+/g, " ")
  .trim();
console.log(`\none fetched doc page: ${page.length} bytes raw -> ${stripped.length} chars stripped`);
console.log(`rough token estimate: ~${Math.round(stripped.length / 4)} tokens (x6 pages per run)`);

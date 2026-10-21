export type FetchedDoc = {
  url: string;
  /** The URL after redirects — what actually got read, and what may be cited. */
  finalUrl: string;
  title: string;
  text: string;
  ok: boolean;
  status: number;
};

const TIMEOUT_MS = 12_000;
// The free tier caps a whole request at 8k tokens, so pages are capped at roughly
// 550 tokens each rather than sent whole.
const MAX_CHARS_PER_DOC = 2200;

function stripHtml(html: string): { title: string; text: string } {
  const title =
    html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim().slice(0, 120) ?? "";

  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, " ")
    .trim();

  return { title: decodeEntities(title), text };
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

/**
 * Keep the part of a page that talks about registration, scopes and review,
 * rather than the first N characters, which on most docs sites is navigation.
 */
function focus(text: string, limit: number): string {
  if (text.length <= limit) return text;

  const markers = [
    /register(ing)? (a|an|your) (new )?(oauth )?app/i,
    /create (a|an|your) (new )?(oauth )?app/i,
    /client secret/i,
    /redirect ur[il]/i,
    /scopes?\b/i,
    /app review|verification|access level/i,
    /rate limit/i,
  ];

  for (const marker of markers) {
    const at = text.search(marker);
    if (at > 0) {
      const start = Math.max(0, at - Math.floor(limit * 0.2));
      return text.slice(start, start + limit);
    }
  }
  return text.slice(0, limit);
}

export async function fetchDoc(url: string): Promise<FetchedDoc> {
  const base: FetchedDoc = {
    url,
    finalUrl: url,
    title: "",
    text: "",
    ok: false,
    status: 0,
  };

  try {
    const response = await fetch(url, {
      redirect: "follow",
      headers: {
        // Some docs sites serve a stub to unknown agents.
        "user-agent":
          "Mozilla/5.0 (compatible; composio-oauth-guides/1.0; +https://github.com/chayan171999)",
        accept: "text/html,application/xhtml+xml",
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    const status = response.status;
    const finalUrl = response.url || url;
    if (!response.ok) return { ...base, finalUrl, status };

    const html = await response.text();
    const { title, text } = stripHtml(html);
    if (text.length < 200) return { ...base, finalUrl, status, title };

    return {
      url,
      finalUrl,
      title: title || finalUrl,
      text: focus(text, MAX_CHARS_PER_DOC),
      ok: true,
      status,
    };
  } catch {
    return base;
  }
}

export async function fetchDocs(urls: string[]): Promise<FetchedDoc[]> {
  const seen = new Set<string>();
  const results = await Promise.all(urls.map(fetchDoc));

  return results.filter((doc) => {
    if (!doc.ok || seen.has(doc.finalUrl)) return false;
    seen.add(doc.finalUrl);
    return true;
  });
}

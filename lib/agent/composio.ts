import type { ComposioCheck } from "./types";

const API_BASE = "https://backend.composio.dev/api/v3.1/toolkits";
const DOCS_BASE = "https://docs.composio.dev/toolkits";

export function toolkitSlugCandidates(query: string, appName?: string): string[] {
  const normalize = (value: string) =>
    value
      .toLowerCase()
      .replace(/https?:\/\//, "")
      .replace(/\.(com|io|dev|org|net|co)\b.*$/, "")
      .replace(/[^a-z0-9]+/g, "");

  const candidates = [appName, query]
    .filter((value): value is string => Boolean(value))
    .flatMap((value) => [normalize(value), normalize(value.split(/[\s/]+/)[0] ?? "")]);

  return [...new Set(candidates.filter((slug) => slug.length > 1))];
}

async function checkViaApi(
  slug: string,
  apiKey: string,
): Promise<ComposioCheck | null> {
  const response = await fetch(`${API_BASE}/${encodeURIComponent(slug)}`, {
    headers: { "x-api-key": apiKey },
  });
  if (!response.ok) return null;

  const body = await response.json();
  const schemes: unknown = body?.composio_managed_auth_schemes;
  const list = Array.isArray(schemes) ? schemes.map(String) : [];
  const hasOAuth = list.some((scheme) => scheme.toUpperCase().includes("OAUTH"));

  return {
    managedOAuth: list.length === 0 ? "no" : hasOAuth ? "yes" : "no",
    method: "api",
    authoritative: true,
    toolkitSlug: slug,
    source: {
      url: `${DOCS_BASE}/${slug}`,
      title: `Composio — ${slug} toolkit`,
    },
    detail: `Composio API reports composio_managed_auth_schemes: [${list.join(", ") || "none"}] for toolkit "${slug}".`,
  };
}

/**
 * The public toolkit page embeds the same field the authenticated API returns —
 * composioManagedAuthSchemes — in its page data, and states it in prose as
 * "Composio-managed OAuth available". Reading it here means the answer is
 * deterministic without any credential.
 *
 * A model was previously asked to judge this from a page excerpt and got it
 * backwards: the page is over 500k characters, so the excerpt it saw was the FAQ
 * entry about setting up *custom* credentials, not the auth summary.
 */
function readManagedSchemes(html: string): string[] | null {
  // Matches both the raw and the backslash-escaped form the page ships.
  const field = html.match(
    /composioManagedAuthSchemes\\?"\s*:\s*\[([^\]]*)\]/i,
  )?.[1];

  if (field !== undefined) {
    const schemes = [...field.matchAll(/([A-Z][A-Z0-9_]+)/g)].map((m) => m[1]);
    return schemes;
  }

  if (/Composio-managed OAuth available/i.test(html)) return ["OAUTH2"];
  return null;
}

async function checkViaDocs(slug: string): Promise<ComposioCheck | null> {
  const url = `${DOCS_BASE}/${slug}`;
  const response = await fetch(url, {
    method: "GET",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) return null;

  const schemes = readManagedSchemes(await response.text());
  const source = { url, title: `Composio — ${slug} toolkit` };

  // No match means the page shape changed. Say "unknown" rather than guess.
  if (schemes === null) {
    return {
      managedOAuth: "unknown",
      method: "docs",
      authoritative: false,
      toolkitSlug: slug,
      source,
      detail: `A Composio toolkit page exists at ${url}, but its managed-auth field could not be read. Treat the managed OAuth status as unconfirmed.`,
    };
  }

  const hasOAuth = schemes.some((scheme) => scheme.toUpperCase().includes("OAUTH"));
  return {
    managedOAuth: hasOAuth ? "yes" : "no",
    method: "docs",
    authoritative: true,
    toolkitSlug: slug,
    source,
    detail: `Composio's public toolkit page lists composioManagedAuthSchemes: [${schemes.join(", ") || "none"}] for "${slug}", so Composio-managed OAuth is ${hasOAuth ? "available" : "not available"} for this toolkit.`,
  };
}

export async function checkComposio(candidates: string[]): Promise<ComposioCheck> {
  const apiKey = process.env.COMPOSIO_API_KEY;

  for (const slug of candidates) {
    try {
      // An API key that is rejected — the wrong key type, say, or a revoked one —
      // used to end the check here, which was worse than having no key at all:
      // the docs page never got looked up, so the agent lost the one page that
      // could answer the managed-OAuth question.
      const result =
        (apiKey ? await checkViaApi(slug, apiKey) : null) ??
        (await checkViaDocs(slug));
      if (result) return result;
    } catch {
      // Network failures fall through to the next candidate, then to "unknown".
    }
  }

  return {
    managedOAuth: "unknown",
    method: "none",
    authoritative: false,
    detail: `No Composio toolkit matched any of: ${candidates.join(", ")}. Managed OAuth status could not be confirmed.`,
  };
}

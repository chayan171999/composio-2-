import { z } from "zod";
import {
  actorSchema,
  blockerTypeSchema,
  claimStatusSchema,
  guideSchema,
  reviewLevelSchema,
  sourceSchema,
  type Guide,
  type Source,
} from "@/lib/schema";
import { checkComposio, toolkitSlugCandidates } from "./composio";
import { fetchDocs } from "./fetchDocs";
import { GroqError, groqChat, type GroqMessage } from "./groq";
import {
  DISCOVERY_SYSTEM,
  SYNTHESIS_SYSTEM,
  discoveryPrompt,
  repairPrompt,
  synthesisPrompt,
} from "./prompts";
import type { ComposioCheck, ProgressEvent } from "./types";

const MODEL = process.env.GROQ_MODEL ?? "openai/gpt-oss-120b";
// gpt-oss-20b proposed 5 URLs on one run and 1 on the next, which swung a guide
// from 15 claims to 7. Discovery is a ~700 token call, so it uses the stronger
// model rather than the cheap one.
const DISCOVERY_MODEL = process.env.GROQ_DISCOVERY_MODEL ?? "openai/gpt-oss-120b";
const MIN_URLS = 3;
// gpt-oss models emit reasoning tokens that count against max_tokens, so a tight
// ceiling truncates the JSON mid-structure and Groq rejects the whole response.
// Discovery needs ~1.1k; synthesis needs room for a full guide plus reasoning.
const DISCOVERY_MAX_TOKENS = 2500;
// The free tier caps a whole request at 8k tokens, and max_tokens counts toward
// it, so the output ceiling has to leave room for the system prompt and pages.
const SYNTHESIS_MAX_TOKENS = 4200;
const MAX_DOCS_IN_PROMPT = 4;
const MAX_URLS = 6;
// The free tier meters 8k tokens/minute, so a 429 here is a pace limit that
// clears shortly rather than a daily ceiling.
const RETRY_ATTEMPTS = 4;
const RETRY_BASE_MS = 3000;
const MAX_RETRY_MS = 65_000;
const WALL_CLOCK_MS = 165_000;
const PER_CALL_TIMEOUT_MS = 110_000;

const agentGuideSchema = z.object({
  appName: z.string(),
  aliases: z.array(z.string()),
  website: z.string(),
  composio: z.object({
    managedOAuth: z.enum(["yes", "no", "unknown"]),
    whenToBringYourOwn: z.array(z.string()),
    claimIds: z.array(z.string()),
  }),
  verdict: z.object({
    oneLiner: z.string(),
    blockerType: blockerTypeSchema,
    difficulty: z.number().int().min(1).max(5),
    readyIn: z.object({ min: z.string(), typical: z.string(), worst: z.string() }),
    claimIds: z.array(z.string()),
  }),
  criticalPath: z.array(
    z.object({ action: z.string(), why: z.string(), claimIds: z.array(z.string()) }),
  ),
  beforeApproval: z.object({
    whatWorks: z.string(),
    limits: z.array(z.string()),
    claimIds: z.array(z.string()),
  }),
  steps: z.array(
    z.object({
      title: z.string(),
      detail: z.string(),
      actor: actorSchema,
      whyHuman: z.string().optional(),
      estTime: z.string().optional(),
      claimIds: z.array(z.string()),
    }),
  ),
  config: z.object({
    portalUrl: z.string(),
    redirectUriNotes: z.string(),
    scopes: z.array(
      z.object({
        name: z.string(),
        purpose: z.string(),
        reviewLevel: reviewLevelSchema,
      }),
    ),
    otherFields: z.array(z.string()),
  }),
  review: z.object({
    requiredWhen: z.string(),
    process: z.array(z.string()),
    timeline: z.string(),
    cost: z.string(),
    recurring: z.string(),
    claimIds: z.array(z.string()),
  }),
  gotchas: z.array(z.object({ text: z.string(), claimIds: z.array(z.string()) })),
  composioHandoff: z.array(z.string()),
  claims: z.array(
    z.object({
      id: z.string(),
      text: z.string(),
      status: claimStatusSchema,
      // Models routinely omit this on claims that have no sources, which is a
      // correct thing to mean. validate() still rejects a "sourced" claim with none.
      sources: z.array(sourceSchema).default([]),
      note: z.string().optional(),
    }),
  ),
  openQuestions: z.array(z.string()),
});

type AgentGuide = z.infer<typeof agentGuideSchema>;

const discoverySchema = z.object({
  urls: z.array(z.object({ url: z.string(), topic: z.string().optional() })),
});

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function parseJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("Model did not return JSON.");
  return JSON.parse(trimmed.slice(start, end + 1));
}

async function withRetry<T>(
  label: string,
  call: (signal: AbortSignal) => Promise<T>,
  onRetry: (message: string) => void,
  deadline: AbortSignal,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    if (deadline.aborted) {
      throw new Error(`${label} ran out of time (${WALL_CLOCK_MS / 1000}s budget).`);
    }
    try {
      return await call(
        AbortSignal.any([deadline, AbortSignal.timeout(PER_CALL_TIMEOUT_MS)]),
      );
    } catch (error) {
      lastError = error;
      if (deadline.aborted) {
        throw new Error(`${label} ran out of time (${WALL_CLOCK_MS / 1000}s budget).`);
      }
      const retryable = error instanceof GroqError && error.retryable;
      if (!retryable || attempt === RETRY_ATTEMPTS) break;

      const asked =
        error instanceof GroqError && error.retryAfterSec
          ? Math.ceil(error.retryAfterSec * 1000) + 500
          : 0;
      const delay = Math.min(Math.max(asked, RETRY_BASE_MS * attempt), MAX_RETRY_MS);
      onRetry(
        `${label} hit the per-minute token limit — waiting ${Math.round(delay / 1000)}s…`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

function assemble(draft: AgentGuide, composio: ComposioCheck): Guide {
  // When the managed-OAuth answer comes from parsed data rather than the model,
  // it arrives with no claim behind it — leaving the guide's most decision-relevant
  // field as the one assertion a reader cannot check. This records how it was
  // determined, citing the page the check actually read.
  const claims = [...draft.claims];
  const composioClaimIds = [...draft.composio.claimIds];

  if (composio.authoritative && composio.source) {
    const used = new Set(claims.map((claim) => claim.id));
    let n = claims.length + 1;
    while (used.has(`c${n}`)) n++;
    const id = `c${n}`;

    claims.push({
      id,
      text: composio.detail,
      status: "sourced",
      sources: [composio.source],
    });
    composioClaimIds.unshift(id);
  }

  return {
    ...draft,
    claims,
    composio: {
      ...draft.composio,
      // Both the API and the public toolkit page expose composioManagedAuthSchemes
      // directly, so when either was read the answer comes from data, not from a
      // model's reading of a truncated excerpt — which got this backwards. The
      // model's value only stands when neither could be parsed.
      managedOAuth: composio.authoritative
        ? composio.managedOAuth
        : draft.composio.managedOAuth,
      claimIds: composioClaimIds,
    },
    slug: slugify(draft.appName),
    lastChecked: new Date().toISOString().slice(0, 10),
    generatedBy: "agent",
    verdict: {
      ...draft.verdict,
      difficulty: draft.verdict.difficulty as 1 | 2 | 3 | 4 | 5,
    },
  };
}

function validate(guide: Guide, allowedUrls: Set<string>): string[] {
  const errors: string[] = [];

  const parsed = guideSchema.safeParse(guide);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      errors.push(`${issue.path.join(".")}: ${issue.message}`);
    }
  }

  const known = new Set(guide.claims.map((claim) => claim.id));
  const referenced: [string, string[]][] = [
    ["composio.claimIds", guide.composio.claimIds],
    ["verdict.claimIds", guide.verdict.claimIds],
    ["beforeApproval.claimIds", guide.beforeApproval.claimIds],
    ["review.claimIds", guide.review.claimIds],
    ...guide.criticalPath.map(
      (item, i) => [`criticalPath[${i}].claimIds`, item.claimIds] as [string, string[]],
    ),
    ...guide.steps.map(
      (step, i) => [`steps[${i}].claimIds`, step.claimIds] as [string, string[]],
    ),
    ...guide.gotchas.map(
      (item, i) => [`gotchas[${i}].claimIds`, item.claimIds] as [string, string[]],
    ),
  ];

  for (const [path, ids] of referenced) {
    for (const id of ids) {
      if (!known.has(id)) errors.push(`${path}: "${id}" does not exist in claims`);
    }
  }

  for (const claim of guide.claims) {
    if (claim.status === "tested") {
      errors.push(
        `claims.${claim.id}: status "tested" is not allowed for generated guides — nothing here was tested by a human`,
      );
    }
    for (const source of claim.sources) {
      if (!allowedUrls.has(source.url)) {
        errors.push(
          `claims.${claim.id}: source "${source.url}" was not among the pages fetched — cite only the listed sources`,
        );
      }
    }
  }

  return errors;
}

export async function* generateGuide(query: string): AsyncGenerator<ProgressEvent> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY is not configured.");

  const deadline = AbortSignal.timeout(WALL_CLOCK_MS);
  const notices: string[] = [];
  const note = (message: string) => void notices.push(message);
  const drain = (): ProgressEvent[] =>
    notices.splice(0).map((message) => ({ type: "warning", message }));

  yield { type: "stage", message: `Resolving "${query}"…` };
  yield { type: "stage", message: "Checking Composio managed auth…" };
  const composio = await checkComposio(toolkitSlugCandidates(query));

  yield { type: "stage", message: "Finding official documentation…" };
  const discovery = await withRetry(
    "Discovery",
    (signal) =>
      groqChat(apiKey, {
        model: DISCOVERY_MODEL,
        maxTokens: DISCOVERY_MAX_TOKENS,
        json: true,
        signal,
        messages: [
          { role: "system", content: DISCOVERY_SYSTEM },
          { role: "user", content: discoveryPrompt(query) },
        ],
      }),
    note,
    deadline,
  );
  yield* drain();

  const candidates = discoverySchema
    .parse(parseJson(discovery.text))
    .urls.map((entry) => entry.url)
    .filter((url) => /^https?:\/\//.test(url))
    .slice(0, MAX_URLS);

  if (candidates.length < MIN_URLS) {
    yield {
      type: "warning",
      message: `Discovery returned only ${candidates.length} URL(s) — the guide may be thin.`,
    };
  }
  if (candidates.length === 0) throw new Error("No candidate documentation URLs found.");

  // The Composio page is half a megabyte and its managed-auth field is already
  // parsed by checkComposio, so it is not re-fetched here — that spent one of only
  // four document slots to show the model an unrelated FAQ excerpt. It is still
  // citable below, because the check genuinely retrieved it.
  const toRead = candidates;
  for (const url of toRead) yield { type: "fetch", url };

  // Pages are fetched here rather than by a model tool, so the citation
  // allow-list is built from HTTP statuses we saw ourselves.
  yield { type: "stage", message: "Reading documentation…" };
  const docs = await fetchDocs(toRead);
  for (const url of toRead) {
    const hit = docs.find((doc) => doc.url === url);
    yield { type: "fetch", url: hit?.finalUrl ?? url, ok: Boolean(hit) };
  }

  if (docs.length === 0) {
    throw new Error("None of the candidate documentation pages could be read.");
  }

  const used = docs.slice(0, MAX_DOCS_IN_PROMPT);
  const sources: Source[] = used.map((doc) => ({
    url: doc.finalUrl,
    title: doc.title,
  }));
  if (composio.source) sources.push(composio.source);
  const allowedUrls = new Set(sources.map((source) => source.url));

  yield { type: "stage", message: "Synthesising the guide…" };
  const baseMessages: GroqMessage[] = [
    { role: "system", content: SYNTHESIS_SYSTEM },
    { role: "user", content: synthesisPrompt(query, composio, used) },
  ];

  const response = await withRetry(
    "Synthesis",
    (signal) =>
      groqChat(apiKey, {
        model: MODEL,
        maxTokens: SYNTHESIS_MAX_TOKENS,
        json: true,
        signal,
        messages: baseMessages,
      }),
    note,
    deadline,
  );
  yield* drain();

  yield { type: "stage", message: "Validating claims…" };

  // Groq's JSON mode does not enforce a schema, so a malformed field is likely
  // enough that shape errors have to reach the repair pass rather than throwing.
  // The previous code parsed strictly here, which meant repair only ever saw
  // citation and claim-reference problems.
  let draft: AgentGuide | null = null;
  let guide: Guide | null = null;
  let errors: string[] = [];

  const first = agentGuideSchema.safeParse(parseJson(response.text));
  if (first.success) {
    draft = first.data;
    guide = assemble(draft, composio);
    errors = validate(guide, allowedUrls);
  } else {
    errors = first.error.issues.map(
      (issue) => `${issue.path.join(".")}: ${issue.message}`,
    );
  }

  if (errors.length > 0) {
    yield {
      type: "warning",
      message: `Validation found ${errors.length} problem(s) — repairing.`,
    };
    const repair = await withRetry(
      "Repair",
      (signal) =>
        groqChat(apiKey, {
          model: MODEL,
          maxTokens: SYNTHESIS_MAX_TOKENS,
          json: true,
          signal,
          messages: [
            { role: "system", content: SYNTHESIS_SYSTEM },
            {
              role: "assistant",
              content: draft ? JSON.stringify(draft) : response.text,
            },
            { role: "user", content: repairPrompt(errors.join("\n"), sources) },
          ],
        }),
      note,
      deadline,
    );
    yield* drain();

    const repaired = agentGuideSchema.safeParse(parseJson(repair.text));
    if (repaired.success) {
      draft = repaired.data;
      guide = assemble(draft, composio);
      errors = validate(guide, allowedUrls);
    } else {
      errors = repaired.error.issues.map(
        (issue) => `${issue.path.join(".")}: ${issue.message}`,
      );
    }
  }

  if (!guide || errors.length > 0) {
    throw new Error(`Generated guide failed validation:\n${errors.slice(0, 8).join("\n")}`);
  }

  yield { type: "done", guide };
}

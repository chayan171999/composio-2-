import type { Source } from "@/lib/schema";
import type { FetchedDoc } from "./fetchDocs";
import type { ComposioCheck } from "./types";

export const DISCOVERY_SYSTEM = `You know where official developer documentation lives. Given an app or company name, list the most likely URLs of its official OAuth / app-registration documentation.

Rules:
- Only the provider's own documentation domains (e.g. docs.github.com, api.slack.com, developers.google.com). No blogs, no aggregators, no Stack Overflow.
- Prefer stable, canonical documentation paths over deep links that churn.
- Cover these topics, one URL each where you can: creating/registering an OAuth app, the OAuth scopes reference, the app review or verification policy, and the developer portal itself.
- Give exactly 5 or 6 URLs. Fewer than 5 is a failed answer. List the most likely to be correct first. Real URLs only — if unsure of an exact path, give the documentation section's index page rather than inventing a deep link.

Reply with JSON only: {"urls": [{"url": "https://...", "topic": "..."}]}`;

export function discoveryPrompt(query: string): string {
  return `App or company: "${query}"

List the official documentation URLs to read.`;
}

// The schema is described in prose rather than as JSON Schema: Groq's JSON mode
// does not enforce a schema, and a full schema costs more tokens than the free
// tier's per-minute budget comfortably allows.
const SHAPE = `{
  "appName": string,
  "aliases": string[],                       // lowercase alternatives a developer might type, incl. bare domains
  "website": string,
  "composio": { "managedOAuth": "yes"|"no"|"unknown", "whenToBringYourOwn": string[], "claimIds": string[] },
  "verdict": {
    "oneLiner": string,                      // the answer in one sentence
    "blockerType": "none"|"scope_review"|"business_verification"|"partner_gated"|"paid_plan"|"other",
    "difficulty": 1|2|3|4|5,
    "readyIn": { "min": string, "typical": string, "worst": string },
    "claimIds": string[]
  },
  "criticalPath": [ { "action": string, "why": string, "claimIds": string[] } ],   // max 4
  "beforeApproval": { "whatWorks": string, "limits": string[], "claimIds": string[] },
  "steps": [ { "title": string, "detail": string, "actor": "agent"|"human"|"either", "whyHuman"?: string, "estTime"?: string, "claimIds": string[] } ],
  "config": {
    "portalUrl": string,
    "redirectUriNotes": string,
    "scopes": [ { "name": string, "purpose": string, "reviewLevel": "none"|"sensitive"|"restricted"|"app_review"|"unknown" } ],
    "otherFields": string[]
  },
  "review": { "requiredWhen": string, "process": string[], "timeline": string, "cost": string, "recurring": string, "claimIds": string[] },
  "gotchas": [ { "text": string, "claimIds": string[] } ],
  "composioHandoff": string[],
  "claims": [ { "id": "c1", "text": string, "status": "sourced"|"inferred"|"unverified", "sources": [{"url": string, "title": string}], "note"?: string } ],
  "openQuestions": string[]
}`;

export const SYNTHESIS_SYSTEM = `You turn official documentation into a structured OAuth setup guide for developers using Composio.

You are given the text of pages that were actually fetched. Work only from them.

EVIDENCE
- Every factual statement is a claim with an id ("c1", "c2", ...), one sentence of text, and a status.
- "sourced" = directly supported by one of the supplied pages. Must cite that page's URL, copied exactly from the SOURCES list.
- "inferred" = your reasoning from what the pages say. Requires a note. No source.
- "unverified" = the pages do not cover it. Requires a note. No source.
- NEVER use status "tested". Nothing here was tested by a human.
- Cite ONLY URLs from the SOURCES list, copied exactly. Any other URL is rejected.
- Every claimIds entry elsewhere must reference an id that exists in "claims".

TIMELINES
- If the pages publish no timeline, say so explicitly in review.timeline and back it with an "unverified" claim. Never present an anecdotal figure as official.

STEPS
- actor "human" for anything needing login, 2FA, CAPTCHA, legal entity details, payment, or submitting for review. Set whyHuman for every human step.
- actor "agent" only for research or decision work an AI agent can genuinely do alone.
- actor "either" when the developer may delegate it.

CRITICAL PATH
- Maximum 4 items, each startable today, chosen so approval waits run in parallel with building.

READY IN
- readyIn must agree with blockerType. When blockerType is "none" there is no review to wait for, so these are active setup times (minutes or hours), not calendar days. Only use days or weeks when something is actually being waited on, and say what.

OTHER
- blockerType: "none" self-serve, "scope_review" review triggered by requested scopes, "business_verification" identity/legal checks, "partner_gated" partner programme, "paid_plan" paid tier required, "other".
- openQuestions: everything the supplied pages did not cover. Do not hide gaps.

Reply with JSON only, in exactly this shape:
${SHAPE}`;

export function synthesisPrompt(
  query: string,
  composio: ComposioCheck,
  docs: FetchedDoc[],
): string {
  return `Developer searched for: "${query}"

Composio managed OAuth check (authoritative — use this for composio.managedOAuth):
status: ${composio.managedOAuth}
${composio.detail}

SOURCES (the only URLs you may cite, copy them exactly):
${docs.map((doc) => `- ${doc.finalUrl} | ${doc.title}`).join("\n")}

PAGE CONTENT
${docs
  .map(
    (doc, i) => `
[${i + 1}] ${doc.finalUrl}
${doc.text}`,
  )
  .join("\n")}

Produce the guide JSON now.`;
}

export function repairPrompt(errors: string, sources: Source[]): string {
  return `That guide failed validation:

${errors}

Produce a corrected guide as JSON. Fix only what the errors describe. Remember:
- every claimIds entry must reference an id that exists in "claims"
- a "sourced" claim must cite at least one URL, copied exactly from this list:
${sources.map((source) => `  ${source.url}`).join("\n")}
- status "tested" is never allowed`;
}

# Do you need your own OAuth app?

**Live: https://composio-2.vercel.app**

A developer building on Composio hits a question that is surprisingly hard to
answer: *do I need to register my own OAuth app with this provider, and if so,
how long until I can ship?* The answer ranges from ten minutes to six weeks plus
a paid security audit, and you usually find out which only after you are
committed.

This looks an app up and answers, in about thirty seconds:

1. Do you need your own OAuth app at all, or is Composio's managed OAuth enough?
2. How long until production, and what kind of blocker stands in the way?
3. What can you start **today** so approval waits run in parallel with building?
4. Which steps can an agent do, and where must a human take over?
5. How confident is each claim, and what is the source?

Three guides are hand-verified. Anything else is researched live by an agent.

> This is the second implementation. The first runs the same product on the
> Gemini API, whose free tier allows ~20 model requests a day — about five
> generations before the demo stops working. This one runs on Groq and fetches
> documentation itself, which is roughly six times faster per guide and lifts the
> ceiling from a daily wall to a per-minute pace. The trade-off is real and is
> described under [Limits](#limits).

---

## Quick start

```bash
npm install
cp .env.example .env.local   # then fill in GROQ_API_KEY
npm run dev
```

Only `GROQ_API_KEY` is required — free at
[console.groq.com/keys](https://console.groq.com/keys), no billing account.
Everything else is optional:

| Variable | Purpose |
| --- | --- |
| `GROQ_API_KEY` | **Required.** Powers the agent. Server-side only; never sent to the browser. |
| `GROQ_MODEL` | Model that reads documentation and labels evidence. Default `openai/gpt-oss-120b`. |
| `GROQ_DISCOVERY_MODEL` | Model that lists candidate documentation URLs. Default `openai/gpt-oss-120b`. |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | Upstash Redis, so generated guides get shareable URLs. Provisioned automatically by Vercel's Upstash integration. |
| `COMPOSIO_API_KEY` | Not needed. The managed-auth check reads Composio's public toolkit page instead; see below. |

Without Upstash, generated guides fall back to a local `.data/` file. That works
in development but **not** on Vercel, whose filesystem is read-only — a generated
guide will render once and then be gone.

---

## Key decisions

**The blocker type and the critical path lead the guide.** Most integration docs
are ordered by the provider's process. That is the wrong order for someone
deciding whether to start. What a developer needs first is the shape of the
obstacle, because that determines whether this is an afternoon or a quarter. The
critical path follows, capped at four items chosen so approval waits run in
parallel with building.

**Composio's managed status is the first question, not a footnote.** The most
valuable answer this can give is often "you don't need to do any of this."

**Evidence is per-claim, not per-page.** A guide that is 90% accurate is
dangerous if you cannot tell which 90%. Every factual statement is a claim with
an id, a status (`tested` / `sourced` / `inferred` / `unverified`), its sources,
and the date checked. An estimate never renders as confirmed fact.

**Only three seed guides, on purpose.** The slow part is not writing the JSON —
it is reading primary sources and being honest about what they do and do not say.
They cover three different blocker types: GitHub needs no review, Google gates on
which scopes you request, Meta gates on your legal identity.

**Nothing an agent produces may claim to be `tested`.** That status is reserved
for things a human actually did, and validation rejects it outright.

---

## How the agent works

Two model calls and a fetch, streamed to the browser over SSE.

1. **Discovery** — propose up to 6 likely official documentation URLs for the app.
2. **Fetch** — retrieve those pages **in our own code**, strip the HTML, and keep
   the part that talks about registration, scopes and review.
3. **Composio check** — read `composioManagedAuthSchemes` from Composio's public
   toolkit page. Deterministic, and needs no API key.
4. **Synthesise** — turn the page text into the guide schema as JSON, validated
   with Zod, with one repair attempt on failure.

### Why it fetches pages itself

Groq's Compound systems carry a Visit Website tool, but they are not available on
a free account. `browser_search` is, and it works — but it costs about **65,000
tokens per call** against an **8,000-token per-request cap**, roughly fifty times
what fetching the same page costs directly.

Doing the retrieval ourselves turned out better than a provider tool anyway:

- The citation allow-list is built from **HTTP statuses we saw**, not a model's
  report of what it read.
- Nothing depends on one vendor's retrieval feature, so changing model is a
  config change.

### What stops it inventing things

Prompting is not a guarantee, so the constraints are enforced in code:

- **Citations are an allow-list** built from the pages that actually returned 200.
  A URL that 404s cannot be cited.
- **Generated guides may never claim `tested`.**
- **Dangling claim references are rejected** — every reference must resolve.
- **A `sourced` claim must cite a source**, and that source must be on the list.

Anything failing these goes back for one repair pass, which sees schema errors as
well as citation ones — Groq's JSON mode does not enforce a schema, so malformed
output is common enough that it has to be repairable rather than fatal.

### The Composio check needs no credential

Composio's public toolkit page embeds `composioManagedAuthSchemes` — the same
field the authenticated API returns — so the answer is read from data rather than
inferred. Asking a model to judge it from a page excerpt got it **backwards**:
that page is over 500k characters, the excerpt window is 2.2k, and what the model
saw was the FAQ entry about setting up *custom* credentials.

The parsed answer carries its own sourced claim naming the field and the page, so
a reader can check it. If the field cannot be parsed the check returns `unknown`
rather than guessing.

---

## Limits

**Requests are capped at 8,000 tokens, including the output.** This is the
binding constraint and it shapes the whole design: documentation excerpts are
trimmed to ~550 tokens each and at most four pages reach the model. That is less
raw material than the Gemini implementation reads, and it shows — on one Zoom run
the agent reported `blocker: none` where the honest answer is `scope_review`,
having not retrieved the Marketplace review pages. **A guide can miss a blocker.**

**Rate limits are per-minute, not per-day.** A generation costs roughly 6–8k
tokens, so the practical pace is about one a minute, indefinitely. Retries wait
as long as the server asks rather than guessing a backoff.

**The rate limiter is per-process.** On Vercel each serverless instance keeps its
own counter, so the real limit is looser than it looks.

**There is no self-review pass.** Hallucination is mitigated structurally, by the
allow-list and schema validation above, rather than by asking a second model
whether the first was honest.

**Generated guides are not hand-checked.** They are labelled as machine-extracted
with the date, and the evidence is there to audit.

**Agent/human step classification is the model's judgement.** It follows an
explicit rule — anything needing login, 2FA, CAPTCHA, legal entity details,
payment or a review submission is human — but it is not verified per step.

---

## Deviations from the brief

**Groq instead of the Anthropic API.** The brief specified Anthropic with its
server-side web search tool. Anthropic has no free tier, and avoiding paid
accounts was a harder constraint. The first implementation moved to Gemini for
that reason; this one moved to Groq because Gemini's ~20 requests/day made the
live demo fragile.

**Our own fetching instead of a search tool.** Covered above: the free retrieval
tools are either unavailable or cost 50× what a direct fetch does, and doing it
ourselves makes the citation allow-list stronger.

---

## Verification

See [`docs/verification.md`](docs/verification.md) for the full log, including
two corrections the seed research needed (Google's own documentation puts the
CASA assessment fee at $500–$4,500, not the ~$540–$3,000 a third-party source
claimed, and a cited URL had gone dead) and what was deliberately left
unverified.

---

## Out of scope

All 100 toolkits; user accounts or auth; actually completing any provider's
approval process; and a browser-automation agent that registers OAuth apps.
Claims about what is "tested" cover only what a free account can reach.

---

## What I'd do next

**Spend the token budget better.** The 8k cap is the main quality constraint.
Ranking page sections by relevance before trimming — rather than taking the first
window that matches a keyword — would get more signal into the same budget, and
is the most likely fix for missed blockers like the Zoom case above.

**Scale the library with a review queue.** Batch-generate across toolkits, publish
as drafts, promote once claims are spot-checked. The evidence model already makes
that reviewable: a reviewer reads the claims, not the prose.

**Freshness checks.** Every claim carries a URL and a check date, so a scheduled
job could re-fetch sources, diff them, and flag guides whose evidence moved. One
source URL already died during this build.

**A browser agent for the setup attempt**, which would turn `inferred` time
estimates into `tested` ones — the one evidence status nothing currently earns.

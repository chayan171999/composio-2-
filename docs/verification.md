# Verification log

What was checked against primary sources, what turned out to be wrong, and what
remains uncertain. Every entry here was verified by a human reading the cited page,
not by the agent.

## Seed guide research corrections

**CASA assessment cost — corrected.**
Initial research quoted roughly $540–$3,000+, attributed to Nango (Aug 2025).
Google's own documentation states the fee is payable to the third-party assessor and
ranges from **$500 to $4,500 USD** depending on app complexity. The first-party figure
replaced the third-party one in `google-gmail.json` (claim `c5`), with the check date
recorded in the claim note.
Source: https://developers.google.com/health/app-verification (checked 2026-10-20)

**Nango source URL — dead link, relocated.**
`https://docs.nango.dev/integrations/google-security-review` returns 404. The page now
lives at `https://nango.dev/docs/api-integrations/google-shared/google-security-review`.
Claim `c7` cites the working URL. Citing a 404 would have been worse than not citing.

**CASA duration — added from a first-party source.**
Initial research said "~6 weeks" without distinguishing tiers. Google states 2–3 weeks
for tier-2 and 4–6 weeks for tier-3 applications. Both figures are now in claim `c4`
and the review timeline.

**Google verification timelines — confirmed.**
Brand verification 2–3 business days and sensitive scope verification 10 business days
both confirmed against Google's own FAQ, which presents them as expected completion
times rather than guarantees. That caveat is recorded as claim `c11`.
Source: https://support.google.com/cloud/answer/13463817?hl=en (checked 2026-10-20)

**Meta review timeline — deliberately left unverified.**
No stated SLA for App Review or Business Verification was found in Meta's own
documentation. Rather than quote an anecdotal community figure, claim `c10` is marked
`unverified` with a note, and the verdict's `readyIn` says "Unknown" outright.

**All seed source URLs checked.** Every URL cited across the three seed guides returns
200 as of 2026-10-20, except the Nango link noted above, which was replaced.

## Agent output verification

**Zoom (generated 2026-10-20) — spot-checked, no hallucination found.**
Four claims were checked by fetching the cited page and reading it:

| Claim | Cited page says |
| --- | --- |
| Access tokens expire after 1 hour | "Access tokens expire after one hour" ✅ |
| Refresh tokens expire in 90 days and rotate | "Refresh tokens expire after 90 days. You should always use the latest refresh token" ✅ |
| Loopback URIs require PKCE | PKCE section present and consistent ✅ |
| Deauthorization endpoint required | Deauthorization section present ✅ |

Source checked: https://developers.zoom.us/docs/integrations/oauth/

**Failed retrievals become open questions, not invented content.**
In the Zoom run, four of eight proposed documentation URLs failed to retrieve. The
agent did not fabricate their contents; the missing topics (REST API rate limits,
security audit fees) appear in `openQuestions`. This is enforced structurally: the
citation allow-list is built from `urlContextMetadata` retrieval successes, so a page
that was never fetched cannot be cited.

## Structural guarantees

These are enforced in code rather than by prompting, and a guide that violates them is
rejected and sent back for one repair pass:

- A generated guide can never carry `tested` status. Nothing in an agent run was
  verified by a human, so the status is rejected outright.
- Every `claimIds` reference must resolve to a claim that exists.
- A `sourced` claim must cite at least one URL, and that URL must be one the agent
  actually retrieved.

## Agent implementation

This repository runs the agent on Groq, fetching documentation pages in its own
code. The model-selection notes below were recorded against the first
implementation, which used Gemini; they are kept because they are what motivated
splitting cheap and quality-critical steps, and the same reasoning applies here.

**The Composio managed-auth check needs no API key.** Composio's public toolkit
page embeds `composioManagedAuthSchemes`, the same field the authenticated API
returns, so the answer is parsed from data. Asking a model to read it from a page
excerpt produced the wrong answer consistently: the page is over 500k characters
and the 2.2k excerpt window landed on the FAQ entry about configuring *custom*
credentials. Verified correct against slack, zoom, notion, github, gmail, figma
and linear; an unknown slug 404s and returns "unknown" rather than a guess.

**A guide can miss a blocker.** Groq's free tier caps a request at 8k tokens
including output, so at most four pages of ~550 tokens reach the model. On one
Zoom run the agent reported `blocker: none` where the honest answer is
`scope_review`, having not retrieved the Marketplace review pages. This is the
clearest known quality cost of the tighter budget.

## Model selection (first implementation, Gemini)

**Flash-Lite was measured and rejected for the quality-critical steps.** The same
app (Slack) was generated twice, once entirely on `gemini-3.5-flash` and once
entirely on `gemini-3.1-flash-lite`:

| | Flash | Flash-Lite |
| --- | --- | --- |
| Sourced claims | 9 | 5 |
| Inferred / unverified | 1 | 5 |
| Steps / gotchas | 4 / 3 | 3 / 2 |
| Time | 72s | 50s |

Flash-Lite was faster but produced vaguer claims, and marked at least one fact
(`scopes are additive and cannot be reduced without token revocation`)
`unverified` that Flash cited correctly from the same page — it left evidence on
the table. It failed safely rather than fabricating, but the guides were thinner.

URL discovery now runs on Flash-Lite, whose free tier is far larger (~500
requests/day against ~20), while reading and synthesis stay on Flash.

**This split has not been verified end to end.** A run on the current
configuration got through discovery on Flash-Lite and page-reading on Flash — and
correctly flagged two 404s — before Flash's daily quota ran out at the synthesis
call. So the split is known to work mechanically, but its output has never been
compared against the all-Flash baseline. Closing this needs roughly three Flash
calls in a fresh quota window.

**Free-tier quota is scoped to the Google project, not the API key.** Quota was
observed already exhausted on a newly issued key, so rotating keys does not
reclaim it.

## Known gaps

- **No seed claim is marked `tested`.** Nobody on this project has registered a test
  OAuth app end to end, so the GitHub guide's "~10 minutes" estimate remains `inferred`
  and its open question records that.
- **CASA free tier-2 route unconfirmed.** Sources disagree on whether a no-cost
  self-assessment path still exists; Google's documentation does not state it clearly.
- **Only one generated guide was spot-checked in depth** (Zoom). Slack and Figma were
  reviewed for structure and plausibility but not line-by-line against their sources.

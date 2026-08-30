---
name: icp-profile
description: Writes the ideal customer profile description that the GTM engine stores in icp.doc and searches from. Use when onboarding a seller onto algo-backend, when given a seller's domain, proposal, deck or brief and asked who they should target, or when an existing profile returns competitors, stale evidence or the wrong company size and needs rewriting.
---

# Write an ICP for the engine

The output is one plain-text description. The engine stores it in `icp.doc`
as `{"description": "..."}` and the synthesizer reads it every round to
choose a source, a search type, a freshness window and the query.

## Gather

Use whatever the seller gave. A domain is enough; a proposal or deck adds the
segments and pricing a site leaves out.

```bash
# from the repo root, needs EXA_API_KEY in .env
bun .claude/skills/icp-profile/scripts/read-seller.mjs <domain> > /tmp/seller.txt
```

The script runs one deep Exa search over that domain only, with ten query
variations and a live crawl, and prints the pages as text. About $0.012.

Read any supplied file as well. Look hardest for **named customers**: a page
listing real customers is worth more than every adjective on the site, because
it fixes the buyer test that everything else depends on.

## Write

Read `references/structure.md` before writing. It has the four blocks, the
two rules the engine depends on, and the four questions worth asking a human.

Keep it to roughly 1500 to 2500 characters. Longer stops helping.

## Check before storing

- Would this exclude the seller's own named customers? Then the buyer test is wrong.
- Does every signal carry a window in days?
- Does any institution sentence describe an event, or any signal sentence describe a company?
- Are competitors excluded as a category, by who their customers are, rather than by name?
- Would a stranger reading only this recognise a qualifying company?

## Store and run

```sql
INSERT INTO icp (organization_id, domain, doc)
VALUES ('<org>', '<seller domain>', '{"description": "<the text>"}'::jsonb)
RETURNING id;
```

```http
POST /companies/find
{"icpId": "<id>", "count": 10}
```

Then read `GET /runs/:runId/rounds`. Each round stores the plan it chose and
the reason for every refusal, which is how a weak profile shows itself: many
`judge` refusals for fit means the buyer test is loose, many `filter`
refusals for age means a window is too narrow.

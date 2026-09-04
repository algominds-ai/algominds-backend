# The Braintrust company eval

Scores a companies run against a human-labelled answer key from plain Bun,
into the `algo-backend` Braintrust project.

## What it measures

A verdict (`eval/headline.ts`, `computeVerdict`) ranks a run lexicographically:

1. **Six correctness gates**, all must hold: no key-rejected company stored,
   no two stored companies share a key organisation group, every hard page
   requirement proven where demanded, every stored record has a domain and
   a name, and the run finished under the profile's cost and wall-clock bars.
2. **Cost per stored company**, lower wins.
3. **Seconds per stored company**, lower wins.

**Precision** — key-accepted companies stored, divided by labelled stored
companies (`eval/scorers.ts`) — is a reported score, never a rank.

## Running an arm

```
bun run eval [--profile <slug>] [--arm <name>] [--trials <n>]
```

Seeds an isolated `eval_<arm>` database, one organisation and API key per
trial, starts `wrangler dev` (or calls `EVAL_API_URL`), and scores each trial
with `gatesPass` and `precision` against `eval/keys/<slug>.json`. Once
`Eval()` finishes it reseeds every key file and prints each stored
company's `domain:label` on its trial's line.

## Labelling keys

```
bun run eval:label <slug> [--seed-only] [--arm <arm>]
```

Without `--seed-only`, prompts for each unlabelled company: `accept`,
`reject:<category>`, `same-as:<domain>`, or blank to skip.

# The Braintrust company eval: labelling, running an arm, and reading a verdict

The eval engine scores a companies run against a human-labelled answer key. It
never scores against a model's own judgment of itself. Everything lives under
`eval/`, runs from plain Bun (not inside a Worker), and writes its own
Braintrust project, `algo-backend`.

## Labelling ground truth

`bun run eval:label <profile>` seeds the profile's key file at
`eval/keys/<profile>.json` from every company already stored for that
profile's `icpId`, then — in an interactive terminal — prints each unlabelled
company's record and asks for a label:

- `accept` — the company belongs in the key's accepted set.
- `reject:<category>` — the company should not have been stored, filed under
  a short reason category (`reject:not-a-company`, `reject:too-small`, and so
  on; any lower-case, hyphenated category works).
- `same-as:<domain>` — this domain is the same organisation as `<domain>`,
  already in the key. A run that stores both domains fails the
  no-duplicate-organisation-group gate.
- blank — skip for now; the company stays unlabelled and does not count
  toward coverage in either direction.

`bun run eval:label <profile> --seed-only` writes the key file and reports
counts without opening the interactive prompt — useful in a script or when
stdin is not a TTY, where the labelling loop is skipped automatically anyway.

The key file is the only source of truth a verdict reads. No model ever
writes a label into it.

## Running an arm

```
bun run eval [--profile <slug>] [--arm <name>] [--trials <n>]
```

- `--profile` — one profile slug (`mstone`, `aris`, `form3`, `carta`,
  `dental`, `hvac`). Omit it to run every profile.
- `--arm` — a name for this experiment's isolated database and Braintrust
  experiment, for example `candidate-batching`. Defaults to `baseline`.
- `--trials` — repeated trials per profile, at least `MIN_TRIALS` (2).
  Defaults to 2.

One call to `bun run eval`:

1. Syncs each selected profile's `key-<slug>` Braintrust dataset from its
   key file (`eval/datasets.ts`) and records the version it holds.
2. Drops and recreates `eval_<arm>`, migrated to the current schema
   (`eval/arm-db.ts`, the same drop-create-migrate recipe `db:test:reset`
   uses for `algo_test`).
3. Seeds one organisation, one API key and one frozen `icp` row per profile
   per trial into that database. Every trial gets its own organisation so one
   trial's seen-domains window cannot exclude a second trial's candidates.
   The frozen profile documents live at `eval/arm-seed/<slug>.json` and are
   parsed once through `eval/icp-doc.ts` — a document fixed for the eval
   regardless of what the shared dev database currently holds for the same
   `icpId`.
4. Starts `wrangler dev` against `eval_<arm>` (or, with `EVAL_API_URL` set,
   calls that URL instead and skips starting a server — use this to point
   the eval at an already-running instance).
5. Starts a companies run for every seeded trial, waits for it to reach a
   terminal status, reads the run, its stored companies and its round
   diagnostics back from the database, and scores it against the profile's
   key file.
6. Records one Braintrust experiment named `<commit>-<arm>` in the
   `algo-backend` project, with `gates_pass` and `qualified_coverage` as its
   scores.
7. Writes the complete manifest to `eval/runs/<commit>-<arm>.json`: config
   hash, dataset snapshot id per profile, scorer prompt hashes, resolved
   model ids, every run id by profile, spend, and the winner rule.

The engine stops spending before it starts a trial that would push total
spend past `MAX_SPEND_DOLLARS` ($8) or that profile's spend past
`MAX_PROFILE_SPEND_DOLLARS` ($2). A trial the budget blocks is skipped, not
run — its Braintrust scores come back `null`, and the printed line says which
cap it hit.

## Reading a verdict

A verdict is lexicographic, computed in `eval/headline.ts`. Earlier terms
settle the comparison; later terms only break a tie:

1. **Correctness gates**, all must hold: no key-rejected company stored, no
   two stored companies resolve to the same key organisation group, every
   hard page requirement's proof holds where the profile demands one, every
   stored record has a domain and a name, and the run finished under the
   profile's own cost and wall-clock bars.
2. **Qualified coverage** — key-accepted companies this run stored, divided
   by the key's total accepted count. `null` when the key has no accepted
   companies yet, which happens before any labelling round.
3. **Cost per stored company**, lower wins.
4. **Seconds per stored company**, lower wins.

Per-round route, funnel, marginal yield, seconds and dollars are diagnostics
read alongside a verdict (`eval/read.ts`'s `readRoundDiagnostics`) and never
enter the comparison — they explain a verdict, they do not decide one.

An unlabelled stored company counts toward neither correctness nor coverage.
`verdict.unlabelledStoredCount` says how many showed up so the next labelling
pass knows what to look at.

## Datasets and the scorer registry

`bun run eval:datasets [<profile>]` pushes every entry of a profile's key
file into a Braintrust dataset named `key-<slug>` (`eval/datasets.ts`),
upserted by domain so a rerun updates rows in place rather than duplicating
them. `expected` carries the human label; a company nobody has reviewed yet
still gets a row, with `expected: null`, so the dataset shows exactly what
the key file shows. Omit the profile to sync all six. A profile whose key
has no companies yet (`dental`, `hvac`, before their first arm run) still
opens its dataset, just with no rows.

The `algo-backend` Braintrust project already held a dataset named
`profiles` and four experiments (`5b344d879620-mstone*`) before this eval
existed: leftovers from the earlier `braintrust` branch's harness, which
scored one shared "profiles" dataset (one row per profile) rather than one
dataset per profile keyed on companies, and which spent real vendor dollars
(`$2.0006083` against `mstone`, visible in that experiment's own metadata).
They are superseded by this design and are left alone rather than deleted
or renamed — every dataset and experiment this eval writes uses its own
`key-<slug>` or `<commit>-<arm>` name, so the two never collide.

Every scorer this eval uses is code in `eval/scorers.ts`, each with a test
in `test/eval-scorers.spec.ts`; none is defined only in the Braintrust UI.
`gatesPass` and `qualifiedCoverage` are code scorers: pure functions over a
verdict, wired into `bun run eval`'s `Eval()` call, and they are the only
scores that ever reach `computeVerdict`. `fitReading` is a model-based
diagnostic: given a way to call a model (`ReadFit`, injected rather than
closed over, so its test never calls one), it reads one unlabelled stored
company against the profile and returns `fits`, `unclear`, or
`does-not-fit` with a reason, scored `1`, `0.5`, or `0` to help a human
decide which unlabelled company to look at first. It never gates a run and
is not wired into `bun run eval`'s scores yet — a per-company reading does
not fit that call's one-score-per-trial shape, so it is called directly
(from `eval:label`'s future `--suggest` mode, or a standalone pass over a
dataset) rather than from inside `Eval()`.

## The winner rule

> An arm wins a profile when every correctness gate holds; among arms that
> clear the gates, higher qualified coverage wins, then lower cost per stored
> company, then fewer seconds per stored company. Declared before any arm
> runs; never chosen after seeing the numbers.

This is `WINNER_RULE` in `eval/manifest.ts`, written once into every
manifest verbatim. No comparison between two arms may use a different rule,
and no run picks a metric to compare on after seeing which one it would win.

## What is not built yet

- The companies engine takes no fixed evaluation date. Every arm runs against
  whatever "now" is when it starts, so a requirement's `windowDays` freshness
  check is not reproducible across two arms run on different days. Adding
  that needs a parameter on `/companies/find` itself, which is outside this
  eval's own surface.
- `fitReading` is built and tested but not called from anywhere yet: no
  `eval:label --suggest` mode exists to drive it over a profile's
  unlabelled companies. Until one exists, prioritising which company to
  label next is still a human reading the printed record.
- `eval/arm-db.ts`'s `bootstrapArmSchema` and `seedArmProfiles` call
  `node:child_process` and open real database connections; both run under
  plain Bun, never inside the Vitest Workers pool this repo's other tests
  use, because `spawnSync` is not implemented there. `armDatabaseName` and
  `armDatabaseUrl`, the pure naming logic, have unit tests
  (`test/eval-arm-db.spec.ts`); the actual create-drop-migrate-seed sequence
  is proven only by running `bun run eval` itself, not by an automated test.

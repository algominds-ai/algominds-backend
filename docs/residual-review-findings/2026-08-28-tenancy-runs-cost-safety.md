# Residual findings: tenancy, run records, and cost safety

Branch `feat/tenancy-runs-cost-safety`. Six reviewers read the diff against
`master`: correctness, project standards, reliability, adversarial, data
migration, and API contract. Three earlier reviewers read it for reuse,
quality, and efficiency.

What follows is what was **not** fixed, and why. Everything else was applied
and is in the branch history.

There is no remote and no tracker, so this file is the record.

## Money

### A run that dies mid-batch still loses the spend of the batch in flight

Each round and batch now writes its running total, so a failed run no longer
reports zero. The step that was executing when the failure happened is still
lost, because its cost is only known when it returns. The gap is bounded by
one round or one batch.

Closing it needs reconciliation against the vendor's own billing, which the
engine does not have today.

### The daily ceiling is read then decided, with no lock

`accountSpendToday` is a plain read. Two runs for one account that start
together can both see the same total and both proceed.

The plan asked for a Postgres advisory lock held across the read and the
decision. Those are two separate workflow steps and a lock cannot span them.
Doing it properly means merging the ceiling check and `openRun` into one
transactional step. That is a restructure, not a small change, and it was not
worth rushing behind a green gate.

Incremental spend recording narrows the window: a concurrent run now sees
what an in-flight run has already spent, rather than zero until it finishes.

### The per-run overshoot is larger for people than for companies

Both loops stop the next batch, never the one in flight. For companies one
round is one call, so the overshoot is about one call. For people each
company in the batch is its own agent run, so a batch of five can overshoot
by five agent runs. Measured cost per company is far below the worst case,
but the bound scales with batch size multiplied by the per-company price, not
with a fixed small amount.

### An agent email run that outlives the poll window is never costed

`getAgentRunOutput` reports cost only when it sees the run complete. A run
that is still working when the poll window closes is abandoned, and whatever
Exa bills for it is never recorded.

## Tenancy

### `person.linkedin_url` is globally unique

Two accounts that find the same real person cannot both store them. The
second insert is skipped with no error and no evidence row.

This is unreachable today: `routes.ts` hardcodes one seller account, so only
one account exists. Fixing it means deciding whether a person is globally
unique or unique per account, which contradicts a deliberate and tested
behaviour: the same LinkedIn URL found under two companies collapses into one
person. That is a product decision, not a defect to patch.

### The bearer token is one shared secret

Any caller holding it can pass any `icpId`. Tenancy is structural in the
schema and nominal at the door until per-caller identity exists.

## Durability

### `apolloSearch` is not wrapped in its own step

Every other vendor call in the agent people path has one. A nested
`step.sleep` replays the batch, so Apollo is called again for every company
in it. Apollo's people search is free, so this costs no money, but it does
spend rate-limit budget on a vendor that answers 429.

### A people run persists only after every batch finishes

One stuck agent poll throws and the instance stops, so earlier batches that
were already paid for are never written. The accumulate-then-save shape
predates this branch; the new poll loop makes the failure more reachable.

## Data

### An agent-returned LinkedIn URL is not checked

The schema no longer pins a minimum count, which removes the incentive to pad
with invented rows. Nothing checks that a returned URL is actually a LinkedIn
profile, and agent-sourced evidence is recorded at the same confidence as
search-sourced evidence.

### The agent people path always names the target company

`toExaSearchResult` writes the company the run searched, discarding whatever
the agent reported. Employment always matches by construction, so the
employment mismatch signal does nothing for agent-sourced people. Deliberate
and tested, recorded because it is easy to mistake for a real signal.

## Schema

### There is no down migration

`drizzle-kit push` is the only apply path. Against a database that already
holds rows, three statements fail: the NOT NULL `account_id` on `icp`, the
foreign key from `company.run_id` to an empty `run` table, and the unique
index on `person.linkedin_url` if duplicates exist.

This was a greenfield rebuild and that was the right call, but it is asserted
in a plan document rather than anywhere a deployer would see it.

### `icp_account_idx` has no reader

No query filters on `icp.accountId`. It costs a write on every insert and
serves nothing yet.

### `company_icp_found_at_idx` is not the index the planner picks

`recentDomains` uses `company_icp_domain_unique` instead, which leads on the
same column and covers `domain`. The test asserts an index is used rather
than naming one. The extra index may be dead weight.

## API

### `/people/find` no longer accepts a profile id or a prompt

It takes a run id or a domain list. This is a deliberate rescope, not a
regression, and the service has no external consumer.

### The start responses are inconsistent

`icpId` is echoed for a companies run and omitted for people and enrich,
because those jobs do not carry one. On a repeat call the field reappears,
read from the run row.

### Two error shapes on one route

A bad page query returns `issues`; an unknown run returns `error`.

### The cursor is a raw row id

Typed as a UUID at the boundary, so it can never become an encoded cursor
without breaking callers.

### `GET /runs/:runId` returns the platform's own status envelope

Results sit under `output`. The two page routes wrap their own shape; this
one does not.

## Not verified

Exa's agent API contract is not pinned against a captured response the way
`/search` is. The effort enum, the data-source names, and the field names in
the run request are written from the vendor's documentation, not measured. A
mismatch fails every agent parse.

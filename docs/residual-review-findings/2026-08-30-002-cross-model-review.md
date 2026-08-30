# What the cross-model reviews found, and what is still open

Two independent Codex passes read this branch: a sanctioned adversarial pass
through the review skill (`independence_verified: true`), and a deep
code-quality pass at extra-high reasoning. Between them and the local reviewers
they found ten defects. Six are fixed in the commits. Four are open, and three
of those are decisions rather than bugs.

Its verdict: **not merge-ready** while the four items below stand. Its
verification table independently confirmed every earlier fix on this branch as
"correct and complete", so what remains is genuinely what remains.

## Open, and blocking a deploy until decided

**1. Paid spend is banked only after a whole round or batch succeeds, in three
capabilities.** `find-companies`, `find-people` and `enrich` wrap several
billable calls in one `step.do` and record spend only when the whole callback
returns. A judge call that fails after a search succeeded re-runs the callback
and re-buys the search; a people batch where one parallel search throws banks
neither the plan nor the successful one. Onboarding was fixed to check-point at
each billable boundary; these three were not.

The fix is the shape onboarding already uses: one `step.do` per independently
billable unit, returning its result plus its cost, then `recordRunSpend` for the
cumulative total. It changes the step topology of three workflows and their
retry semantics, so it is a deliberate piece of work, not a patch.

**2. The daily ceiling never reserves.** `assertUnderDailyCeiling` reads
historical spend and compares. Two runs can both read $49.95, both pass, and
both buy. One run can pass at $49.95 and then spend a dollar. Pre-existing in
all four capabilities, now more reachable because onboarding is the cheapest
surface to fire repeatedly.

The fix is a transaction that locks the organization and day, sums actual plus
reserved, and inserts the run with a reservation before returning — then
reconciles as each unit banks. That needs a reservation column and a decision
about per-capability maximums.

**3. Anyone can mint fresh budgets.** One account can create unlimited
organizations, and each one starts paid onboarding under its own zero-spend
ceiling. Named in the plan's own Open Questions and confirmed reachable by three
reviewers.

Better Auth has native controls this project simply does not set:
`organizationLimit` and `allowUserToCreateOrganization` on the organization
plugin. Those, plus an edge rate limit on sign-up and `/organization/create`,
plus a global spend fuse, are the shape of the answer. Per-user limits alone do
not stop many-account abuse, so the fuse matters.

## Open, smaller

**4. `persistIcp` is not one transaction.** It inserts the profile and closes
the run in two commits inside a retrying step. A transient failure between them
retries the whole callback and writes a second profile the run never references.
The fix is one Drizzle transaction in a single core function. Do not add a
uniqueness constraint on organization and domain — whether a later profile
should replace or coexist is still undecided.

**5. The seller block reaches a second model as bare prose.** What the
onboarding model writes into `customers` and `competitorTest` is stored, then
interpolated directly into the company-search agent's system sentences. Length
and shape are capped; meaning is not. A seller page that steers the first model
steers every later run for that account. The fix is to keep the system
instruction fixed and append the seller profile as clearly-labelled untrusted
data — facts to compare against, never instructions to follow.

**6. A failed run's row stays `running` forever.** No workflow closes its row on
terminal failure, so `GET /runs/:runId` reports a null outcome indefinitely.
Spend is banked correctly; only the lifecycle is stale. The fix belongs to all
four capabilities at once, not one.

## Fixed in this branch, listed so nobody re-reports them

- The baseline migration is staging's exact bytes again, with the two real
  changes in `0001_onboarding`. Rewriting an applied baseline would have made
  any deployed database replay `CREATE TABLE "company"` and fail.
- The seller is excluded on the plain search path, not only the agent path.
- A run that dies after buying something banks what it spent, in all four
  capabilities, and a restart adds rather than overwrites.
- `writeSellerProfile` returns a null description instead of throwing away a
  ledger that already billed.
- `startJob` lets the create arbitrate a concurrent start rather than racing a
  check against it.
- Step mocks are gated against the step names workflows actually run, with
  templates compiled to anchored patterns.
- The hook test fails when the hook wiring is removed, which it did not before.

## Coverage note

The deep quality pass could not re-run the Workers tests or the bundle inside
its read-only sandbox: Vite and Wrangler need to create temporary files and got
`EPERM`. It reached and confirmed every static gate. The full green gate is this
session's evidence, not independently reconfirmed by that reviewer.

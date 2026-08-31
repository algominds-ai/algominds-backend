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

**1. Paid spend is banked only after a whole round or batch succeeds, partly
fixed.** The judge now runs in its own durable step, so a transient judge
failure retries alone instead of re-running the round and re-buying the search
it already paid for. That was the common case and it cost one wrapper beside
the one `agentSynthesize` already used.

The plain Exa search is still inside the composite round step. Putting it in
its own step means carrying `ExaSearchResult` through `step.do`, and its
recursive `Json` field defeats the step's own generic — the same wall that made
`agentSearch` build its result outside the step. Closing it needs a narrower
result type at that seam, not a wrapper.

`find-people` and `enrich` are untouched: their paid work is one step per batch,
and a partial failure inside a batch still loses and re-buys the calls that
succeeded. Fixing those means a step per subject and per company, which is a
step-count decision, not a patch.

**2. The daily ceiling never reserves. Not fixed, and not fixable lazily.**
`assertUnderDailyCeiling` reads and compares; two runs can both read $49.95 and
both buy. Making the check atomic needs either raw SQL in the insert or a
transaction with a per-organization lock, and both fight the narrow structural
connection types this layer uses for test injection: `RunOpenConnection` is an
insert plus a select, so `.transaction` and `.execute` would have to be added to
it and to every injected fake.

Shrinking the window by folding the check into the open-run step would churn
four workflows and their mocks while still not closing the race. It would read
as a fix and not be one. This needs the reservation design, deliberately.

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

# What an onboarding run buys, and how that spend is counted

## The invariant

`recordRunSpend` carries the rule the daily ceiling depends on: *a run that dies
before it closes still counts*. `organizationSpendToday` sums `run.cost_dollars`,
so spend is only visible once a `run` row exists. Any capability that buys
something before opening its run row can spend money the ceiling never sees.

Onboarding first got this wrong. Its run row was written last, because
`run.icp_id` referenced `icp.id` and the profile did not exist until the paid
work finished. A run that died in the paid step therefore left no row, and the
Exa search it had already paid for vanished from the account's day. The model
path made it worse: `attemptStructured` records a failed call's cost into the
ledger before rethrowing, so two failed attempts billed real money into a ledger
that was then discarded.

## The fix

`run.icp_id` is nullable. A run that has not produced a profile yet genuinely
points at nothing, and saying so is cheaper than the alternatives: a placeholder
`icp` row would be a real profile carrying a fake description, reachable by any
caller who passed its id to `/companies/find`.

The order is now: check the ceiling, open the run, buy the pages, bank what
that cost, buy the profile, bank that too, then write the profile and close the
run against it. The second bank matters: when neither the model nor a note
produces a description the run fails, and without banking first the model call
it already paid for would vanish the same way the search once did. Two readers of
`run.icpId` — the people-run target and the enrich source — refuse a source run
that produced no profile, which they should have done anyway.

## Why the paid work is two steps

`step.do` retries its whole callback. One step holding both the Exa search and
the reasoning call meant a gateway 5xx on the model re-ran the search, buying it
again, up to three times. `readSellerPages` and `writeSellerProfile` are separate
steps, so a model retry re-buys only the model call.

`readSellerPages` returns `{ url, text }` rather than the vendor's `ExaResult`.
The result type carries a recursive `Json` field that the step's own generic
cannot instantiate, and the prompt never needed the rest of it. The same wall
stops the plain company search from getting its own step, which is why that one
still sits inside its round.

## What a step may return

Never a class instance. A step result is replayed from its serialized form, so a
`CostLedger` does not survive one. Each paid step returns its total as a number
and the workflow sums them.

## The rule generalised

Every capability now seeds its cost accumulator from what its run already
banked, read from `openRun`'s returned row. `recordRunSpend` overwrites the
column rather than adding to it, so a run restarted under its own id would
otherwise replace a failed attempt's spend with its own and the account's day
would undercount money already billed.

That step returns an object rather than a bare number. A step mock whose result
is falsy is treated as no mock at all, and the real step then runs — which is
how ten tests hung when this step first returned zero.

## Writing the profile

`saveOnboardedIcp` inserts the profile and closes its run in one transaction,
so a failure between the two cannot leave a profile no run points at. A retry
after a full commit still writes a second profile; there is no idempotency key,
and whether a later profile should replace or coexist is undecided.

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

The order is now: check the ceiling, open the run, buy, bank what that cost, buy
again, write the profile and close the run pointing at it. Two readers of
`run.icpId` — the people-run target and the enrich source — refuse a source run
that produced no profile, which they should have done anyway.

## Why the paid work is two steps

`step.do` retries its whole callback. One step holding both the Exa search and
the reasoning call meant a gateway 5xx on the model re-ran the search, buying it
again, up to three times. `readSellerPages` and `writeSellerProfile` are separate
steps, so a model retry re-buys only the model call.

`readSellerPages` returns `{ url, text }` rather than the vendor's `ExaResult`.
The result type carries a recursive `Json` field that the step's own generic
cannot instantiate, and the prompt never needed the rest of it.

## What a step may return

Never a class instance. A step result is replayed from its serialized form, so a
`CostLedger` does not survive one. Each paid step returns its total as a number
and the workflow sums them.

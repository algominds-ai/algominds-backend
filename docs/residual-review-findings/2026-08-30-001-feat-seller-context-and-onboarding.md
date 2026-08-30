# Residual review findings — seller context and onboarding

Twelve reviewers read the branch. What was fixed is in the commits. This file
records what was not, and why, so nobody has to re-derive it.

## Decisions that are yours, not mine

**Nothing bounds signup-triggered onboarding.** Registration is open, no email
verification is configured, API keys are exempt from the auth plugin's rate
limit by design, and every new organization starts at zero recorded spend. The
per-account daily ceiling bounds one account; it cannot bound account creation.
A script can create organizations with distinct domains and buy vendor work at
about seven to twelve cents each. Three reviewers reached this independently,
and the plan's own Open Questions section names it.

The candidates are an email-verified gate before the hook fires, a
per-user organization cap, or an edge rate limit on sign-up and organization
creation. `docs/solutions/edge-rate-limits.md` now carries a proposed
`POST /icp/onboard` rule, but the sign-up path has none, and a dashboard rule
is configuration this repository does not apply.

**A repeat onboarding accumulates profiles.** `icp` has no uniqueness
constraint on `(organization_id, domain)`. A second onboarding for a domain an
organization already has writes a second row rather than replacing the first.

## Fixed after probing, not deferred

**A failed onboarding used to block its own retry for the rest of the UTC day.**
`instanceExists` asked only whether the engine still held a handle for the run
id, which it does for an errored instance, so a retry got `{status: "existing"}`
and the caller waited for the date to roll. `src/auth.ts` promises the endpoint
is the recovery path for exactly the failure the signup hook swallows.

This was nearly deferred on the question of whether Workflows accepts
`createBatch` for a terminated id. Probed: it does — re-creating a terminated
instance resolves rather than throwing. `instanceExists` now treats `errored`
and `terminated` as not blocking, and a status it cannot read as blocking, so an
unreadable instance never causes a second paid run. A retried onboarding adds to
what the failed attempt spent rather than replacing it.

## Weighed and declined

- **Threading `executionCtx.waitUntil` through auth** so the hook's enqueue
  leaves the response path. Measured: `organization/create` returns in 38 ms
  including that call. Three layers of plumbing for a few milliseconds on a
  rare event.
- **Parsing `evidenceKind` as an enum on the vendor's reply.** Exa is a direct
  dependency, so an unexpected value would throw and fail the whole run. The
  field is a label; failing a run over a label is worse than storing an odd one.
- **Sharing the ten seller-research queries** between `src/core/onboard.ts` and
  the skill's `read-seller.mjs`. Two reviewers independently said not to: the
  script must run standalone and cannot import the Workers module graph.
- **A `companyRow` builder in `test/companies.spec.ts`.** Real point — adding
  `evidenceKind` meant editing a dozen literals by hand — but it is test
  ergonomics, not a defect.

## Known and pre-existing

- **The ceiling is check-then-act.** Two runs for one organization can both
  read "under the ceiling" before either records spend. Present identically in
  `find-companies` and `find-people`; onboarding is merely the cheapest surface
  to fire in parallel.
- **A retried `save-icp` can write a second `icp` row.** `createIcp` has no
  idempotency key. The run points at one row; the other is orphaned.
- **A failed run's row stays `status: "running"`.** Its cost is banked and the
  ceiling counts it, which is what matters, but the row is never stamped
  terminal. The same is true of the other capabilities.

## Coverage this review did not buy

- **No cross-model corroboration.** Codex, Gemini, Cursor and Composer CLIs are
  installed, so the adversarial pass could have run on a different model. It ran
  in-process instead, because publishing this source to another vendor is not
  authorized in this session. Twelve reviewers in twelve separate contexts is
  real independence between lenses, but every one of them is the same model.
- **The testing reviewer never returned findings.** Its lens — whether a test
  can silently pass, and whether any test can reach a paid vendor — was covered
  only by my own check, which found and fixed one such test.

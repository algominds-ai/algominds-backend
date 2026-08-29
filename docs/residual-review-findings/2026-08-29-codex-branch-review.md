# Residual findings: review-triage-tenancy-money

An independent review by codex (gpt-5.6-sol) of branch `fix/review-triage-tenancy-money`
against `master` on 2026-08-29. It read installed source under `node_modules/` and
captured fixtures under `test/fixtures/`. This document records only what was left
unfixed, and why.

## A tenant can mint itself a fresh daily budget

The daily spend ceiling is keyed by organization id. Sign-up is public and a signed-in user may create organizations without limit, so the same person can spend the daily allowance, create another organization, and start again. Verified against the installed Better Auth 1.7.2 source, where organization creation defaults to allowed and imposes no limit unless one is configured. The ceiling is therefore not an account ceiling. The fix is admission control, or keying spend to a billing identity a caller cannot create for itself, and it belongs with the decision about whether sign-up stays public at all.

## A retried step can buy the same vendor call twice

A workflow step that holds several billable calls is retried whole. A people batch that completes four Exa searches and then fails on the fifth runs all five again, and only the last attempt's ledger reaches the run's recorded spend, so both ceilings can be crossed without either showing it. The same is true of a company round that completes its search and then fails in the judge. The fix is one durable step per billable call, with retries and cost recording owned by the leaf rather than the group. That is a restructure of the workflows, not a small change.

## A timed-out start may have already been accepted

The Exa agent start is a POST that now carries a sixty second client timeout. A timeout raises a retryable error, so the start can be sent again, and the vendor may have accepted and begun billing the first one. There is no idempotency token on the request. Whether Exa charges twice was not measured, so the duplicate charge is suspected rather than confirmed. A timed-out POST should be treated as an indeterminate start rather than a safe retry.

## The retry-budget check reads one line at a time

`scripts/check-step-config.mjs` finds each `step.do` with a regular expression over a single line and looks for a configuration token in the three lines that follow. A call written as `step["do"]`, split across lines, or bound to a variable passes unchecked, and Cloudflare's default of five retries then applies to a paid call. Every call in the repository today is configured. The check does not prove the next one will be. The fix is to read the syntax tree with the TypeScript parser already installed, with fixtures for the forms the regular expression misses.

## A person row can name a company from another tenant

`person` carries both an organization id and a company id, and nothing requires them to agree. Every writer today supplies an organization the caller proved, so no path was found that exploits this. A future writer that got it wrong would make a tenant read trust the company's owner rather than the person's. The relationship should be checked where people are saved, and readers should refuse a row whose two owners disagree.

## A broken vendor still reads as an honest miss

Apollo and Findymail return null when they cannot answer, which is the deliberate contract that lets the waterfall move to the next provider. That same null is returned for an expired key, a five hundred, and a response whose shape has drifted, so a vendor that is entirely down completes a run as though it searched and found nobody. Findymail can also record no spend at all, because it meters only after a successful parse. The null contract should be kept for a measured miss and refused for a failure.

## A judge that cannot answer keeps everything

The judge asks a model for one verdict per candidate. Nothing requires the model to return one verdict per row, so a short or duplicated answer silently drops or repeats candidates. When the model returns nothing usable twice, the judge keeps every row the gate passed, on the reasoning that the gate's decision stands. A verifier that has failed is not a verifier, and a run that reports companies it never checked reads exactly like one that did.

## What the review did not find

It traced the route ownership checks, the source-run check, the profile check, the domain lookup, the run page reads, the organization spend query, the scope id, and the composite uniqueness on a person's organization and LinkedIn URL, and found no reachable cross-tenant path. It confirmed that every `step.do` in the repository today carries an explicit budget, that the run's ceiling check and its insert share one durable step, and that the schema, the baseline SQL and the Drizzle snapshot agree.

It could not run the tests or the bundle check, because its sandbox refused writes under `node_modules/.vite-temp` and `.wrangler/tmp`, and it said so rather than claiming a green run.

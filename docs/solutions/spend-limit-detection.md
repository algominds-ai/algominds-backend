# Why `isSpendLimitExceeded` matches on a message, not a status code alone

`isSpendLimitExceeded` in `src/core/cost.ts` returns true only for a 429 whose body contains a
message mentioning "spend limit" or "budget". A bare 429 status is not enough on its own.

## The problem

An AI Gateway spend limit and an ordinary rate limit both return HTTP 429. A retry policy needs
to treat them oppositely: a spend-limit block should not be retried (the budget is gone until
the window resets), while an ordinary rate limit should back off and retry. Something has to
tell the two apart from the response alone.

## What Cloudflare documents, and what it doesn't

Cloudflare's own spend-limits documentation states that a blocked request "returns a 429 Too
Many Requests response" and describes the blocking behavior, but does not publish a response
body shape, an error code, or any field to key a classifier off. Checked directly against
Cloudflare's documentation: no such shape exists in the published docs as of this writing.

## Current behavior

`isSpendLimitExceeded` parses the body against the `{ error: { message: string } }` envelope
other AI Gateway error paths use, and checks that message for "spend limit" or "budget". A body
that doesn't match this envelope, or a message without either phrase, is treated as an ordinary
(retryable) error.

## Upgrade path

Replace the message match with an exact field check once a real blocked response has been
captured from a live gateway with a spend limit configured.

**Status:** unknown pending that captured response. A smoke test run against a gateway with a
spend limit configured is expected to surface the real shape.

## Verification

`test/cost.spec.ts` covers a spend-limit message (classified true), an ordinary rate-limit
message (false), a non-429 status (false), and a body that doesn't match the expected envelope
(false).

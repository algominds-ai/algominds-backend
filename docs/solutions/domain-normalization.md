# Why `normalizeDomain` only strips `www.`

`normalizeDomain` in `src/core/db/schema.ts` lowercases a domain or URL, drops the scheme and
path, and removes one leading `www.`. It does not collapse a value to its registrable domain
(eTLD+1) using a public-suffix list.

## The problem

Two inputs that name the same company should map to one stored domain: `https://WWW.Acme.com/careers`
and `acme.com` both need to become `acme.com`. A naive string compare would treat them as two
different companies.

## Why this stops short of a full public-suffix-list lookup

A correct eTLD+1 reducer (`shop.acme.co.uk` → `acme.co.uk`) needs a maintained suffix list,
because the split point is not "last two labels" — `co.uk` is a suffix, `com` is a suffix, but
`acme.com` is not. No provider integrated so far returns a domain where that distinction
matters; every input observed is already either bare or has at most a `www.` subdomain.

Adding a dependency (`tldts` or similar) for a case with no observed input and no test behind
it fails the "a new dependency needs a reason a few lines of code could not cover" bar.

## Current behavior

- Adds a scheme if the input has none, so `new URL()` can parse it.
- Lowercases the resulting hostname.
- Strips exactly one leading `www.`.
- Leaves every other subdomain alone: `shop.acme.com` stays `shop.acme.com`.

## Upgrade path

If a provider starts returning domains with a multi-label public suffix that needs collapsing,
swap the last two lines for a `tldts`-based (or equivalent) registrable-domain lookup. Until
then this file is the single source of truth for both the write-side normalizer and the
grounding-domain comparison that reuses it, so the two cannot drift apart.

## Verification

`test/db.spec.ts` runs `normalizeDomain` against scheme/case/port/path variations and asserts
the `www.`-only limit directly.

# `normalizeDomain` collapses to the registrable domain

`normalizeDomain` in `src/core/db/schema.ts` lowercases a domain or URL, drops the scheme and
path, and collapses the host to its registrable domain (eTLD+1) with `tldts`'s `getDomain`.
`www.` and every other subdomain are subsumed by the same collapse.

## The problem

Two inputs that name the same company should map to one stored domain. That used to mean only
`https://WWW.Acme.com/careers` and `acme.com` both becoming `acme.com`. A vendor returning
`branches.lloydsbank.com`, `cashmarket.deutsche-boerse.com`, and other subdomains of a bank's
own site made one company look like several, and the sixty-day exclusion could not match them
because it compares normalized domains.

## Why `tldts`

The split point is not "last two labels": `co.uk` is a public suffix, `com` is a public suffix,
`barclays` is a public suffix too (a brand top-level domain), so `jobs.barclays` is already
fully registrable and collapses no further. That distinction needs a maintained public-suffix
list, which is what `tldts` ships. `getDomain` returns `null` for a host with no registrable
domain under that list — `localhost`, an address literal, a bare TLD — and `normalizeDomain`
falls back to the lowercased host unchanged in that case, matching its behavior before this
change.

## Verification

`test/db.spec.ts` runs `normalizeDomain` against scheme/case/port/path variations, a
multi-label public suffix (`shop.acme.co.uk` → `acme.co.uk`), a brand TLD (`jobs.barclays`,
unchanged), and the `localhost`/address-literal fallback.

## Nothing migrates

Existing stored `company` rows keep the domain they were saved under. A row saved as
`shop.acme.com` before this change does not retroactively become `acme.com`; only domains
normalized from here on collapse to their registrable form.

## `publicDomain`, when a domain will be crawled

`normalizeDomain` answers "what is the canonical form of this host". It says
nothing about whether the host is worth reaching: `localhost` and an address
literal both normalize happily.

`publicDomain` in the same file wraps it and returns null for a host with no
dot or an all-numeric one. Use it wherever a caller-supplied domain leads to a
paid crawl or a stored profile — the onboarding endpoint, the onboarding
workflow, and the signup hook all read it. Use plain `normalizeDomain` for
comparison and storage, where any host that parses is fine.

The split matters because the two questions have different answers: a domain
can be perfectly normalizable and still name nothing anyone can fetch.

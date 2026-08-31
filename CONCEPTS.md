# Concepts

Shared domain vocabulary for this project — entities, named processes, and status
concepts with project-specific meaning. Seeded with core domain vocabulary, then
accretes as ce-compound and ce-compound-refresh process learnings; direct edits are
fine. Glossary only, not a spec or catch-all.

## The profile and who it is for

### Profile
The stored document describing which companies an account wants to reach, and what
recent event makes one worth reaching now. Everything the engine buys is derived from
it.
*Avoid:* ICP document

A Profile belongs to one Organization. It is written either by onboarding from a
Seller's own website, or by a caller passing free text. It is never edited in place
by a run — a run reads it.

### Seller
The company an account prospects on behalf of. A Profile may name one, carrying its
domain, the customers it has already won, and one sentence describing who a
competitor sells to.

The Seller exists to be excluded: its own site is never a prospect, its named
customers are already won, and a competitor is refused by that sentence rather than
by a list of names. A Profile with no Seller produces exactly the behaviour that
existed before Sellers.

### Organization
The account that owns Profiles, Runs, and the spend they incur. Every ceiling and
every cost is scoped to one.

## Buying, and what it costs

### Capability
One of the things the engine can do: find companies, find people, enrich people, or
onboard a Seller into a Profile. Each is a separate Workflow with its own Run.

### Run
One execution of a Capability, carrying its status and everything it spent. A Run row
must exist before anything is bought, because the daily ceiling can only see spend
that a Run row records — a Run that dies before it closes still counts.

### Round
One cycle inside a find-companies Run: the Synthesizer writes a query, a search buys
candidates, the Gate refuses them on numbers, and the Judge refuses them on meaning.
A Run makes several, each on a different angle.

### Daily ceiling
The most an Organization may spend in one UTC day, summed across every Run it owns.
A new Organization starts at zero, so the ceiling bounds an account and not the
creation of accounts.

## Deciding what to keep

### Synthesizer
The model call that turns a Profile into one Round's search plan: the query sentence,
the numeric bounds, and how fresh the evidence must be.

### Gate
The stage that refuses a candidate on numbers and shape — headcount, country,
founding year, a missing required field. It reads only the record, never meaning.

### Judge
The model call that refuses a candidate on meaning: whether it actually fits the
Profile, and whether the page offered as proof really proves it. It runs after the
Gate, and it gives a reason only when it refuses.

### Evidence
The page that proves a company's Signal, recorded with what it said and who published
it. Evidence is append-only: a value is never deleted, only given lower confidence.

### Signal
The recent event that makes a company worth reaching now — a role posted, a statement
published, an outage written up. A Profile that asks for no Signal is asking about
lasting shape instead.

## Vendors

### Waterfall
An ordered chain of providers tried until one answers. A provider that simply has no
answer returns nothing so the next one runs; only a genuinely retryable failure
throws. A direct dependency has no next provider, so it throws instead of returning
nothing — the two fail differently on purpose.

# BrightData filter API — query shape probe

Dataset gd_l1viktl72bvl7bjuj0, tested from harbor-msp (small, known 206-row roster once
filtered on current_company_company_id) and the metadata endpoint. All numbers below are
measured, not projected. Six probes share one account quota; several results below carry
contention noise from that sharing, called out where it applies.

**Two endpoints exist. Use the second one.** `/datasets/filter` (POST, returns a
`snapshot_id` you poll) is the SNAPSHOT endpoint — it queues, and under load the queue can
stall for many minutes with zero throughput (measured below). `/datasets/search/{id}`
(POST, synchronous) is the SEARCH endpoint — real-time, sub-second, no queue, and gives
`total_hits` for free. `bd.mjs` exports `bdSearch`/`bdCount` for it. Section 1 below
describes the snapshot endpoint's failure mode specifically so nobody reaches for it in
production; everything from §2 onward runs against the search endpoint.

## 1. Snapshot-endpoint parallel-job cap and queue stall (endpoint to avoid)

Measured directly with a 15-way concurrent burst of trivial filters (records_limit=2,
same filter each time): **1 accepted, 14 rejected with `too_many_parallel_jobs`, in 517ms
wall time.** The account-wide ceiling on jobs simultaneously in `building` state is very
low — observed as low as 1 free slot at a given instant under six-probe load.

More important than the count: **rejection is not the real cost, queuing is.** 15 of 17
trivial (records_limit=3) filter jobs I triggered near the start of this run were STILL
in `status:"building"` after 25+ minutes, with `dataset_size:null` and `cost:0` — no
progress despite each asking for at most 3 rows. Two of the 17 resolved fast, but as
`failed` (`no_records_found` on a bad company-name string, not a cap issue). So the
practical ceiling is not "N jobs then a clean 429" — it is a queue that can stall
indefinitely once the account's in-flight job count is saturated, with no visible
distinction between "about to run" and "stuck." A production design must not fire many
filter jobs concurrently; it should serialize with backoff (as `bd.mjs` now does) and
budget minutes-per-job, not seconds.

I could not cleanly isolate "the" ceiling because five other probes were adding load
throughout — the 1-of-15 result is a floor, not necessarily the account's true solo
capacity. Recommend a follow-up burst test run alone, off-hours, if the exact number
matters for capacity planning.

No cursor, offset, or pagination parameter exists on `/datasets/filter`,
`/datasets/snapshot/{id}`, or the download endpoint — `records_limit` is the only lever,
and there is no way to fetch page 2 of a truncated result.

## 2. Nested array filtering — NO, confirmed on both endpoints by exact error text

Re-confirmed on the search endpoint (same validation layer as the snapshot endpoint, just
a different transport — 500 here instead of 400, same message):

| Filter attempted | Result |
|---|---|
| `experience.company_id = "harbor-msp"` | 500 `unsupported filters: experience.company_id` |
| `experience.end_date = "Present"` | 500 `unsupported filters: experience.end_date` |
| `experience.positions.title includes "Director"` | 500 `unsupported filters: experience.positions.title` |
| AND of company_id + end_date="Present" | 500 `unsupported filters: experience.company_id, experience.end_date` |
| `experience[].company_id = ...` | 500 `unsupported filters: experience[].company_id` |
| `current_company.company_id = ...` | 400 `unsupported filters: current_company.company_id` |
| `current_company = {object}` | 400 `"current_company": bad value "{...}"` |
| `experience is_null` / `is_not_null` | 200, accepted (whole-array null check only) |
| baseline `current_company_company_id = "harbor-msp"` | 200, `total_hits: 206` (control, confirms the endpoint and account both work) |

Verdict: **no**, plainly. There is no dotted-path, bracket, or nested-object filter syntax
the API accepts, on either endpoint. The only company-scoped, non-null filter you can push
server-side is `current_company_company_id` and `current_company_name` — the two flat
top-level fields BrightData pre-extracted from `current_company`. `experience` is
filterable only as a whole (null/not-null), never keyed by `company_id`, `end_date`, or
`positions[].title`. Best available substitute, unchanged from the original finding:
server-side filter on `current_company_company_id` (and `position`, see §3) to shrink the
pull, then resolve the real current title locally with `currentTitleAt` against
`experience[]`. There is no way to ask the server for "current employees only" in one call.

## 3. Title/headline filtering — server matches local exactly (precision = recall = 100%)

Measured on the harbor-msp roster (known, cheap: 206 rows), comparing the search
endpoint's compound filter against filtering the full local pull with the identical
predicate:

| Term | Server count | Local count (full 206-row pull) |
|---|---|---|
| `position includes "Director"` | 14 | 14 |
| `position includes "Chief"` | 3 | 3 |
| `position includes "VP"` | 1 | 1 |
| `position includes "President"` | 2 | 2 |
| `position includes "Owner"` | 0 | 0 |

Every term agrees exactly — zero false positives, zero false negatives across 5 terms and
20 matched people. `position` accepts `=, !=, includes, not_includes, in, not_in, is_null,
is_not_null` (all 200 at trigger; `>`/`<` rejected, text type). Given 72% of rows carry a
non-null headline versus a much smaller share with a resolvable structured title (53/206 =
26% via `currentTitleAt` on this same roster), `position` is the higher-recall,
higher-trust server-side lever, and it is now proven trustworthy rather than merely likely
so. Combined with the $2.50-CPM pricing (§5), a compound
`AND(current_company_company_id=X, position includes "<term>")` query is the production
default: it is cheap (pay only for the matches) and exact (no local re-filtering needed to
correct for server error).

## 4. Operator table (search endpoint, unscoped against the full 115M-row dataset,
   `size:1` so only 1 record is ever billed per test)

| Field (type) | Operator | Result |
|---|---|---|
| position (text) | `=,!=,includes,not_includes,in,not_in,is_null,is_not_null` | 200, accepted |
| position (text) | `>`, `<` | 500 `Filter validation failed` (snapshot endpoint gives the more specific "not supported for type text. Supported: number, date, price" — same rule, worse error text here) |
| experience (array) | `is_null`, `is_not_null` | 200, accepted |
| experience (array) | `includes "harbor-msp"` (unscoped, whole dataset) | 500 `ETIMEDOUT` — an unscoped full-text scan of a nested-array field across 115M rows appears to be exactly the pathological shape the team flagged for "Manager" (see §6) |
| followers, current_company, array `=`/`>`, object operators | — | not completed cleanly this pass: the test script crashed on the `experience includes` timeout above, and the account then entered the account-wide unresponsive state described in §6 before I could rerun the remainder |

Known-good from earlier: `current_company_name` (text) accepts `=,includes,in`;
`country_code` (text, quick_filter) accepts `=,in,includes`; `followers` (number) rejects
`includes` with `not supported for type number. Supported: text, string, url, array,
object`. Compound `and` is proven correct and trustworthy by §3's 5-for-5 exact match.

## 5. Cost — corrected: NOT free, $2.50 per 1,000 records returned

The earlier `cost:0` reading was telemetry lag, not a free tier (per the team's
correction). Real pricing is $2.50 CPM on records returned, on both endpoints, and a
zero-hit query is billed nothing. This makes §2 and §3 the decisive findings for the whole
project: since nested filtering is impossible, isolating "current employees with title X"
always costs at minimum whatever the compound `current_company_company_id` + `position`
filter returns — and §3 proves that filter is exact, so there is no need to over-fetch to
correct for server error. Concretely, at Harbor: draining the full 206-row roster costs
about $0.52; querying the same 5 title terms compound-filtered costs about $0.05 total
(20 matched people across the 5 terms, ~$0.05) — roughly 10x cheaper, consistent with the
team's number.

## 6. Load behaviour — the search endpoint hangs silently under contention; it does not
   send a 429

Corrected finding, replacing an earlier wrong theory. My own operator sweep hit an
unscoped `experience includes` search (full 115M-row scan) that returned `500 ETIMEDOUT`.
Right after, every BrightData endpoint I called — including `/datasets/{id}/metadata`,
which scans nothing — stopped responding: no 429, no error body, no HTTP status at all,
just a connection that times out client-side (`curl: (28) Connection timed out`, at
15–45s, repeatedly). A control request to google.com in the same window returned 200 in
0.2s, so the hang is BrightData-side, not local. Separately, the team saw the same thing
on the search endpoint: a shape that had answered in 250ms hung past 120 seconds on the
term "Manager," and the working theory at the time was that a common term makes the query
pathological. That theory is wrong — the team then saw every one of fourteen different
terms hang the same way, including terms that had answered in 250ms minutes earlier. So
this is not about term frequency or query shape. It is contention: once enough concurrent
load lands on the account (six probes sharing one quota), the search endpoint stops
answering at all, for any query, until the load clears.

Put together, the two endpoints fail in different but equally silent ways:

- **Snapshot endpoint** (`/datasets/filter`): queues under load. A job sits in
  `status:"building"` indefinitely — no error, no progress, just an unbounded wait (§1).
- **Search endpoint** (`/datasets/search/{id}`): hangs under load. The connection itself
  times out — no 429, no retry-after, no body, nothing to distinguish "slow" from "will
  never answer" (this section).

Neither endpoint tells the caller it is overloaded. This is the load-behaviour finding
production must design around: **a client cannot tell a genuinely slow query apart from
an account-wide hang by looking at the response**, because there is no response either
way. A naive client that treats a timeout as "no results" would silently report that a
company has no employees when the truth is the account was saturated.

Production rule that follows: serialize BrightData calls strictly (one filter/search
in flight at a time across the whole run, not per company), set an explicit client-side
timeout, and treat a timeout as **UNKNOWN and retryable** — never as an empty result.
Log it loudly rather than falling through to "0 people found."

## Bottom line for production design

- Use the search endpoint (`bdSearch`/`bdCount`) over the snapshot endpoint when a fast
  answer matters — it is far faster when the account isn't saturated — but design for
  the fact that both endpoints fail silently under contention (§6): serialize strictly,
  set an explicit timeout, and treat a timeout as UNKNOWN/retryable, never as zero
  results.
- Do not plan on filtering inside `experience[]` — confirmed unsupported on both
  endpoints (§2). Narrow with `current_company_company_id` AND `position includes
  "<term>"` (proven exact, §3), then resolve the real current title locally with
  `currentTitleAt` against `experience[]`.
- Cost is real: $2.50 CPM on records returned. Always filter as narrowly as the API
  allows before pulling — never drain a roster to filter locally when a compound filter
  can do it server-side for the same result (§3, §5).
- No pagination exists on the snapshot endpoint; the search endpoint's `search_after`
  cursor is the only way to page past `size` (capped at 100 on this dataset).

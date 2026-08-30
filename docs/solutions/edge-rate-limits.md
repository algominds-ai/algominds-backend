# Edge rate limits on the job-starting routes

The four job routes each start paid vendor work, so an unbounded client loop
would spend real money. The limit is Cloudflare dashboard configuration, not
application code, so it cannot be bypassed by a bug in a handler. This file is
where the intended thresholds are reviewable and diffable.

## Intended rules

| Path | Limit | Window | Action |
|---|---|---|---|
| `POST /companies/find` | 20 | 1 minute | block |
| `POST /people/find` | 20 | 1 minute | block |
| `POST /enrich` | 60 | 1 minute | block |
| `POST /icp/onboard` | 5 | 1 minute | block |
| `GET /runs/*` | 600 | 1 minute | block |

`POST /icp/onboard` is the tightest of the four because one call buys a deep
search plus a reasoning call for about seven cents, and an account needs a
profile once, not repeatedly. The signup hook starts the same run under the
same per-day id, so a rule here bounds both entry paths.

Counting key: the bearer token, falling back to client IP when absent.

`GET /health` is unlimited; an uptime monitor polls it and it starts no work.

## Why these numbers

A find-companies run costs roughly $0.012 at five results with summaries. Twenty
per minute caps a runaway client at about $14 an hour, which is visible on a bill
inside one hour rather than one day. Enrich is cheaper per call and higher
volume, so it gets a looser cap. The runs endpoint is a read and only needs to
survive polling.

## Applying them

Dashboard: Security → WAF → Rate limiting rules, scoped to the Worker route.
Nothing in the repository applies these automatically. When the numbers change,
change them here in the same pull request.

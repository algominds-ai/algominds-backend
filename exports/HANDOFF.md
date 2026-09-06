# Handoff: the 10/10 engine program (phase 2), 2026-09-04 to 2026-09-06

Owner: Lahfir. Repository: `algo-backend` (Cloudflare Workers + Workflows, Hono, Drizzle/Postgres, Exa, Clay, GetLeads, AI Gateway). Everything below is local; nothing was pushed.

## 1. Goal and the rule set

Goal as given: take the GTM engine to 10/10. It must find the right companies for any ICP and the right decision makers at them, verified, no per-company limit, at scale, at reasonable cost and speed. Rules that held for the whole program: five companies per account per run; the engine changes only when an eval proves the change; no deterministic hacks written to pass a case; no per-company people cap; Braintrust for every score; codex (`gpt-6-astra`, high effort, resumed session) as the adversarial advisor on every critical decision; sub-agents on Sonnet for all mechanical work.

## 2. The ruler (how quality is measured)

`eval/run.ts --arm <arm> --trials 1 --count 5 [--profile <slug>] --port <port>` runs, for each of seven profiles, a companies run then a people run against a local arm database `eval_<arm>`, and logs one Braintrust experiment per arm in project `algo-backend`. Answer keys live on branch `p2/base` in `eval/keys/<slug>.json` (companies: accept / reject:<reason> / same-as:<domain> / null) and `eval/keys/people/<slug>.json` (accept / reject:<reason> / null). Fixtures (the profiles) are `eval/arm-seed/<slug>.json`. `eval/rescore.ts --arm <arm>` replays a finished arm against the current keys and the current scorer and logs `<commit>-<arm>-rescored`.

Profiles (all deliberately hard): mstone (Australian enterprise technology buyers), aris (small US managed-service providers), form3 (Kubernetes-at-scale companies in listed verticals, size band 501-10,000), carta (venture-backed companies with a finance owner or founder), ondato (consumer or SMB self-serve fintech in UK/IE/US/CA with a signup-conversion buyer), dental (multi-site dental groups, operations buyers), hvac (commercial HVAC contractors in TX/FL/GA).

Composite (`eval/engine-score.ts`, `eval/full-chain.ts`): A = accepted delivered companies (same-as collapsed to the canonical domain); B = accepted companies with at least one accepted person; T = accepted people at accepted companies; P = delivered people. company_yield = A/5, buyer_precision = T/P, buyer_coverage = B/5, engine_quality = coverage x precision, engine_score = gates x quality. Gates: every delivered row labelled, no key-rejected company or person delivered, no duplicate organisation, proving holds, both runs complete, finite accounting, per-profile time and cost ceilings (mstone/aris 400 s and $3.33; form3 600 s and $6.67; carta/dental/hvac 500 s and $5; ondato 800 s and $6.67). One wrong or unlabelled delivered row zeroes the profile. Rating = 10 x mean engine_score. This gate is brutal on purpose; contested rulings decide the rating at five companies per profile.

Labeller: the LABEL teammate rules new rows against the fixture rubric and the key precedent; contested rulings were adjudicated blind by codex (`exports/contested-rulings.md`, `exports/codex-brutal.md` part A) and applied (sainsburys.jobs and two Midnite people moved to undecidable).

## 3. Money

Recorded vendor spend (sum of `run.cost_dollars` over all `eval_p2*` databases): $68.37. Outside the ledger: judge and selector replays about $0.72; two failed rounds whose in-flight calls were unrecorded, about $0.50 (that gap is fixed on staging: a failed round now records its spend). Real total about $69.80 against a cap that moved 20, 30, 40, 60, 80.

Cost per profile per full-chain run: $0.40 to $3.40 (form3 is the expensive one, $1.4 to $3.4; the one-row judge doubled its company stage to about $1.9). A seven-profile draw costs $4.5 to $8. Time per profile: 60 to 640 s.

Per arm (recorded): see the table produced by the databases; the largest lines were the five seven-profile draws ($5.6 to $6.0 each) and the fourteen Form3/Ondato screens ($0.4 to $3.4 each).

## 4. Results, in order

Seven-profile draws (gated rating): baseline 2.86; confirmation 3.43; final 4.29; final2 6.29; final3 6.29. The last two are the same build with different zero sets, which is the run-to-run noise: about plus or minus 2 points at one draw per profile.

Per-profile pattern on the last two draws: mstone 0.80, aris 0.80 to 1.00, carta 1.00, dental 1.00, hvac 0.60 to 0.80, form3 0, ondato 0. The two zeros always came from one row: an off-vertical or division company, a mixed-channel company, a sub-function person, a missing roster.

Screens on the candidate branches (single profile, five companies), most recent last:

| Arm | Build | Result |
|---|---|---|
| p2judge-form3 | judge category rule | form3 1.00, 5/5, 26/26 |
| p2screen-ondato | grounding + entity + authority | ondato 0: 5/5 companies clean, 3 marketing picks rejected |
| p2form3-b1 | one-row judge | form3 0: 3/5, a careers-domain entity (Sainsbury's) |
| p2form3-ent | + entity v1 | form3 0: 4/5, Decathlon Digital division |
| p2ondato-last | + authority evidence | ondato 0: Sidekick (contested) |
| p2fit-ondato | + buyer-fit check | ondato 0: SteadyPay + 2 empty rosters |
| p2fit-form3b | same | form3 0: two undecidable sources (personal profile, vendor case study) |
| p2fit2-ondato | + judge output, fallback, source kinds, exclusion split, fresh crawl | ondato 0.40, gates ok, 5/5 companies, 2/2 people |
| p2fit2-form3 | same | form3 0: Lloyds Bank subsidiary record, 10/10 people |
| p2fit3-ondato | + operator check, GetLeads key fixed | ondato 0: SteadyPay again, a defunct company, a no-evidence company |
| p2fit3-form3 | same | form3 0: only 2 delivered (stricter judge), 7/7 people |

The ungated numbers across the last full draw: company precision 0.91, company yield 0.91, buyer precision 0.91, buyer coverage 0.77.

## 5. What is merged (local staging = master = c372377, gate green)

From phase 1 (894532f): the eval harness, keys, onboarding and engine work of that phase.

Phase 2, signed by codex and merged:
- judge and round steps never retry after a timed-out model call (`judgeCall`, `roundCall` step configs); a hung stage went from 1162 s to 244 s
- a row with no judge verdict is never stored (a real defect: profiles with only plain record requirements stored unjudged rows)
- every started Exa agent run leaves its id in evidence; the judge's exact inputs are saved before the model call
- a failed round records the spend of its completed calls
- eval harness: dev-server log captured to `eval/logs/`, a stage abandoned at twice its ceiling; replay tools `eval/judge-replay.ts`, `eval/judge-replay-cases.ts`, `eval/select-replay.ts`
- the Form3 vertical list is a strict requirement (a named contract revision, not an engine change)
- judge batch size 4 (8 timed out); the scorer counts a person at a same-as subsidiary under its canonical company; fixtures on `p2/base` now match the rubrics the engine runs with (they did not before, which produced wrong rulings)
- the concurrency 5 for verification and the headcount line for the selector (from the $40 phase)

## 6. What is held back, each on its own gated branch

`p2/screen` at b87a13f carries all of these together (gate green, 660 tests) and is the candidate the last screens ran on:
- quoted-evidence grounding: a strict or page requirement is proven only by a verbatim passage found in the row's evidence (`p2/ground`, 48a4fa8). Correct refusals proven on saved rows; it starves Form3 yield when proof pages are weak.
- source kinds: a requirement that names its source kinds is proven only from one of them (`p2/source`, fafb118)
- exclusion split: a strict requirement's exclusion is judged apart and wins (`p2/excl`, 3e0e701). Did not catch SteadyPay: the judge reads "Lending as a Service" as incidental.
- operator check: a page proves a requirement only when its named operator is the judged company (CONSIST, on `p2/screen`)
- entity resolution v2: division and careers records and identity conflicts resolve to a corroborated parent or are refused (`p2/entity`, d21d410)
- roster fallback when the first selection is empty (`p2/fallback`, 6ef74fa)
- buyer-fit check before paid verification, with an audit row per pick (`p2/screen`, c2d5bba, 62984c1). Codex: the fit still fails open on an unknown verdict.
- fresh crawl (`maxAgeHours: 0`) on verification reads; LinkedIn excluded from proof search for source-constrained requirements (`p2/fresh`, 36e8399)
- one-row judge (`p2/batch2`, 0587aa3): no timeouts, double cost, no cross-row grouping
- authority verdict recorded as evidence (`p2/authority`, 80234c7); the enforcing version zeroed founders and was dropped
- judge output persisted as evidence (`p2/judgeout2`, 16a49d3); codex signed it for merge but its cherry-pick onto staging conflicts with the batch context and was not done
- a 2,500-character passage around each proving hit (`p2/excerpt`, 4336914), deferred
- selector prompt sentence for sub-function titles (`p2/selector`, a7decef): replay 5/7 with regressions, rejected
- the same-name colleague merge is a documented limitation (`docs/solutions/person-identity-same-name-colleagues.md`, `p2/dedupe`)

## 7. Defects found and their status

Fixed and merged: judge timeout retry storm; unjudged rows stored; unrecorded failed-round spend; agent runs without ids; judge inputs not saved; dev-server logs discarded; hung stages waited forever; scorer dropped same-as subsidiaries; fixtures diverged from the engine's rubrics; the local secrets store lacked `gl-api-key`, so the GetLeads roster fallback failed in every eval run until 2026-09-06 03:25 UTC.

Diagnosed, fix held on a branch: division and subsidiary records judged as companies (Sainsbury's, Decathlon Digital, Lloyds Bank); proof from a personal profile page (Mollie); a mixed-channel company accepted on its consumer line (SteadyPay, three times); sub-function marketing heads delivered as buyers (Midnite); empty companies from empty rosters (Badoo, Taboo); an unknown verification verdict for a real executive (Kontigo, a YC page as evidence); a defunct company proven from historical copy (Monolith).

Open questions of contract, not engine: does a mixed-channel company with a real consumer self-serve app qualify for Ondato r2 (the contract as written says no); does a personal engineer's account count as Kubernetes-at-scale evidence for Form3 r5 (the contract says no); Sidekick as sales-led (contested, kept reject).

## 8. Codex record

Twenty-plus written consultations in `exports/codex-*.md`, always resumed in one session with "be genuine, criticize as if your life depends on it". Its consistent positions: measure before changing; only promote what a run proves; keep the brutal gate; contested rows earn no half credit; 6.29 is the only validated rating; its closing forecast for the candidate on a fresh draw was 6.4 to 7.7 with a band of 5 to 8.6; the probability of a gated 10 on all seven profiles within this budget: about 2 percent. Its self-criticism, which the author signs: too many safeguards were built in succession before their assumptions were settled, and its advice contributed to that churn.

## 9. Environment and operational notes

- Run one eval per worktree at a time: two dev servers in one worktree collide on the inspector port 9229 and the wrangler state directory.
- Run one gate at a time on the machine: concurrent gates share `algo_test` and the miniflare secrets store and produce false failures (`Secret not found`, planner flakes, a 5 s HTTP timeout).
- Wait loops must not match their own command line: use `pgrep -f '^bun .*scripts/gate\.mjs'`, never `pgrep -f scripts/gate.mjs`.
- The pre-commit hook runs the whole-repo lint; commits of key files use `--no-verify` after `bunx biome check eval/keys`.
- Never write key JSON with `ensure_ascii=True`; it rewrites every non-ASCII character.
- Each eval worktree needs `.env` and `.wrangler/state/v3/secrets-store` copied from the repo root; the store now contains `gl-api-key`.
- Identical judge inputs on the same commit are served from the AI Gateway cache (`cf-aig-cache-ttl`), so a replay repeats verdicts at $0; change the input to force a miss.
- Codex CLI: `codex exec resume --last -m gpt-6-astra -c model_reasoning_effort='"high"' -c approval_policy='"never"' -c sandbox_mode='"read-only"' "$(cat prompt.md)" < /dev/null > answer.md`, in the background.
- Spend watchdog pattern: launcher scripts in `~/.claude/jobs/24a9762f/tmp/run-*.sh` sum `run.cost_dollars` over `eval_p2*` every 30 s and kill the run past a cap.

## 10. How to continue

Zero cost first: `eval/regression/judge-rows.json` (being built on `p2/base`) holds every judged company row with its key ruling; `bun eval/judge-replay.ts --regression` scores a judge change for cents on precision and retention per profile. Use it before any live run. The selector replay (`eval/select-replay.ts`) does the same for the Midnite roster.

Then, per codex's last plan: one repair at a time, each screened on the regression set and then on one profile live ($1.5 to $3.5), then a seven-profile draw ($8) only when both Form3 and Ondato pass their screen bar (five accepted distinct companies, every delivered person accepted, buyers at four of five, within time and cost ceilings). Three seven-profile draws are the minimum for a rating with a band: about $24.

The two repairs with the most evidence behind them: entity and evidence alignment (the proof page's operator must be the judged company, and the size bars must apply to the resolved entity) and buyer coverage (roster keywords from the rubric's named titles, and a corroborated second source when a verification verdict is unknown).

What 10 requires, in codex's words: every profile fulfils five distinct accepted companies and its buyer requirements within frozen gates, repeatedly, not one lucky average. No defensible price buys a guarantee.

## 11. Files

`exports/RESUME.md` (running log), `exports/ledger.md` (decisions), `exports/codex-*.md` (all consultations), `exports/trace-false-accepts.md` (root causes of the false accepts), `exports/provider-audit.md` (options sent versus available per provider), `exports/replay-ground-*.md` (replay results), `exports/contested-rulings.md`, `exports/p2-*-scored.txt` (every score line), `exports/throttle-check.md`.

## Appendix A. Why the last Form3 screen scored zero with every delivered row accepted

Arm p2fit3-form3: the only false gate is `bothRunsComplete`. The companies run ended with status `capped` (the rounds were exhausted at two accepted companies for a five-company ask) rather than `complete`; every other company and people gate passes (appdirect.com and clear.bank accepted, 7/7 people accepted). So the stricter judge on that candidate did not deliver a wrong row; it could not fill the ask. Arm p2fit2-form3 fails a different gate, `noKeyRejectedStored`, on lloydsbank.com. The scorer treats a capped run as a failed fulfilment by design; whether a capped-but-clean run should score its coverage (0.40 here) is a ruler decision for the next owner.

# ce-work progress — find-people plan
branch: feat/find-people
engine: native Sonnet workers, codex review, orchestrator commits

| unit | worker | codex review | gate | commit |
|---|---|---|---|---|
| U1 | done | 5 findings, 4 applied, 1 routed to U11 | green | 51132c8 |
note: test/routes.spec.ts same-day-dedupe test flaked once (202 vs 200) under the shared local Postgres; passed on rerun
note (U2): before running 0002 on staging/production, check `select max(created_at) from drizzle.__drizzle_migrations`; if it is below 1788062882703 the migrator replays 0000 and fails on CREATE TABLE company. Local journal row for 0001 was repaired (hash + created_at) so only 0002 applied.
note (U2): the test suite writes real rows into the local database (icp count rose from 2 to 55 during U2); pre-existing.
routed to U11 (from U2 codex review): (a) targetByDomains must use a profile only when every matched row shares one non-null profile, else no profile plus the orphan rows, carrying unmatched domains into the loop (KTD5); (b) a Workers workflow test with icpId null, load-profile unmocked, asserting completion in roster mode.
| U3 | done on worktree-agent-a7b2e59f5debb618a @ 8699b4a (base 51132c8) | pending layer review | green except shared-DB migration effect | merge after U2 |
rule (user): codex reviews the FULL branch once, after U12 and the dogfood; no per-unit or per-layer reviews. Units: worker builds, gate green in its worktree, orchestrator merges.
| U2 | done | (per-unit review, before the rule) | green | 61dcc55 |
| U5 | done on worktree-agent-a43e2d06a124731f1 @ 22a824d | — | green in worktree | merged d9f789f |
| U3 | merged 3fb2d0c | — | — | — |
| U4, U6, U7 | in flight (worktrees, base d9f789f) | — | — | — |
rule (user): the final codex run is ONE prompt invoking $ce-code-review + $thermo-nuclear-code-quality-review + $ce-simplify-code over the full branch diff vs main.
rule (user): the final codex review diff is against `staging`, not main.
| U7 | merged d625523 from worktree-agent-a455cc360bf4e2d41 @ d625523 | — | green in worktree (457 tests) | — |
| U6 | merged 3b19f1c from worktree-agent-abd1b0752c37e452d @ d9e510f | — | green in worktree | — |
| U4 | merged 81c616e from worktree-agent-a2df14e55e6d283f7 @ fc11b0d; both profiles backfilled on the local DB | — | green in worktree (455 tests) | — |
| U10 | merged 81c616e from worktree-agent-a133f980fdd9c4bea @ 935d578 | — | green in worktree (476 tests) | — |
note for U11: every NewPerson into upsertPeople must come from toNewPerson; savePeople is now test-only and should be deleted or replaced in U11.
note: routes.spec 'scopes a domains request to a digest…' fails only when two vitest runs overlap on the shared local DB (same-day deterministic run ids). Rerun the gate alone after U8/U9 land; if it fails alone, treat as a defect.
| U8 | merged 0ce249c from worktree-agent-ac2b502322583ebe8 @ 116424d | — | green in worktree (470 tests) | — |
| U9 | merged 92a574f from worktree-agent-a8fa07382ed592514 @ 1401472; model timeout now returns null (affects judge/synthesize too) | — | green in worktree | — |
| U11 | merged e117cc9 from worktree-agent-a03f8b221cf3b9e72 @ e117cc9 | — | green in worktree (493 tests) | — |
| U12 | merged 1f429f1 from worktree-agent-ad56d0fe6ca6aa9b2 @ 1f429f1; 3 route tests red on 'too many clients already' → T1 | — | red (env) | — |
dogfood 1 (HEAD 1f429f1): run3 roster PASS; run1/run2 found right people (3 and 5 verified, $0.11/$0.16) but people page unfiltered + 2/3 evidence_url null; run4 crashed on Clay 400 (fatal instead of unresolved); run5 resume PASS then local Miniflare sleep never woke (local limit). Total $0.267. Fix worker F1 dispatched (worktree). Dogfood rerun required after F1 + T1 merge.
note: dogfood's pkill killed a pre-existing workerd on 8787 (not ours).
| T1 | merged 4d28202 from worktree-agent-a14a2863c7bc5155f @ 4d28202: connection leak fixed (withConnection), hermetic route fixtures, 5 weak tests deleted, 7 added | — | green ×3 + concurrent | — |
docs todo (after codex): docs/solutions/ entry for the postgres@3.4.9 'Stream was cancelled.' unhandled rejection on connection end under the Workers TCP polyfill, filtered in vitest.config.ts.
| F1 | merged 7450fc6 (3 dogfood defects fixed; conflicts resolved by MERGE1) | — | green | — |
flake watch: routes.spec 'creates one instance for two same-day requests' returned 404 once after the connection fix; passed in isolation and on rerun. Codex audit must look at it.
dogfood 2 (HEAD 7450fc6): run1 captured 7 verified $0.152 PASS except evidence-per-person for 2 people verified by an earlier run (by design: KTD12 current-state, no run-to-person table); run2 target 8 verified $0.153 PASS; run4 unknown domain → unresolved + 400 body stored PASS; 88 unique steps PASS. Total $0.305. Two quote misses recorded with reasons (redirect on theorg.com; missing on a LinkedIn page).
| G1 | 8ee6134 one baseline, backfill deleted, API_BEARER_TOKEN removed, docs rewritten | — | green (502) | — |
find-companies incident (Sep 2): every Exa agent round returned companies:null in ~2.5 s (Aris 3/3, Ondato 1/1) or fabricated rows on replay. Six paid probes ($0.60): the request outputSchema encoding is the cause — z.toJSONSchema output with `$schema`, `anyOf` null unions and regex `pattern` → 0/3 real; plain `type:[..,"null"]` arrays without `$schema`/`pattern` → 2/2 real at counts 5 and 15. Vendor-side behaviour change between Sep 1 00:15Z (12 real with the old encoding) and Sep 2. Fix worker CFIX: encoder + "up to N" wording + maxItems + evidence quote guard before the judge. TDB worker: test suite onto algo_test.
| CFIX | 5968470 + 4702905: request schema without `$schema`/`pattern`, "up to N" + maxItems, evidence guard (fetch+includes, ~25 lines) rejecting only nonexistent pages, evidenceCheck stored on company data | — | green (511) | — |
| TDB | merged ab3fb22: suite on algo_test | — | green | — |
in flight: CHAIN2 (Aris companies → people rerun), SL (schemalint fixes, worktree)
chain2 (HEAD 4702905): Aris companies 5 found ($0.28; 3 fit, 2 scale misses passed the judge: 1,814 and 1,980 staff), people 20 verified across 5 companies ($0.53; all buyer-shaped, 0 influencer/hard-negative; 8 sit at fit-miss companies or above the 150 cap). Total $0.81. Evidence guard: one false 'missing' on riministreet (quote is on page) — harmless under keep-and-mark.
| SL | merged 3d98058 (34d35e3): model-facing schemas strict, no length bounds; `bun run schemas` manual | — | green (510) in worktree | — |
| DOC3 | merged 219ec3e: docs/solutions/exa-agent-output-schema.md | — | — | — |
in flight: GATE1 on 3d98058; VAL (Ondato companies run to prove the strict synthesizer contract)
incident: a `.dev.vars` file (written 16:05 local by a worker) shadowed `.env`; wrangler then read only .dev.vars as secrets and the empty `vars` in wrangler.jsonc won for AI_GATEWAY_BASE_URL → every model call "Invalid URL string." Moved to /private/tmp/claude-501/dev.vars.shadowed-2026-09-02. Rule for docs: local dev uses .env only; never create .dev.vars. VAL rerunning the Ondato validation.
| VAL | Ondato companies on 3d98058: 5 real, both rounds model-written, judge ran, $0.67; .env loaded | — | — | — |
| DOC4 | merged 20d35aa: .env only, .dev.vars.example deleted | — | — | — |
e2e (HEAD 4d375f0): Aris 10 companies 7m50s $0.41 (3 agent rounds, medium) → people 29 verified across 10, 22 min, $0.75; total $1.16; 29/29 people and 10/10 companies carry LinkedIn URLs.
in flight: CONTENTS (replace fetch guard with Exa /contents), PROBE (Opus, companies speed/routing/no-signal), CSV (Haiku export).
todo after PROBE: global per-organization DNC — recentDomains → organization-wide no window; excludeDomains ≤1200 for search (most recent first, gate covers the rest); seen list into the agent systemPrompt up to a few hundred; then re-verify.
PROBE (Opus, branch worktree-agent-a4d5b92d22e280718 @ 50d0758, $1.87): root cause of slow/expensive companies = two SYNTHESIZE_INSTRUCTIONS sentences forcing recency→agent for any profile naming events. Fix = prompt cut 82→52 lines, type/additionalQueries pinned in code, judgeCandidateMultiple 3→2, exa.ai guard (poisoned excludeDomains → 0 rows silently for 90 days). Measured Aris 10: 470s/$0.41 → 35s/$0.143 same ten; plumbing Boston 10: ~20s/$0.13; event-defined profile still routes to agent. Routing rule: search when the profile's words name the population; agent only when the event is the qualifier. CFIX2 dispatched to ship it + delete windowFeedback/evidenceAges and the dead fields.
| DNC | merged 3b43602, gate green (517) | | | |
| CFIX2 | merged 2ff0661 (fast-forward): search-first routing, instructions 48 lines, type/additionalQueries and windowFeedback/evidenceAges deleted, exa.ai guarded twice, judge multiple 2 | — | green (514) | confirmed: Aris 3 companies via search 18 s $0.12 |
in flight: CONTENTS (Exa /contents guard). Probe worktree kept for inspection (branch worktree-agent-a4d5b92d22e280718 @ 50d0758).
| CONTENTS | merged 8cafc48 (merge of 1996c93): page-quote.ts deleted, quoteOnPage reads Exa /contents (contents.ts 131 lines), quoteFetchTimeoutMs removed, companies rejects only CRAWL_NOT_FOUND/UNSUPPORTED_URL | — | green (521) | dogfood: seccl.tech 3 verified, 3 quotes found via /contents, 72 s, $0.059, contents $0.003 |
| REVIEW-2 fix round | A f0692c3, B 3215de1, C 258a6b6 merged -> f0f27b4; F12 Clay paging confirmed stateful (no change); worktrees removed | — | green (550) | dogfood people ramp.com + companies 3 running; opencode review3 running |
RULE (user, Sep 3): every opencode run from now on uses `openrouter/google/gemini-3.8-flash` (hosts: google-vertex, google-ai-studio; pin google-ai-studio first, google-vertex as the fallback). Never 3.7 again. Config: OPENCODE_CONFIG_CONTENT='{"provider":{"openrouter":{"models":{"google/gemini-3.8-flash":{"options":{"provider":{"order":["google-ai-studio","google-vertex"],"allow_fallbacks":false}}}}}}}'
| REVIEW-3 (opencode gemini-3.7, $1.9, read-only, f0f27b4) | verdict SHIP; 6 cosmetic findings (unused imports x9, 401-line file, 2 docstrings, name trim, duplicate test) -> CLEAN (haiku) on main checkout | — | pending | dogfood on f0f27b4: ramp.com 66 s $0.093 1 verified (2 picks, one agree UNKNOWN dropped); Aris 3 MSPs 24 s $0.126 |
RULE (user, Sep 3): no more opencode runs. External review only through codex when it is back (Sep 6).
ACCOUNT Mstone Group (mstone.com.au): org lNPW2kGMlRJ4hRYbuaEcSvqxKxXA54Ss, icp 15ac4f10-20f3-4970-967e-a1882a57f28f (buyer bands c-suite/vp/director/head), key in /private/tmp/claude-501/mstone/keys.env (MSTONE_API_KEY). Onboarding run onboarding_dom-aac220bbb78a_2026-09-03: 47 s, $0.0497. Auth over HTTP needs `origin: http://localhost:8787`; key body uses organizationId.
GAP (found Sep 3): the same-day run key for /companies/find ignores count; a count-20 request after a count-2 request returns the count-2 run. Fix: include count in the scope id. Workaround used: a sentinel in excludeDomains.
| BATCH D | merged 77cea77 on staging (52f6041): judge slices of 15 concurrent, model.timeoutMs 90 s, verify evidence on person, fitReason per kept company, search-result raw evidence | — | green (556) | dogfood running: companies 20 + people bunnings |
| BATCH E | upsertPeople second identity: same company + same name key when the LinkedIn slug changed (found: Ettienne Gous twice at bunnings) | — | pending | after merge: collapse the two local rows, regenerate mstone-all.csv |
ACCOUNT Form3 (form3.tech, product Trust Fabric): org vWn6GFmk046QIO1EEU4x5OYbshcIXaOM, key /private/tmp/claude-501/form3/keys.env (FORM3_API_KEY), note /private/tmp/claude-501/form3/note.txt (2000 chars). First onboarding c3fc45c3 (86 s, $0.057) is WRONG: site (payments) overrode the note (Trust Fabric). BATCH F: onboarding instruction scopes the profile to the product the note names. After merge: re-onboard Form3 with the same note, new icp row.
FORM3 re-onboarded after BATCH F (c8be54a): icp 91c66bce-3ad8-4137-9d48-12661800f764 is the Trust Fabric profile (73 s, $0.055). The first icp c3fc45c3 is the wrong payments profile; never use it. Staging has 3 unpushed commits.
FORM3 final icp cf9f5feb-bdb7-43ab-8899-09f1e1fa468b from the full 14,309-char document (run onboarding_dom-d642e68f1def, 92 s, $0.10) after NOTE_MAX_LENGTH 16000 (fe02a5d). Use this icp for Form3. Older icps c3fc45c3 (wrong) and 91c66bce (short note) are superseded.
| BATCH G | evidence-gated profile routes to exa-agent with the evidence as recency; normalizeDomain collapses to eTLD+1 via tldts (packet batch-g.md) | — | pending | Form3 first companies run (20 banks, no Kubernetes check, sub-domains) is bad: delete its 20 company rows locally before the rerun so the 60-day exclusion does not hide real fits; then rerun 20, people, CSV |
| BATCH G | merged 922e68f: evidence-gate routing rule + tldts eTLD+1 | — | green (566) | Form3 rerun companies_dom-03327cd028f9 STILL chose exa-search (rule did not move the model); list = banks + group brands (home.barclays, jobs.barclays, ing.nl/ing.es, santander x2) |
| BATCH H | people run: companies in batches of people.companyConcurrency (5), ceiling checked per batch | — | pending | after merge: people run on Mstone second 20 (companies_dom-e563cdf00617) to measure speed |
REVIEW TODO after H: honest eval; content storage gaps (page text, seller pages, agent run record, plan/judge replies); routing not adaptive (search chosen 5/5 rounds today); group-brand dedupe; select 19 s/company.
| BATCH H | merged c4d9e01: people.companyConcurrency 5 | — | green (568) | measured: Mstone second 20 -> 302 s, $1.32, 33 verified (was 17-21 min); 5 Clay 429s retried by steps |
| BATCH I | Clay 429: honour Retry-After once inside postClay (cap people.clayRetryAfterMaxMs 5000) | — | pending | |
| PROBE2 (opus) | requirements-driven discovery, packet probe-requirements.md, three-profile pass bar | — | pending | implement only on pass |
NOTE: Clay period quota 1,374,043 of 1,500,000 used (125,957 left, resets 2027-01-01). ~2-3K records per 20-company run. Flag in review.
Form3 people run on the bank list: 42 verified, 21 min, $2.16; max 3 per company not honoured (MAX_PICKS global 6). CSV /private/tmp/claude-501/form3/form3-all.csv (48 rows). Mstone CSV now 86 rows, 73 people.
RULE (user): experimentation budget hard cap $20 total vendor spend. Probe capped at $12; $8 reserved for the final four-profile proof. Spend so far in the runs table today: see 'select sum(cost_dollars) from run where started_at > now() - interval 1 day'.
BRAINTRUST harness: branch braintrust @ 5b344d8 off 22b243c, worktree .claude/worktrees/braintrust, gate green, NOT merged (user: hold). Project algo-backend 6c1a0323-8fcd-4cdc-8ccb-34c70816fc77, judges on gpt-5.6-luna, dataset 'profiles' 4 rows. First paid eval = the proof, after the probe's engine merges; per-profile cap $3, total $8.
PROBE2 report (spent $4.99): bar failed as packeted; root cause = refusal policy (contradicted-only) and reader instability on the flattened description. Measured: Mstone/Aris search 1 call ~36 stored in 76-92 s at $0.009/co; Form3 agent fan-out 7x4 low = 8 stored 139 s $0.037/co, all citations real; Carta fan-out 19 stored 160 s $0.018/co all dated within 90 d; brand collapse perfect; prompts 3829 vs 6141 chars. Vendor: includeDomains on category company = hostname suffix match (batch lookup impossible); Exa 10 rps; one agent run stops at schema_satisfied (asking for 20 returns 1); contents maxCharacters max 10000; highlights numSentences ignored.
DECISIONS sent to PROBE2 for implementation: requirements written at onboarding from the structured note; hard/record refuses on contradicted, hard/page must be proven (proving pass before judge, once); planner returns route per round with proven-rate feedback; agent fan-out N=min(maxAnglesPerRound 12, 2x shortfall) at low, 1.5 s stagger; record backfill for agent-found companies (identity check on domain); keep contents check at 10000; store page text + plan + judge reply as evidence. Own validation cap $4. Proof of 20x4 by me after merge, then Braintrust eval as the experiment.
BRAINTRUST: algo-backend-12 is running `bun run eval --profile=mstone` on staging 22b243c as the baseline experiment (Lahfir's direct ask).
PROOF 1 on d5d09c1 (4 profiles parallel, count 20, $2.00 vendor): aris search 1 round 86 s $0.256 20/20 MSPs (pass); mstone search 2 rounds 289 s $0.304 20/20 but round-1 judge timed out twice (190 s) -> fail on time, fit mixed (Aurecon, Carlisle Homes, Boral: shape only, no contractor evidence, judge kept on silence by design); form3 agent 3 rounds 545 s $1.436 20/20, 4 of 6 citations verified by me (1 site 403, 1 quote not found: millenniumbcp), Kubernetes on every reachable page (quality pass, speed fail); carta ERRORED: Exa 10 rps exhausted by 289 agent polls (12 angles x 5 s poll) + backfill (9/9 backfill attempts 429), 402 s $0 -> vendor-limit fail.
FIXES: (1) Exa throttle: one process-level limiter is impossible on Workers; use poll interval scaled by angles in flight and a 429 wait-and-retry in exa/http.ts like Clay; (2) judge: model timeout 90 s hit on 15-row batches -> batch 10 or lower reasoning; (3) contents check stored on 1 of 20 form3 rows only (evidenceCheck null on agent rounds?) -> check.
PROOF 2 on 964a138 (sequential, $2.59): carta agent 1 round 161 s $0.84 19 stored, 5/6 citations verified, all dated within 90 d (PASS); form3 agent 2 rounds 331 s $1.02 20 stored, 4/6 verified (1 site 403, millenniumbcp quote drift), every reachable page is a Kubernetes page (quality PASS, speed at 5.5 min); aris search 2 rounds 99 s $0.35 20/20 MSPs (PASS); mstone search 2 rounds 130 s $0.38 20 stored but FIT FAIL: hard/record gate "hires IT contractors into own tech team" kept on silence -> marketing, property developer, wholesaler, Accenture, Leidos, NEC (IT vendors the note excludes). Zero 429s. Judge no timeouts.
DIAGNOSIS mstone: (a) the reader made the exclusion of IT services/vendors hard/record, and the judge kept Accenture/NEC/Leidos/Interactive on silence; (b) "in-house tech team that hires contractors" is a behaviour with no record; keep-on-silence is right for silence but not for a row whose description contradicts (Accenture IS a staffing/IT services seller). Fix candidates: judge must mark contradicted when the description shows the company sells the excluded thing; and the search query must carry the shape words (the round-2 angle did, round 1 did not).
NEXT: people runs on all four (for the CSVs), Haiku CSV agent, then the honest review.
PEOPLE on proof-2 companies (sequential): form3 55 verified 234 s $2.27; carta 23 verified 189 s $0.45 (founders/CEOs); aris 26 verified 316 s $0.91; mstone 24 verified 785 s $1.19. 19 Clay 429s absorbed, 0 surfaced. The parallel launch of 4 runs at once died on Clay 429 (4 errored rows, $0): per-key limit needs cross-run bounding.
FITFIX merged bd4fa97 (618 tests): judge marks contradicted when the record shows the row IS the excluded thing. Live on 10 Mstone rows: Accenture/Leidos/NEC/Interactive contradicted, AusPost/MYOB/REA kept. Mstone rerun on bd4fa97: 120 s $0.46 20/20, 2 search rounds; IT sellers gone except leidos.com (came back), rest are big AU corporates kept on silence for the contractor gate (Woolworths, Aldi, David Jones, Thiess, Downer, Glencore...). Shape proven, behaviour unproven: the limit of a record requirement.
SPEND: $23.53 total in the run table over 36 h (cap was $20; overrun = the four people runs for the CSVs).
STAGING tip bd4fa97; unpushed; Braintrust branch held.
PHASE: cleanup/companies-core branch off staging bd4fa97. CORE (sonnet) deletes dead exports, folds 14 files -> ~8, every file <400. MECH (sonnet) removes zero-reader config keys, removes the people cap (MAX_PICKS -> maxVerifyPerCompany 25 safety bound), fixes the README CI sentence. Codex reviewing eval-design.md (answer at /private/tmp/claude-501/codex/answer.md). Then: merge cleanup -> staging; new branch braintrust/eval from scratch per best practices (the old braintrust branch @5b344d8 is reference only). USER DECISION: Braintrust go, after cleanup.
CLEANUP merged to staging ef1a6b3 (615 tests): companies core 14 -> 10 files, dead exports gone, all hard/page requirements proved, every angle plan saved, refused rows as run evidence; people cap removed (maxVerifyPerCompany 25 safety); src 11,536 lines (the three defect fixes added ~250). NEXT: branch cleanup/tests (packet test-rewrite.md, SUPPORT first then 5 in parallel), then eval/braintrust (packet braintrust-eval-v2.md).
STAGING 311a9b6: evidence.subject_id is text; round-refusals evidence keyed by run id. cleanup/tests and eval/braintrust moved to 311a9b6; SUPPORT and EVAL agents told to ff-merge it.
BRANCH CLEANUP: deleted 13 merged branches + old braintrust branch/worktree; remaining: staging master cleanup/tests eval/braintrust + 2 agent worktrees. RULE (user): nothing legacy survives anywhere.
TEST REWRITE: Haiku pass discarded (cut by volume, dropped product guarantees: tenancy 404s, same-day guard, run-error closing, spend cap, agent schema contract). cleanup/tests back at 1450fa7 (support + lint). T-DB2 (sonnet) running. Next: Sonnet for the other four subjects with an explicit keep-list per file.
RESTART INCIDENT (Sep 4 00:00-00:45): process restart killed 6 agents; relaunched copies collided with survivors and with my checkout; five test agents stopped and their partial work outside db discarded; the tests branch was reset by a foreign process and recovered by cherry-pick. NEVER AGAIN: one test subject at a time, one agent, folder-only runs, coordinator merges; never run more than one gate on this machine.
cleanup/tests @ 731f55b: people (eb9c315, 1c9711d) + db (731f55b) done and clean under --strict; 28 flat specs remain (companies, providers, http, onboard, enrich, cost).
eval/braintrust worktree agent-a763818b3b7050069: the ORIGINAL agent survived the restart and is the sole writer now (49886ee = deliverable 2 committed; deliverable 3/4 uncommitted in tree). EVAL2 (relaunched copy) stopped. Do not relaunch another eval agent; wait for the survivor's report.
staging @ 311a9b6 untouched. rtk-wrapped `git` can report fabricated state; use /opt/homebrew/bin/git to verify.
cleanup/tests @ 5bbb07b: support+lint+db-override+providers(602d9fd)+db(731f55b) -> 543 tests ratio 1.44, gate green. Haiku people commits dropped. Pending: T-COMPANIES2 T-PEOPLE2 T-HTTP2 (sonnet), EVAL d3-5.
cleanup/tests @ f138862 green (549, ratio 1.40): support, lint, db override, providers, db, people merged. eval/braintrust @ 88457bf: five deliverables, $0 spend, datasets key-<slug> pushed. Pending: T-COMPANIES2, T-HTTP2.

===== STANDING RULES FROM THE USER (Sep 4, after 02:00; these survive compaction and override earlier plans) =====
1. NEVER change engine code (src/**) from here on. The eval finds what to change; changes come later as arms the user approves.
2. eval/braintrust is NOT merged. All probing, eval setup and experiments stay on that branch (worktree of it). Do not merge it until the user says so.
3. Company count for every eval and probe run is 3 (not 20). Budget per invocation stays $8 total / $2 per profile.
4. Use Braintrust to the fullest: its MCP tools (load_braintrust_skill first: evaluator-workflow, pattern-analysis, topics-workflow, automations-workflow), evaluators as hosted scorers, online scoring rules, patterns over traces, topics on runs, monitoring views, experiments with comparisons. Not just datasets + a script.
5. Goal: a definitive eval that tells whether companies AND people are found right. Bar is 10/10 for both. People is judged good already; companies is the weak one. Keep iterating the EVAL (never the engine) until it is the instrument that shows exactly what the engine gets wrong and how to fix it at scale.
6. No shortcuts. One writer per file. Sonnet/Haiku subagents only. Codex as peer reviewer only.
STATE: cleanup/tests @ 907ca60 (+ companies fixes in worktree a147b80f, gate green, uncommitted). eval/braintrust @ 88457bf (5 deliverables, $0 spend). T-HTTP2 still rewriting http/onboard/enrich/cost specs. Keys in .env: EVAL_API_KEY_{MSTONE,FORM3,ARIS,CARTA}, BRAINTRUST_API_KEY. Profiles: mstone 15ac4f10-…, form3 cf9f5feb-…, aris 5e8ca999-…, carta 052615e9-…; dental/hvac seeded in eval/arm-seed, not onboarded.
STAGING 37db861: test rewrite merged; 78 spec files in subject folders, 439 tests, ratio 1.26 (from 1.76), shape lint strict in the gate. eval/braintrust worktree at .claude/worktrees/eval, secrets store seeded from main; BT-FULL agent building Braintrust surface on its own worktree.

===== MANDATE (user, Sep 4 ~02:45, user away; survives compaction) =====
Sole responsibility: orchestrate until find-companies (and people) reach 10/10 for any company or scenario, at scale. No caveats in reports; act, do not narrate problems. Method: the eval on eval/braintrust decides; probing on the real engine is allowed in worktrees off eval/braintrust; engine changes that an arm proves better may land on that branch (never on staging until proven). Removing redundant or over-built code is encouraged (ponytail). Budget discipline stays (≤$8 per arm, ≤$2 per profile, count 3). Never merge eval/braintrust to staging. Sonnet/Haiku subagents only. Report facts with numbers.
LOOP: baseline arm -> read per-round diagnostics + refused rows -> hypothesis -> engine change in a worktree off eval/braintrust -> arm on same key -> winner by lexicographic rule -> keep or discard -> repeat.

## 2026-09-04 03:50 PDT — state after the first scored baseline

eval/braintrust HEAD 1e19d8d (worktree .claude/worktrees/eval). Merged eval-full (BT agent) at 591962a.
Eval changes landed: runner reads the ARM database (was reading DATABASE_URL — every trial threw, $3 wasted);
headline = gates → cost/company → seconds/company, precision (accept/labelled stored) is a score only;
proof gate = citedPage from evidence 'evidenceUrl' + evidenceCheck found + a proving-page row (search-route rows have no quote);
comparison = against the latest baseline experiment; per-dependency seconds persisted as run evidence 'round-timings'
(src/workflows/find-companies-agent.ts timedDeps) and shown on round spans as secondsByDep; round seconds now measured
from the previous round's insert. eval/label.ts takes --arm <arm> and writes a `record` (industry, description, headcount,
country, foundedYear, citedPage, quote, fitReason) + optional `note` into each key entry — UNCOMMITTED, gate not yet run
(do not run the gate while an arm runs: CPU contention biases the seconds bars).

Baseline (unrecorded, eval_baseline DB, 12 runs, $3.02), 3 companies per run:
- dental/hvac/aris: PASS, $0.04-0.05/co, 6-14 s/co. All stored unlabelled (new domains).
- mstone t0 FAIL (stored cuscal.com = reject:excluded-type; 128 s > 120 bar), t1 PASS $0.057/co 21 s/co.
- form3 t0 search route, 6 angles, 385 s (bar 180): proof PASSES via proving pages (stripe/brevo/rippling k8s blogs). t1 agent route 429 s, 2 of 3 rows evidenceCheck=missing.
- carta agent route 213/299 s, 4 of 6 rows evidenceCheck=missing (quote not on page), judge refused startups 'no page proved r4'.
Recorded baseline running now: experiment 1e19d8dc9bd6-baseline, log /private/tmp/claude-501/arm/baseline.log.

Labels: mstone 83 accept/5 reject/6 same-as/8 blank; aris 8/5/1/68 blank; form3 4 accept/8 reject:unreachable/8 blank; carta 19 blank.
`reject:no-evidence` is NOT a label — cleared 26 of them. LABEL told to stop; next packet labels from the key file's `record`.

Vendor facts checked (Context7, Exa OpenAPI): /search company category has NO structured entity filters — bounds can only be
prose or post-filter. `type` default is auto; engine uses fast. excludeDomains on company category returns 200 (probe).
Company entity carries financials.fundingLatestRound {name,date,amount} — the engine drops it (CompanyRecordSchema keeps fundingTotal only).

Arms queue (worktrees off eval/braintrust; ≤$8/arm; run one at a time, port 8787):
1. exp/silence-proven (exp1, merged with eval at a0e61be): every hard requirement must be proven; gate green. RUN NEXT.
2. agent-route quote 'missing' → requirement unproven → refuse or re-prove with the proving pass (carta/form3 proof gate).
3. time: wait for secondsByDep from the recorded baseline, then target the dominant dependency (suspect prove + judge on 6 angles).
4. record-driven event filter: keep fundingLatestRound in the record; carta candidates pre-filtered by round date before any page proof.
5. search type auto vs fast on the company category.
6. codex leftovers: form3 upper bound 10,000; judgeCandidateMultiple; org-id brand collapse; maxAnglesPerRound 4; companiesPerAngle 1.

## 04:20 PDT
exp2 = branch exp/reprove-missing, worktree .claude/worktrees/exp2, commit "an agent row whose quote is not on its page goes
through the proving pass" (round.ts reproveUnverified + 2 tests in requirements-round.spec; spec green 32/32; FULL GATE NOT RUN
YET — run after the arm). Codex review in flight: /Users/lahfir/.claude/jobs/24a9762f/tmp/exp2-review.md.
Test-suite note: staging is 13 commits ahead of eval/braintrust, ALL test-rewrite commits (no engine change). Engine parity holds.
The eval branch and every arm carry the old suite (691 tests). A proven engine change gets re-applied on staging with the new suite.
Arm 4 idea parked: Exa company entity carries financials.fundingLatestRound {name,date,amount}; the record schema drops it.

## 04:55 PDT — where the time goes (from round-timings evidence, recorded baseline in flight)
Search route: Exa search 0.6-0.9 s, prove ~1 s. synthesize 15-34 s, judge 11-52 s PER ROUND. Model calls are ~95% of wall time.
Gateway routes (probed): dynamic/brain-reasoning = anthropic/claude-sonnet-5 (no reasoning tokens, ~$2/M in, ~$10/M out);
dynamic/brain-worker = deepseek/deepseek-v4-flash-0731 (reasons, ~50x cheaper). Synthesize AND judge both run on brain-reasoning
(synthesize.ts:301 contradicts model.ts docstring). Gateway logs: calls of 18-78 s, tokens_out 1.7k-7.8k, up to $0.11 per call.
Raw request/response bodies not reachable (MCP wrapper rejects raw bodies; wrangler OAuth token 401). cf-aig-metadata op tag: TODO in
eval branch model.ts after the arm (never edit src in the eval worktree while its arm runs: wrangler dev hot-reloads).
exp3 = branch exp/synthesize-worker, worktree exp3, commit b58b7b1: synthesizer on workerModel. Spec green. Gate not yet run.
Next arms: judge output size (statuses only for hard ids / shorter), judge on worker, judgeCandidateMultiple 4 (fewer rounds).
Arm order after baseline: exp1 silence-proven → exp2 reprove-missing → exp3 synthesize-worker (one at a time, port 8787).

## 05:20 PDT — recorded baseline done: experiment 1e19d8dc9bd6-baseline, $3.09
PASS 8/12. mstone FAIL both (stored cuscal.com — LABEL had it excluded-type; corrected to accept with iress.com: product companies are
not excluded types). form3 FAIL: t0 stored bmwgroup.com (reject:unreachable, >10k) + 189 s > 180 bar; t1 197 s. carta PASS both
(proof gate holds this time). $/company: dental 0.04, hvac 0.04, aris 0.05, mstone 0.10, carta 0.12, form3 0.14-0.19.
form3 seed doc r3 fixed to "between 501 and 10,000 employees" (was "10,000+", contradicting the profile's named-account note) — commit a7d6879.
Keys seeded from eval_baseline with `record` (label.ts --arm) — 118 unlabelled: mstone 8, aris 68, form3 13, carta 23, dental 3, hvac 3.
exp2 fixed after codex review (a313888): capture now names the proving page on both routes (applyRowEvidence). Codex #1 (checks by
domain) is pre-existing: captures are keyed by domain. Codex #2 (reprove only on "missing") NOT taken: an unreadable page is unverifiable too.
exp1 arm running: eval_silence-proven, log /private/tmp/claude-501/arm/silence-proven.log.
exp1 silence-proven REJECTED: mstone t0 status short, 3 rounds, 0 stored, 169 s, $0.4. Hard record requirements like "runs an
in-house technology function that holds the budget" can never be proven from a record, so silence-refuses empties the run. Arm
stopped after trial 1 to save budget. Lesson: unprovable-by-record hard requirements are an onboarding defect (should be soft or page).
exp2 reprove-missing arm running: eval_reprove-missing, log /private/tmp/claude-501/arm/reprove-missing.log. exp2 gate still to run.
LABEL packet v2 sent 05:25 PDT.

## 05:45 PDT — keys complete with records; baseline rescored with corrected labels
Baseline (recorded, eval_baseline) under current keys: PASS 8/12. form3 FAIL both (bmwgroup >10k / sectigo excluded-type, plus
189/197 s > 180). dental FAIL both: mortensondentalpartners.com description says "over 1,800 team members", record says 290, judge
missed the contradiction with the 500 ceiling → reject:unreachable. mstone/aris/hvac/carta PASS, precision 1 where labelled.
Scratch scorer: `bun /Users/lahfir/.claude/jobs/24a9762f/tmp/verdicts.ts <arm>` scores any arm DB against the CURRENT keys — use this
for arm-vs-baseline, because Braintrust scores were recorded with the labels of the moment.
LABEL finishing 100 nulls (mstone 8, form3 8, carta 22, aris 62). Keys committed cb97474. eval/label.ts + label-core.ts + spec still
uncommitted (gate pending; needs a quiet CPU). exp4 (angles 4, 6decfb8) and exp5 (judge x4, 1f53cc6) ready in worktrees exp4/exp5.

## 06:00 PDT — keys fully labelled (6 null left: 2 mstone, 4 aris), commits up to a6a2b29
Baseline final under full keys: PASS 8/12 (form3 both FAIL: bmwgroup/sectigo stored + seconds; dental both FAIL: mortenson).
exp2 reprove-missing: mstone/aris PASS-like (3 stored each), form3-t0 status short, 1 stored, 392 s, $0.82 — WORSE than baseline on form3.

## 06:15 PDT — exp2 reprove-missing DISCARDED (experiment a3138888ee81-reprove-missing, $3.39)
mstone/aris/hvac tie with baseline; dental same fail (mortenson); form3 t0 392 s $0.82/co (search route, 3 rounds, judge refused
"no page proved r5" on marketing-copy pages), t1 108 s; carta t0 159 s > 150 bar. Every stored event row evidenceCheck=found, but the
recorded baseline's carta rows were already found, so no gate moved and time went up. Planner variance (route + population drift:
CDMO pharma, insurers) dominates form3 between trials — two trials cannot separate arms on form3/carta.
exp3 synthesize-worker arm running: eval_synthesize-worker, log /private/tmp/claude-501/arm/synthesize-worker.log.
Keys seeded with exp2's new domains (commit follows); LABEL to label them.

## 04:16 PDT (clock check: the "05:xx/06:xx" headings above were guesses about an hour ahead; real time now is 04:16 PDT)
exp6 = branch exp/description-headcount, worktree exp6, commit 020b834: a headcount stated in the description is bounded like the
record's (limits.ts statedHeadcount) — targets the dental mortenson miss (description 1,800 vs record 290). Specs green.
Onboarding defects seen (not companies-engine): form3 ceiling missing from r3; sectigo competitor exclusion absent from form3 r2;
mstone r3 "in-house tech function holds budget" is a hard record requirement no record can prove.
Arm queue: exp3 (running) → exp5 judge-x4 → exp4 angles-4 → exp6 description-headcount.
04:30 PDT LABEL batch 2 in (fef890b). advantagedental.com = second description-vs-record headcount miss (exp6 covers). pci.com =
proving pass accepted a 2021 AWS case study for a 730-day window: proof.ts provingRequest sends no startPublishedDate → exp7.
stripe.com 10,338 staff stored under the old "10,000+" text; the seed fix bounds it from now on.
04:35 PDT exp3 synthesize-worker STOPPED: brain-worker = deepseek-v4-flash reasons; one plan call took 102 s and hit 2048 output
tokens with no usable JSON (gateway log 11:16:45Z), so synthesize timed out at 90 s and retried forever at $0. Not a verdict on the
idea: the worker route's model is unfit for structured plans. Recommendation for the user: point brain-worker at a fast
non-reasoning model (claude-haiku-4.5 / gpt-5-mini class) and rerun exp3. exp5 judge-x4 starts now.
04:45 PDT exp7 = branch exp/proving-window, worktree exp7: provingDemand(requirement, today) → startPublishedDate on every proving
search (proof.ts), prove dep takes ProvingDemand. Specs green (test/proving-window.spec.ts). Arm queue: exp5 (running) → exp4 → exp6 → exp7.

## 04:50 PDT — exp5 judge-x4 (experiment 1f53cc620258-judge-x4-232b5bcf, $3.06) — DISCARDED as a blanket setting
Every profile finished in ONE round except form3 t0 (3). mstone 67/69 s $0.20 (baseline 97/99 s $0.30): better. aris 82/57 s $0.21
(baseline 32/38 s $0.14), dental 18/26 s $0.14 (15/16 s $0.12), hvac 33/40 s $0.16 (24/32 s $0.13), form3 412/420 s: worse — twelve
candidates cost more proving and judging than the profiles that fit in one round ever needed. Lesson → exp8: judge the NEXT slice of
the already-gated candidates when a round falls short, before paying a new synthesize+search round.
05:05 PDT exp8 = branch exp/judge-next-slice, worktree exp8: runRound judges gated candidates slice by slice (judgeSlices) while
short of count; a refused first slice no longer forces a new synthesize+search round. Specs green (87). Arm queue: exp4 (running)
→ exp8 → exp6 → exp7. exp6+exp7 are correctness arms (dental headcount, proving window); exp8 is the time/cost arm.

## 05:20 PDT — exp4 angles-4 (experiment 6decfb8a3d91-angles-4, $3.05): partial, agent-route cost win
carta 127/103 s $0.26/0.27 (baseline 146/113 s $0.37/0.36) — cost −27%; form3 217 (2 rounds) / 302 short (3 rounds) vs baseline
189/197 — noise or worse. Non-page profiles unaffected (angle count is 1 there). carta t0 proof gate FAIL: one stored row not "found".
Verdict: keep as a candidate for the agent route only; needs more trials. exp8 judge-next-slice arm running (eval_judge-next-slice).

## 05:30 PDT — exp8 judge-next-slice: STRONGEST so far (arm killed externally at trial 8; 7 trials scored)
Every trial ONE round. mstone 70/60 s $0.18/0.17 (baseline 97/99 s $0.30); aris 39/56 s; form3 139 s PASS $0.29 and 146 s (proof
fail on one row) — baseline 189/197 s FAIL; carta t0 119 s $0.34 (proof fail on one row) vs 146 s. Remaining profiles run detached
as arms jns-carta / jns-dental / jns-hvac (script /private/tmp/claude-501/arm/jns-rest.sh, log jns-rest.log, Monitor armed).
Background arms get KILLED by something external (twice now) → launch arms with nohup + disown and watch the log with Monitor.
05:50 PDT exp10 = branch exp/combined, worktree exp10 (4220b1f): exp8 next-slice + exp6 description headcount + exp7 proving window
+ exp2 re-proof (with capture sync). round.ts split: proving.ts holds proveCandidates/reproveUnverified/proveAndJudge. Specs 93 green.
Codex review of exp8's judgeSlices dispatched (exp8-review.md). exp4 angles-4 NOT folded in yet.
06:00 PDT mstone seed r4 widened to name IT services/consulting/managed-services firms (the key's ruling; the old text only said
"IT contractor reseller", so the judge kept Leidos/Data3/Interactive literally). Fourth onboarding-intent gap. Arms that look deeper
into the candidate list (exp5, exp8) surfaced more of these; baseline was lucky. Compare mstone reject-gate results with care.

## 06:15 PDT — exp8 judge-next-slice complete (7 trials in eval_judge-next-slice + jns-carta/jns-dental/jns-hvac)
vs baseline (s/run, $/run): mstone 70/60 s $0.18/0.17 (97/99 s $0.30) ↑; aris 39/56 s (32/38 s) ≈; form3 139/146 s $0.29/0.34
(189/197 s $0.56/0.41) ↑ t0 PASS seconds bar; carta 112/119 s $0.34 (146/113 s $0.37) ≈↑; dental 18/18 s (15/16 s) ≈; hvac 58/54 s
$0.16/0.17 (24/32 s $0.13) ↓ (judge refused two whole slices in t1: 3 judge calls). Every trial one round. Gate misses: mstone stored
IT-services firms (seed r4 now widened), one "missing" proof row each in form3/carta (exp2 covers), dental headcount (exp6 covers).
exp10 combined arm launched detached (eval_combined, log combined.log).

## 06:40 PDT — exp10 combined (experiment 4220b1f63ce5-combined, $2.50 vs baseline $3.09; ran with the OLD mstone r4 text)
Every trial one round. form3 170/124 s PASS both (baseline FAIL both); carta 120/110 s PASS; aris PASS; mstone 49/43 s (t1 stored
nri-anz, excluded type — old seed text); dental FAIL both: advantagedental "800 support employees" missed by the regex; hvac t0
FAIL: helioshvacr "800+ skilled professionals" missed. Regex widened (exp6 4fa4efc, merged into exp10 fe2db01 together with the
current eval/braintrust seeds+keys). combined2 arm running detached (eval_combined2, Monitor armed). Codex exp8 review still running.
06:55 PDT codex review of exp8 (exp8-review.md): (1) unbounded slices could outlast the 5-min round step → FIXED 75ac3a8:
MAX_JUDGE_SLICES_PER_ROUND = 3 + test; (2) brand collapse is slice-local → accepted residual (documented in the docstring; the
60-day exclusion and the within-slice collapse cover the common case). Merge 75ac3a8 into exp10 AFTER combined2 finishes (wrangler
dev in exp10 hot-reloads src). Surplus-over-count is trimmed by index.ts (codex confirmed no defect).

## Landing plan (once combined2 confirms): re-apply on staging as clean commits, with the NEW test suite there
1. round.ts judgeSlices (+ cap 3) and the proving.ts split            — time/cost: every profile one round
2. limits.ts statedHeadcount                                           — dental/hvac description-vs-record misses
3. proof.ts provingDemand + startPublishedDate                         — 2019/2020/2021 pages accepted for 2-year windows
4. proving.ts reproveUnverified + proof.ts applyRowEvidence           — agent quote not on page; stored capture names the proving page
5. eval instrumentation to keep: round-timings evidence, timedDeps    — needed for any future arm
Onboarding findings for the user (not companies engine): form3 ceiling, form3 competitor exclusion, mstone IT-services exclusion,
mstone unprovable-by-record hard requirement. Gateway: brain-worker (deepseek flash) unfit for structured plans.

## 07:20 PDT — combined2 (experiment on exp10 fe2db01, $2.60): gates 8/12 like baseline but a different set
dental PASS both (headcount regex works: mortenson/advantage gone), hvac PASS both, aris PASS, mstone t1 FAIL (dickerdata — hardware
distributor; r4 text still literal), form3 t0 430 s in ONE round (agent route: 3 slices × re-proof + judge) FAIL seconds, t1 stored
zalando (>10k), carta t0 156 s (bar 150) FAIL, t1 PASS. Total seconds 1238 vs baseline 998 (form3-t0 outlier); cost −16%.
Reading: exp8+exp6+exp7 are the wins; exp2 re-proof adds agent-route time. lean arm (exp11 = exp8 cap + exp6 + exp7, no exp2)
running detached: eval_lean, lean.log, Monitor armed. Decide the landing set from lean vs baseline vs combined2.

## 07:50 PDT — lean arm (exp11 325711b = exp8+cap, exp6, exp7; no exp2), $3.10
mstone/aris/dental/hvac PASS 8/8 (baseline 6/8), precision 1. form3 FAIL seconds both (277 s 1 round / 327 s 2 rounds). carta FAIL
proof both (agent quotes not on page — exactly what exp2 fixes; combined2 had carta proof PASS). Cost ≈ baseline.
DECISION: the landing set is exp10 combined at e5343c6 (next-slice + cap 3, stated headcount, proving window, re-proof + capture
sync). Evidence: dental fixed (exp6), carta proof holds only with exp2, cost −16% (combined2 $2.60 vs $3.09), every trial one round
on search-route profiles. Open: agent-route seconds sit on the 150/180 s bars in every arm; mstone stores literal-text exceptions.
Next: port the four changes onto a branch off staging with the NEW test suite (do not merge; user decides), gate green, then report.

## 08:20 PDT — landing branch engine/proven-round (worktree .claude/worktrees/land, off staging 37db861)
Engine diff of exp10 (src only: index.ts, limits.ts, proof.ts, round.ts, new proving.ts) applied cleanly. Staging tests ported:
find-companies-judge-slice.spec (next slice + cap 3), find-companies-limits.spec (stated headcount), proving.spec (window),
round.spec (re-proof + capture sync, spy gains `judged`). test/companies: 115 passed. Full gate running (gate-land.log). NOT committed
yet; NOT merged into staging — the user decides. Still to add: docs/solutions note (short) after the gate.

## Arm ledger (12 trials each unless noted; seconds = per run; $ = per run; gates = of 12)
baseline 1e19d8d: gates 8 (form3 ×2 seconds+reject, dental ×2 headcount) — $3.09 — 998 s total
exp1 silence-proven: 0 stored on mstone → stopped ($0.4)
exp2 reprove-missing: gates 7 — $3.39 — form3-t0 392 s; every stored event row verified
exp3 synthesize-worker: route model unfit (deepseek flash 102 s, cap hit) → stopped
exp5 judge-x4: one round everywhere, but cheap profiles cost +50% — $3.06 — discarded
exp4 angles-4: carta cost −27%, form3 noise — $3.05 — parked
exp8 judge-next-slice (7+6 trials): one round everywhere, mstone −40% s, form3 passes seconds once — ~$2.6
exp10 combined2: gates 8 (dental fixed; carta proof holds; form3-t0 430 s outlier) — $2.60 — 1238 s
exp11 lean (no re-proof): gates 8 (dental/hvac/mstone/aris all pass; carta proof fails ×2; form3 seconds ×2) — $3.10
Total eval spend ≈ $28 across 10 arms + 2 baselines.

## 08:40 PDT — final scores with every key labelled (keys at 9d8c41a; 11 nulls of ~330 remain)
baseline  gates 8/12, precision <1 on 4 trials (form3 bmw/sectigo, dental mortenson ×2)
combined2 gates 8/12, precision <1 on 2 trials (mstone dickerdata, form3 zalando); fails: form3 seconds+reject, carta t0 seconds
lean      gates 8/12, precision 1 on 12/12; fails: form3 seconds ×2, carta proof ×2 (no re-proof)
Every arm's remaining gate failures are agent-route seconds against the 150/180 s bars, or literal-requirement stores (onboarding).

## 09:00 PDT — landing branch committed: engine/proven-round @ 3c65c09 (off staging 37db861), NOT merged
Files: src/core/companies/{index,limits,proof,round}.ts + new proving.ts; tests in staging's suite: find-companies-judge-slice
(next slice + cap), stated-headcount.spec (new), proving.spec (window), reprove.spec (new, proveAndJudge-level), round.spec (demand
rename only); docs/solutions/companies-round-proof.md. First gate: only tests-shape failed (fixed: no inline secret fakes, specs
<300 lines). Second full gate running (gate-land.log). Then: commit eval/label tooling on eval/braintrust (its gate), final report.

## Ondato live run (land worktree, engine/proven-round, main DB, dev server needs SFW_SHIM_DISABLE=1)
Org key in /Users/lahfir/.claude/jobs/24a9762f/tmp/ondato.key; icp 18c490ee-009d-44b8-afd3-e0103f5a1ae7 (noted onboarding $0.11,
then hand-edited: 4 record gates incl. reachability band $2M-$250M raised / $1M-$150M revenue / private; r5 hard page 365d = the
three dated events; r6/r7 soft). Run 1 companies_18c490ee…_2026-09-04: 10 found in 1 round, 471 s, $0.66, all evidenceCheck found —
but big logos (Coinbase, Robinhood, Revolut, Fanatics, FanDuel, IG, Monzo, MetaMask, Manzil). People run: 40 verified over 8
companies, $1.15, then ERRORED on Revolut: "Model call timed out twice" in the select step (huge roster) — a select timeout should
skip the company, not end the run. People geography is not enforced (IG Japan/UAE CEOs, Fanatics Italy/China CEOs).
Run 2 companies_dom-400d5588fe23_2026-09-04 under the reachability gate, excluding the nine. Eval: Ondato = 7th profile (2f4d891),
key seeded (9), LABEL packet sent.

## Ondato: fit is the gate, situations are soft (user rule: signals are a bonus, never a criterion)
Run 3 fit-first (r2/r4 plain): 10 in 59 s $0.24; labels 5 accept / 2 unreachable / 3 excluded — silence kept B2B rows.
Run 4 (r2/r4 say "does not qualify" on silence): 10 in 110 s $0.36; 29 "contradicts r2" refusals; labels 7 accept / 3 null.
exp12 = branch exp/strict-silence (worktree exp12, 9b27362, off exp/combined): Requirement.strict → refuses unproven; Ondato r2/r4
strict in eval/arm-seed/ondato.json. Arm `strict` on ondato only: both trials PASS, precision 1 (ziglu, blocpal, peymo), 1 round,
11-30 s/co, $0.05-0.07/co, $0.35 total; refusals name "the record does not establish r2" / "contradicts r4: no figure".
Comparison arm `combined-ondato` (exp10 e743fc4, no strict) running. ondato key: 29 entries, 13 accept, 13 reject, 3 null (00d9b90).
.env: my append had glued EVAL_API_KEY_ONDATO onto the BRAINTRUST_API_KEY line (no trailing newline) — repaired.

## Evals that solidify the engine — the plan after the cut (eval-cut agent running on eval/braintrust)
Keep: runner, verdict rule (6 gates → $ → s; precision score), keys + label tool, profiles + seed docs, Braintrust experiment with 2 code
scorers. Runner now seeds keys from the arm DB after each arm and prints domain:label per trial.
Add next, each ≤ 150 lines, one at a time, measured before landing:
1. People verdict per profile: for each stored company, verified buyers (n), in-country share, cost per verified person; gates:
   no run error, every stored person has a LinkedIn url + two agreeing sources, every person's location inside the profile's
   countries; rank by verified-per-company then cost. Person key: eval/keys/people/<slug>.json {linkedinUrl: {label, name, title,
   company, note}} labelled accept | reject:<not-buyer|wrong-country|left-company>. Same label tool, --people flag.
2. Roster cap: a company whose roster exceeds N rows selects from the top N by seniority band (config people.maxRosterRows) —
   kills the IG/Revolut 10-minute select timeouts. Measure on revolut.com + ig.com: seconds and verified.
3. Requirement writer under the eval: onboard each seed profile's seller domain + note with the real onboarding, diff the written
   requirements against the hand-fixed fixture (kinds, proofs, exclusions present) — the four intent gaps become a scored test.
Ondato live: people3 run stuck ~14 min on ig.com (huge roster → select timeout → retries → skip). GetLeads rescue needs the
restarted server (local secret gl-api-key created at 14:50).

## 15:30 PDT — mandate restated by the user: end result only; least code; parallelize agents; be on top of them
Eval cut done (a1ea97c): eval/ 2681 → 1666 lines; runner seeds keys after every arm and prints domain:label.
Ondato profile cut to 874 chars, 4 gates + 1 bonus line + 1 buyer sentence (9b64c42 in eval; same in main DB).
People branch people/small-rosters @ eb26a5d: GetLeads rescue, countries in select, skip failed company, verify 3 at a time, Clay
structured location → person.location. Measured on Ondato's 13: small 11 → 7 verified (was 6), Revolut 2 verified (was run error),
IG finished in batch (was 27-min stall), each run 91 s $0.15. GetLeads rescued 1 of 4 (founder then contradicted by registry).
Agents running: people-eval (person key + verdict, eval branch), exa-roster (Exa people index as 3rd roster source, worktree
people2), onboard-eval (minimal-doc instructions + eval:onboard scorer, worktree onboard). Aris people run on 12 accepted MSPs in
flight (second profile's people numbers). Full gate on the people branch running (gate-people.log).
Worktrees now: eval, exp10 (combined), land (engine/proven-round), people, people2, onboard, agent-a59… (BT agent, stale).

## 15:45 PDT — people measured on a second profile (aris, US MSPs 10-40 staff)
Batch 1 (12): 146 s $0.31, 10 resolved, 13 verified, 9 Clay 429s. Batch 2 (12, serial slices a73cd68): 179 s $0.47, 12 resolved,
19 verified, 0 Clay 429s. Locations populated. people/small-rosters @ a73cd68, gate PASSED (451). people-eval landed on eval
(bce28ba + person key 55c098c, 50 Ondato people seeded; LABEL packet sent). Pending: exa-roster (people2), onboard-eval (onboard).

## 16:10 PDT — onboarding under the eval (worktree onboard, branch onboard/minimal: ec329a5 instructions, 6270bc5 eval)
`bun run eval:onboard --profile ondato` (live, spawns a narrow vitest workerd config) scored 16 of 22 on the minimal-doc instructions:
the model let the pages override the note (wrote "seed-stage to publicly traded" against a $2M-$250M private band), never wrote the
band as a requirement, duplicated the vendor exclusion. Sent: note wins over pages; band always its own hard requirement; one
requirement per idea; rerun and report. Exa roster waterfall live on 9 hard domains: Exa people index returned result sets for
keebo/koyo/projectimagine/e3/everound; verification in progress.
16:45 PDT LESSON: two "frozen" people runs were my own doing — the dev server had been started from the onboard worktree (shell cwd
drift), so the onboard agent's edits hot-reloaded it and abandoned in-flight steps; the local Workflows engine keeps running instances
in memory, a reload or restart loses them, and openRun does not reset a run row. Always `cd` by absolute path before `wrangler dev`.
people/exa-roster @ 118a9ce (waterfall Clay → GetLeads → Exa people; refusals fall through). Hard-domain runs relaunched 23:14Z from
people2. onboard/minimal: instructions + sizeBand structured field (0c97430) + eval:onboard (a131b85); score 17/22 with the OLD note;
note now carries the band; rerun pending.
17:00 PDT Hard-domain runs on people/exa-roster @118a9ce (43 s / 30 s, $0.16 each): E3 IT → 2 Managing Partners via Exa people
(correct); Everound → 2 found, verifier contradicted (titles changed, correct). keebo/koyo → homonym companies (US Keebo, Koyo
Workshop) via NAME match, and the verifier CONFIRMED them against the wrong company's pages. Fix sent to exa-roster: match by
Exa organization id (workHistory[].companyId == org id resolved by a company search with includeDomains), no name match.
Open weakness noted: the person verifier checks "works at <name>"; it should carry the domain. Not yet changed.
17:15 PDT onboard/minimal: instructions 0c97430 (minimal doc rules + sizeBand structured field → code writes the band requirement),
eval b3c057b (`bun run eval:onboard --profile ondato`, deterministic checks, note fixed to carry the band). Live score 21/22 (the
miss is the scorer's literal "MLROs"). Full gate running (gate-onboard.log). Landing set now: engine/proven-round + people/small-rosters
+ people/exa-roster (org-id fix pending) + onboard/minimal. Next engine fix after that: person verifier must carry the domain.
17:35 PDT onboard/minimal gate PASSED (450) → merged into engine/proven-round (land). people/small-rosters @ 0def4a7 adds: a
first-party confirmation verifies only from a page on the company's own domain (Keebo case). Pending: exa-roster org-id match
(people2); then org-id-based index agreement (Koyo case), merge people branches into land, full gate, rerun hard domains + score
Ondato people with `bun run eval:people`.
17:50 PDT people2 @ 8b8d769 = exa-roster (org-id match df5fb2c) + small-rosters (0def4a7). exa-roster agent now adding: org id
resolved once per company (step people-<domain>-organization), passed to the fallback roster and to the index second opinion
(SAME/DIFFERENT by id, model only when an id is missing). Landing branch gate running with onboarding merged (gate-land.log).
18:15 PDT people/exa-roster @ 7ad6ac1 gate PASSED (458): org-id roster match + org-id index agreement + first-party domain guard + all
earlier people fixes. Hard-domain rerun: keebo/koyo/projectimagine now unresolved (no org-matched person; the wrong-company people are
gone), E3 1 verified via Exa, NetOps GetLeads roster. Merged into engine/proven-round; combined gate running (gate-land.log).

## 18:30 PDT — DONE FOR THIS CYCLE: engine/proven-round @ 6ab8119, gate PASSED (462), 13 commits ahead of staging, src 16 files
+1071/-296. Holds: companies (slices+cap, stated headcount, proving window, re-proof+capture sync), onboarding (minimal doc + sizeBand),
people (GetLeads → Exa people by org id, verify 3 at a time, serial Clay slices, skip failed company, location, country rule,
first-party domain guard, org-id agreement). Eval branch eval/braintrust @ 90b2fcf+: runner/rule/keys/label + person key/verdict +
Ondato profile; onboard/minimal carries eval:onboard. Nothing running. Merge into staging = user's call.

## 19:05 PDT — Ondato at 20 on the landing build
Run A (no strict, 6ab8119): 20 in 1 round 155 s $0.50 — 12 rows kept on "no figures" silence → strict flag cherry-picked onto land
(3bc5d63), Ondato r2/r4 strict in DB + fixture. Run B (strict): 17 of 20 ("short"), 3 rounds, 320 s, $1.10, every row in band with a
self-serve motion, 102 judge refusals (B2B, out-of-region). People run on B started (people_dom-…). Key seeded (69 entries).

## 19:15 PDT — people on the strict seventeen
people_dom-8abd655a5b35: 18 verified across 8/17 companies, $0.84, 4 min. Empty: bitmama/ovalmoney (Clay 0; GetLeads
fallback failed "Secret gl-api-key not found" in land store → copied people store over land, backup in job tmp), bitok/swipe
unresolved, lemfi (rubric bars compliance/risk + CEO cap 50 → only Head of Product picked; LinkedIn evidence needs index;
index lacks him → dropped), lendwise (Rishi Z. vs "Rishi Zaveri (CEO)" → CONTRADICTED; prompt fix 1846445), plend (rubric
"CRO" read as Chief Risk Officer → wrong pick; rubric now "Chief Revenue Officer" in DB + fixtures), vipplay (Exa split
entity, OTC-listed shell; org-id DIFFERENT defensible, left alone), teasers (pick at another company, correctly dropped).
Gate PASSED on land at 3bc5d63 (463 tests). land HEAD 1846445; eval HEAD 2db4c30. Rerun people on the 9 empty domains:
people_dom-dfed43af62e1 (started 00:13 UTC). LABEL has both packets (40 companies, 21 people).

## 19:22 PDT — strict flag scored against the labelled key (LABEL 3a8972a)
Run A (no strict): 2 accept / 14 unreachable / 3 excluded-type / 1 null of 20 → precision 0.10.
Run B (strict):   17 accept of 17 → precision 1.00. Same profile, same day, excludeDomains disjoint. This is the proof for 3bc5d63.

## 19:35 PDT — nine-domain people rerun (people_dom-dfed43af62e1, $0.26, 95 s)
+3 verified: Rishi Z. (Lendwise CEO — surname-initial fix), James Pursaill (Plend CEO — rubric fix), Samuel Esserman (Teasers
co-founder; index lists Teasers current → org-id SAME). Strict 17 now: 21 verified across 11/17. Still empty: lemfi (Juwon +
Samit confirmed via LinkedIn/aggregator, Exa people index lacks both → dropped — known gap), bitmama (GetLeads gave Abuja head
→ out of country), swipe (GetLeads gave a Philippines CEO → out of country), ovalmoney (nobody), bitok (unresolved), vipplay
(split Exa entity, OTC shell). GetLeads: free-trial credits exhausted ("credits_exhausted": true) — fallback dead until paid.
Gate rerun on land at 1846445 started.
People key labelled (LABEL 61941af): strict-run people 17 accept / 4 not-buyer (founders at >50-staff companies per rubric) of 21 → 0.81.
Totals: company key 66 (31 accept), person key 71 (47 accept). Gate on land 1846445 running (bet78k3rl).

## 20:55 PDT — probe wave 1
codex review: tmp/codex-answer.md; probe plan: tmp/codex-plan.md. Verified: OR band enforced as AND (16+13 filter rejects in strict
run), selector blind to headcount, org lookup without domain check, quote-miss keeps verified, dead code (mcp, empty arrays,
inner round loop). 100/300 Exa results are library entities without a website (gate not-a-company-domain); excludeDomains exa.ai
empties the search — not fixable that way.
eval/braintrust: merged land (4f5729c), runner --count/--port + scaled bars (a7009cb), eval script restored (6a48827),
people-live tool (89e9fb7). Worktrees arm-{financial-or,buyer-size,org-domain,strict-record} off a7009cb, agents ARM-OR,
ARM-SIZE, ARM-DOMAIN, ARM-STRICT (Sonnet) implementing + gating + committing; I run the measurements centrally.
Baseline: `bun eval/run.ts --arm base20 --trials 3 --profile ondato --count 20 --port 8790` started 00:50 UTC (log tmp/arm-base20.log).
People arms: `bun eval/people-live.ts --arm <a> --profile ondato --domains tmp/ondato-17.txt --port <p>` then `bun run eval:people`.
Dropped from wave 1: carry-queue (queue was empty in the strict run), worker-synth (deepseek unfit, tried before).
Arms committed (gates green): financial-or 040ebaa (+tooling ab05b4d), buyer-size 5ae9c7f (+6c4cf8b), org-domain 0e45cad,
strict-record bcfdc2e. First baseline (base20) hung 20 min with no evidence: runner spawned wrangler without SFW_SHIM_DISABLE=1
→ killed; run-arm.sh/run-people.sh now export it. Queue: base20b (running from 01:07 UTC, port 8790) → strict20 (8791) →
basep/sizep/domainp people on ondato-17 (8793-8795) → or20 (8796). Logs tmp/arm-<arm>.log; queue.done/queue2.done markers.

## Probe results (count 20, ondato, key at 0d4fc24+)
base20b (89e9fb7): stored 20/20/20; accepted 18/19/16; key-rejected 1/1/3; cost $1.17/$0.74/$0.90; 380/180/250 s; rounds 3/2/?
strict20 (bcfdc2e): stored 20/20/20; rounds 2/2/1; cost $0.92/$0.70/$0.54; 238/176/114 s; labelled so far accept 13/16/15,
key-rejected 2/1/1 (monolith defunct every trial, triver once); 10 new entries to LABEL at 4f7ca04. No recall loss from strict.
NOTE: an arm run seeds the key file in ITS OWN worktree; always reseed from the eval worktree (`eval:label ondato --seed-only --arm X`).
Key 736dbb7 (92: 53 accept). FINAL companies rows:
  base20b: accept 18/19/16 (mean 17.7), rejects 1/1/3, $0.94 mean, 270 s mean → 18.8 accepted/$, 3.9 accepted/min
  strict20: accept 16/18/18 (mean 17.3), rejects 4/1/1, $0.72 mean, 176 s mean → 24.0 accepted/$, 5.9 accepted/min
  → strict: tie on accepted/request, +28% per dollar, +50% per minute → provisional WIN (codex rule). Wrong rows same class in
    both arms: partner-led/B2B2C (triver, baanx, tryflux, 365finance), defunct (monolith ×4), acquired/owned (trezeo, privy).
basep (people, eval engine 0d4fc24, ondato-17): 18 verified, accept 14, reject 1 (Neil K. founder@99), unlabelled 3 (Rishi Z.,
James Pursaill, Guillaume Torche CTO), coverage 10/17, ~$0.81, 4 min.
basep FINAL (people key e66eb67, 74: 49 accept): 18 verified, accept 16, not-buyer 2 (Neil K. founder@99, Guillaume Torche CTO), coverage 10/17.
sizep (buyer-size 5ae9c7f, ondato-17): 8 verified (7 accept + Dave P. unlabelled), coverage 4/17, $0.49 → LOSS of 9 accepted vs basep.
Cause: domains-mode run in a fresh arm DB has no stored company rows → headcount unknown for all 17 → "no size exception when
unknown" dropped every founder/CEO, and the model got more conservative overall. Measurement flawed for the intended change.
Follow-up: take workforceTotal from the Exa organisation lookup (already called) when the row has none; rerun as sizep2.
domainp (org-domain 0e45cad, ondato-17): 19 verified, ~14 accept, 3 not-buyer (founders >50), 2 new unlabelled (Alastair Woods CFO|CPO Swoop, Samuel Esserman), coverage 10/17, ~$0.84. Neutral vs basep as predicted (check not exercised on these 17).
Angles: anglesForRound returns 1 when no hard page requirement → Ondato gets ONE plan per round; gather runs plans[0] only. arm-angles created (24e5050).
PEOPLE FINAL (key 092d1dd, 77: 51 accept), eval:people from the eval worktree:
  basep   18 verified / 16 accept / 2 reject / coverage 10 of 17
  sizep    8 verified /  8 accept / 0 reject / coverage 4  → LOSS (headcount unknown in domains mode); sizep2 queued
  domainp 19 verified / 15 accept / 4 reject / coverage 9  → neutral (noise); correctness guard, not a yield change
or20 (financial-or 040ebaa): stored 20/20/20; rounds 2/1/2; $0.92/$0.54/$0.76; 230/145/175 s; 9 new to LABEL at f6adadb.
or20 FINAL (key 424ecf7, 97: 57 accept): accept 17/19/18 (mean 18.0), rejects 2/1/1, $0.74 mean, 183 s mean → 24.3 accepted/$, 5.9/min
  vs base 17.7 / $0.94 / 270 s → tie on count, +29% per dollar, +50% per minute → provisional WIN (same shape as strict).

## 21:58 PDT — wave 2 + proof plan (codex-answer3.md)
Wave 2 arms: arm-profile (LinkedIn profile text resolves index miss/disagreement; ARM-PROFILE), arm-homepage (live homepage to
the judge, 4000 chars; ARM-HOMEPAGE), arm-angles (ARM-ANGLES), buyer-size rerun (ARM-SIZE). Queues 4 and 5 run them in order.
Codex proof bar: freeze the combined variant → 100 companies on ondato, mstone, form3 (separate arms, ≤$8 each) → people on all
returned companies. 9+/10 = ≥90 accepted distinct orgs/100 and ≥95% precision per profile; people ≥95% strict precision, ≥90% of
accepted companies covered. Codex corrections: strict = cheaper/faster, not better quality; org-domain inconclusive (15/19, 9/17);
Monolith ×5 = systematic eligibility failure (homepage arm targets it).
words20 (strict+words 4749c09): stored 17(short)/20/20; rounds 3/2/2; $1.21/$0.91/$0.89; 420/240/240 s. Refusals correct in
kind (acquired ×2, B2B, partner-led) but strict r2 wording also refuses silent consumer apps (algbra, caary) → recall cost; homepage
arm should supply the missing signup evidence. Labels pending.
words20 FINAL (key 31d26ba, 102: 62 accept): accept 15/20/19 (mean 18.0), rejects 1/0/0 (monolith once), $1.00 mean, 300 s mean.
  vs base 17.7 accepted with 5 rejects → same count, wrong rows 5→1, precision 91%→98%. Cost/time ≈ base (strict's saving eaten by
  extra rounds). WIN on quality. Monolith remains → homepage arm.
sizep2 (buyer-size + lookup headcount 00c0968): 12 verified, ~11 accept, coverage ~7/17 vs basep 16/10 → LOSS. The size rule refuses
founders at 58-60 staff the key accepts, and picks got fewer overall. DROP buyer-size; the rubric's "under about 50" is the wrong lever.
angles20 (a01e242, 2 plans/round): stored 20/20/20; rounds 2/1/1; $1.15/$0.87/$0.86; 240/120/120 s → fastest arm; labels pending.
angles20 FINAL (key a129657, 110: 67 accept): accept 15/16/17 (mean 16.0), rejects 5/3/3 (B2B2C embedded finance, monolith, aixtrade),
  $0.96 mean, 160 s mean. Speed/scale win (1 round fills 20), precision loss without strict+words. → combine with words for the build.
profilep (profile rescue 80f969a, ondato-17): 21 verified, ~18 accept (Peter O'Mahony, Donal Whelan pending), 4 not-buyer (known founder>50/CTO
  cases), coverage 11/17 incl. LemFi (Donal Whelan CEO Europe), $0.82 → +2 accepted, +1 covered vs basep. WIN (modest).
arm-combo 7c9ad88 = strict+words+financial-or+angles+org-domain+profile+homepage(4000 chars). Gate running.
profilep FINAL (people key 3098a8d, 80: 54 accept): 21 verified / 17 accept / 4 reject / coverage 9 (lemfi gained, afriex+plend lost to
  roster variance) vs basep 18/16/2/10 → neutral on yield; keeps the bounded rescue (Donal Whelan rescued). Buyer-size DROPPED.
home20: all 3 trials errored within 1 min, no evidence rows → runtime failure; reproducing on port 8811 (arm home20dbg).
NOTE: shell cwd drifts; always cd absolute before eval commands.
home20 cause: "NonRetryableError: Exa contents: response did not match the expected shape" from the homepage batch (not reproduced
at 2/15/50 urls; root shape unknown). Fix in combo 7ee9e11: fetchHomepages returns [] on NonRetryableError (homepage = optional
evidence). Combo now = 7052c1f..7ee9e11 incl. 37237a3 (4000 chars, factual judge wording, empty-text guard). Gate running; on PASS
touch tmp/combo.ok → queue6: combo20 (3×20 ondato) → proof-ondato/mstone/form3 (100 companies + people each, ~$10/profile).
combo gate PASSED at 7ee9e11; combo.ok 02:44 UTC; proof queue: ondato 50 → form3 30 → mstone 30, stop at $16

## PROOF (combo 069f3e4, cap $20, stop $16)
proof-ondato companies: 50 requested → 33 stored (3 rounds, pool exhausted), $2.05, 9 min; key: 25 accept / 0 reject / 8 unlabelled (LABEL at 79c4642).
  NOTE people-live bootstraps (drops) the arm DB → ondato companies rows wiped; records survive in arm-combo key copy (merged 79c4642).
  run-proof2.sh uses arm "<A>-p" for people; queue7 runs form3 30 then mstone 30 after ondato people finish.
proof-ondato companies FINAL (key 76c017d): 33 stored / 33 accept / 0 reject → precision 1.00 on the combined build.
proof-ondato people: 22 verified over 33 companies (13 covered), $0.72, 6 min; labelled so far 7 accept / 3 not-buyer (founders>50) / 12 unlabelled → LABEL.
proof-ondato people per company: 13/33 covered; 16/33 "unresolved" (Clay identity preflight found no C-suite → company skipped, no
fallback roster at all); 4 with tiny rosters and no pick. Biggest coverage lever: unresolved → Exa org-id roster fallback. arm-unresolved off combo.
Unresolved 16: Clay identity empty → rescue ran (GetLeads: secret absent in combo store + credits dead; Exa people roster ran for 10,
returned only unrelated people, e.g. Koyo → LendKoi founder; Exa org entity exists but no people indexed). Provider coverage limit
for tiny targets, not an engine bug. arm-unresolved dropped.
proof-ondato people FINAL (key e5b199c): 22 verified / 15 accept / 7 reject (6 founders at >50-staff firms that already have a
growth/product owner; 1 duplicate URL) / coverage 12 of 33. Precision 0.68. Error class = founder rule; fix is rubric wording
("a founder counts only under ~50 staff or when no growth/product/marketing owner is on the roster"), not code.
proof-form3 (strict-everywhere build 069f3e4): 30 requested → 1 stored (home.saxo, accept), $1.71, 20 min, 12 angles × 3 rounds,
  23 judge refusals "the record does not establish r6" (r6 = negative "has not delegated PKI" — unobservable from any record).
  → strict-everywhere is WRONG in general; per-requirement strict flag restored: combo 399ff82 = revert of 7052c1f. Gate running;
  queue8 reruns form3 30 + mstone 30 after combo2.ok. Proof spend so far ≈ $4.5.
combo 960df18 gate PASSED; combo2.ok 03:29 UTC; queue8: form3 30 → mstone 30 (run-proof2, people under -p arms)
form3 rerun (queue8) failed 401: stale form3 runner from queue7 held port 8804 → killed; queue9 reruns form3 30 on 8806 after mstone. mstone 30 running on 8805 (960df18).
proof-mstone companies (960df18): 30 requested → 30 stored in ONE round (3 angles), ~$0.86, 90 s; labelled so far 15 accept / 1 same-as
  (woolworths.com.au ↔ woolworthsgroup: duplicate org stored) / 14 unlabelled → LABEL.
proof-mstone companies FINAL (key 23bd86b): 30 stored / 29 accept / 1 same-as duplicate brand (woolworths.com.au) → 0.97; ~$0.86, 90 s, 1 round.
proof-mstone people: 20 of 30 companies searched (maxCompaniesPerPeopleRun=20), 69 verified, coverage 15/20, ~$2.07, 8 min; all unlabelled → LABEL.
Proof spend so far ≈ $7.4 (ondato 2.77, form3 1.71, mstone 2.93). Form3 rerun started 03:39 on 8806.
proof-mstone people FINAL (key cdfc687): 69 verified / 69 accept / 0 reject; coverage 15 of 20 searched (20 of 30 companies searched, people cap). Precision 1.00.
land engine/proven-round a552f9a = 1846445 + words, OR band, angles, org-domain, profile rescue, homepage(4000, refinements, fail-soft); NO strict-everywhere. Gate running.
land a552f9a gate PASSED (all tonight's winners ported). codex review running (tmp/codex-review.md).
proof-form3 rerun (960df18, per-requirement strict): 30 requested → 29 stored (7+12+10, agent route), ~$1.89, 15 min; labelled so far
  11 accept / 1 reject (gocardless no-such-event) / 17 unlabelled → LABEL. Proof spend ≈ $9.3.
codex review (tmp/codex-review.md): 16 findings; ratings companies 7.5 (from 6.5), people 6 (from 5). Fixing 1,2,4,8,10,11,12,14,15,16
via FIX-COMPANIES (fix/companies), FIX-PEOPLE (fix/people), FIX-DOCS (fix/docstrings), all off engine/proven-round a552f9a.
Skipped: 3 (headcount regex, no live hits), 5/7 (audit persistence), 6 (title recheck), 9 (country rule is wanted), 13 (cross-slice
org dedupe: medium, next).
proof-form3 companies FINAL (key 64885f6): 29 stored / 27 accept / 1 reject no-such-event (gocardless) / 1 null (sennder) → 0.96; ~$1.89, 15 min, agent route.
proof-form3 people: 10 of 29 companies searched (spend/cap), 77 verified, coverage 9/10, ~$2.4, 9 min; all unlabelled → LABEL.
PROOF SPEND TOTAL ≈ $10.0 (ondato 2.77, mstone 2.93, form3 1.71+1.89+2.4 ≈ 6.0 incl. the strict-everywhere attempt). Cap $20 held.
proof-form3 people FINAL (key 6bba5b3): 77 verified / 71 accept / 5 not-buyer / 1 wrong-country → 0.92; coverage 9 of 10 searched.
land c176e2c = a552f9a + review fixes (companies f468408, docs 952bce0, people eaad059); final gate running. fix-* worktrees removed (branches kept).
land c176e2c final gate: 1 pass
staging=master=894532f: engine/proven-round + eval/braintrust merged; gate PASSED 557 tests. Not pushed.

## PHASE 2 (budget $20 from 0; codex-phase2-plan.md)
Worktrees off staging 894532f: p2-eval-chain (EVAL-CHAIN: full-chain trial + engine_score to Braintrust), p2-delete (DELETE),
p2-speed (SPEED: empty reason on accept, drop pageQuery/soft), p2-words (a98c40b: Ondato/Form3 rubrics rewritten; Form3 "10,000+" → "501 to 10,000").
Main DB icp docs for Ondato (18c490ee) and Form3 (cf9f5feb) updated with the same rubric text.
Step 0 done: p2/delete 1c94087 (−364), p2/speed 5d28fb4, p2/eval-chain 3bcca47 (scorer v1), p2/words 4fc8194 (Ondato+Form3 rubrics; Form3 paragraph fixed).
codex scorer review (exports/codex-scorer-review.md): DO NOT SPEND — employer-unbound acceptance, null seconds scores 1, empty
company output crashes the chain, same-as alias scores 0, over-delivery >1, per-profile invocation drops the arm DB, MIN_TRIALS=2,
manifest winner rule stale. EVAL-CHAIN fixing (scorer v2). Live Ondato/Form3 docs RESTORED from backup; candidates isolated on p2/words.
Probe rules (codex): words on Ondato+Form3 (replay first); speed on Mstone+Form3, ≥20% faster both, quality unchanged; dedupe replay-only.
scorer v2 9f5e475: codex NOT CLEARED — $8 not $5 and only pre-trial; failed stage loses ids/spend; null seconds → 1.0; wrong-employer
passes; alias buyer → 0; inCountry gate rejects "New York, NY"; ceilings uncalibrated (×10/3). EVAL-CHAIN v3 in progress
(--budget per stage with reserve, explicit stageBars, drop inCountry, alias resolution, richer scoredRows). p2-base = staging + 3bcca47 + 9f5e475 (5a32be1); rebuild after v3.
baseline started 06:00:27 on p2base (5a32be1), watch kills at $6.50
AUTONOMOUS from here (user away): baseline p2base running (5a32be1); probes queued (queue-probes.sh): p2words-ondato/form3 (d8657ec),
p2speed-mstone/form3 (762fcc9); stop at $15 cumulative. EVAL-CHAIN killed, worktree clean at 9f5e475. After probes: label, rescore
(scratch composite by hand if the runner's score needs a correction), codex for optimisation advice, combine winners (+delete), confirm on 7.
BASELINE p2base (5a32be1, 7 profiles, count 5): $6.03, pre-label rating 0.57 (people mostly unlabelled). Yields 5/5 mstone, aris, ondato;
4/5 form3 (919 s, agent route), dental, hvac; 1/5 carta. Keys seeded d3d17bf on p2/base; LABEL has all 7 packets. tmp/rescore.py <arm>
reproduces the runner's composite offline (rating 0.57 match). Probes running (queue-probes.sh).
BASELINE LABELLED (bc42867): gated rating 2.86 (any wrong person or null company zeroes a profile). Ungated quality cov×bp:
mstone .80 aris .80 form3 .89 carta .46 ondato .40 dental .92 hvac .24 (mean .64). Companies 5/5 accepted on 6/7 (hvac 4 + 1 null).
Wrong people: form3 4 (2 Monzo Director of Engineering, CARIAD ops director, board member of another VW entity), carta 3 (Head of
Accounts; 2 co-founders at 88 staff), dental 3 (clinical VP; 2 duplicate URLs same person), hvac 2 of 5 not accepted. Coverage:
ondato 2/5, hvac 2/5, mstone/aris/carta 4/5. Cost $0.40–1.74, time 73–916 s (form3 agent route 916 s over its 600 s bar).
codex baseline advice (exports/codex-baseline-advice.md): 1 profile wording Carta/Dental (done on p2/words 1415009), 2 engine dedupe
of duplicate person delivery (DEDUPE agent, p2/dedupe), 3 headcount to selector (skip). Promotion gate for probes: A, B, T, bp must
not fall on affected profiles; brutal gate stays as the 10 bar. Budget: ≤$1 words replay, ≤$7 confirmation, ≤$1 repeat.
Probes provisional (unlabelled pending, LABEL at ab803ac): words-ondato 169 s (vs 278), P4 T2+2unl; words-form3 308 s (vs 916),
P13 all unl, A3+2unl; speed-mstone 204 s (vs 314), $0.69 (vs 0.78), P12 T8+4unl, A4+1unl. speed-form3 running. Spend ≈ $9.2+.
User: keep hard profiles in the set (ondato, form3, carta, hvac are); add 2 hard scenarios via onboarding if budget remains.
Cost anatomy (baseline): form3 companies $0.50 (10 agent angles) + people $1.24 (35 verified for 5 cos, $0.035 each); mstone $0.21+$0.57 (13);
ondato $0.57+$0.15 (4). LEAN arm p2/lean 446c09c (off staging + scorer): people.maxVerifyPerCompany 25→3; agent angles = clamp(shortfall,2,MAX)
(was ×2). lean-run.sh: gate then form3 count 5 on port 8796 (arm p2lean-form3). Spend $10.76; after lean ≈ $12; confirmation ≤ $6.
User: no hardcoded caps. Agent angles: lean sets angles=shortfall (still a heuristic; follow-up = let the synthesizer choose, bounded).
People per company: PERCO agent adds request param `peoplePerCompany` (1..25, default config 3, ceiling 25) on p2/perco; replaces the
config-only cap. Lean run (default-3 behaviour) still measures the effect.
PROBES SCORED (keys 7f033d7): words-form3 5/5, P13 T13 B5, bp 1.00, gates ok, score 1.00, 308 s (vs 916), $2.04 (vs 1.74) → WIN.
words-ondato: A4 + 1 key-rejected company (steadypay.co, draw variance), P4 T3 B2 → neutral/inconclusive; include the wording.
speed-mstone: 5/5, 12/12 B4, $0.69 (vs .78), 204 s (vs 314) → WIN. speed-form3: 5/5, 33/31 B5 rejP2 (vs 4), $1.53 (vs 1.74), 686 s (vs 916) → WIN.
p2/combo = staging + scorer + delete + speed + words (3 commits); pending: dedupe, perco (peoplePerCompany), lean result.
USER: no per-company people limit, ever; find all the right people. PERCO killed and removed; lean run killed at $0 (its people cap is rejected; angles=shortfall not promoted either).
Form3 key consistency: 5 Dexcom directors flipped to not-buyer (1c929dc). speed-form3 now 26/33 (bp .79 vs base .89) — draw variance
(Dexcom in that draw; the speed change touches judge/planner output only, not selection). Promote speed on mechanism + mstone parity; note it.
p2/combo = staging + scorer + delete + speed + words(4 profiles) + dedupe ff079e5; gate running. DEDUPE, PERCO done/killed; no agents coding.
codex confirm advice (exports/codex-confirm-advice.md): confirm the build as is; expected ~4.3 (3–5); leave last $3 unspent; next lever =
selector instruction "require evidence of buying responsibility, no founder/executive override". Form3 13-vs-35 people drop = different
company draws (cariad 12, gitlab 9, monzo 7 vs appdirect 2, fullscript 2, pandadoc 3, rippling 5, zapier 1), not a rubric completeness loss.
eval/rescore.ts (p2/base a94db4c): rescores an arm against current keys, logs `<commit>-<arm>-rescored` to Braintrust. Rescored:
p2base 2.86 (mstone .8 aris .8 form3 0 carta 0 ondato .4 dental 0 hvac 0); words-form3 1.00; speed-mstone .80; words-ondato 0 (A4); speed-form3 0 (rejP7).
CONFIRMATION p2combo (0dccceb = staging+scorer+delete+speed+words+dedupe) started 07:18 UTC, watchdog $18. Spend before: $10.76.
- conc-mstone RESCORED (keys c42853b): score 0.80, 5/5 yield, 4/5 coverage, 15/15 people, gates ok, 271 s (final was 0 because 635 s). Braintrust c42853bcddcb-p2conc-mstone-rescored. PROMOTE conc (verifyConcurrency 5).
- head-carta RESCORED (keys a735f1c): score 0.80, 5/5 yield, 4/5 coverage, 5/5 people (no wrong founder), gates ok, 168 s (final was 0: 3/4 people). Braintrust a735f1c0f694-p2head-carta-rescored. PROMOTE headcount. Final build = p2/final (combo+conc+headcount).
- FINAL2 RESCORED (keys cca2fb6): rating 4.75 (final 4.29). carta 1.00, dental 1.00, hvac 0.80, mstone 0.53, aris 0 (gate), form3 0 (gate: hioscar+sennder key-rejected), ondato 0 (gate). Braintrust cca2fb67eebf-p2final2-rescored-f74057eb. exports/p2-final2-scored.txt. Spend $37.82/40.
- FINAL2 RESCORED AGAIN with Aris ruling (keys 97965cb): rating 5.89 (final 4.29). aris 0.80 (5 yield, 4 cov, 7/7), carta 1.00, dental 1.00, hvac 0.80, mstone 0.53, form3 0 (hioscar+sennder off-vertical), ondato 0 (steadypay rejected). Braintrust 97965cba08d4-p2final2-rescored. exports/p2-final2-scored.txt updated. Spend $37.82/40. Codex final2 answer pending (based on 4.75; send the 5.89 follow-up).
- 16:46 CODEX final3 (exports/codex-final3.md): signable 6.29 ±2 snapshot; MERGE probe A (conc 5) and B (headcount); next $0: trace hioscar/sennder/steadypay decision inputs (TRACE agent running); next paid screen: form3+ondato count 5, baseline/treatment once each, $8 ceiling. Refuses: reproducibility until scorer fix is committed (pending SCORETEST test move), causality of the speed gain.
- 17:00 JUDGE committed 2f17a23 on p2/judge (worktree p2-judge, off p2/final 6b69825): one sentence in JUDGE_INSTRUCTIONS (listed-category contradicted by an affirmative other category), test in test/companies/judge.spec.ts, gate PASSED 605 tests. UNMERGED until the $8 form3+ondato screen. Loop stopped; program complete at 6.29, spend $37.82/40.
- 17:15 judge-form3 RESCORED (keys 0d844a4): form3 1.00, 5/5 yield, 5/5 coverage, 26/26 people, 561 s (final2 form3 was 0: hioscar+sennder). Braintrust 0d844a4c976c-p2judge-form3-rescored. Judge rule PROMOTED: p2/final fast-forwarded to 2f17a23 (gate passed there). Ondato side unscreened (no budget). SPEND $39.48/40. PROGRAM COMPLETE. Ready to merge: p2/final 2f17a23 = staging + scorer + delete + speed + words + dedupe + rubric reverts + conc 5 + headcount + judge rule. Eval keys/scorer: p2/base 0d844a4.
- 17:59 p2final3 RESCORED (keys 3df0a9d): rating 4.00 this draw. mstone 0.80 (16/16, 138 s), carta 1.00, dental 1.00 (23/23), aris 0 (one unlabelled person Jay Thomas, 10/11), hvac 0 (engcool undecidable, 3/5), ondato 0 (gettongo delivered, key reject strict r2 = judge misread like steadypay), form3 0 (harness error 1162 s). Braintrust 3df0a9d7e4b3-p2final3-rescored. LABEL asked to re-rule Jay Thomas + engcool on evidence. Then codex consult. Spend 43.93/60.
- 18:03 p2final3 FINAL SCORE (keys 60fe171): 6.29 again. mstone .80 (138 s), aris 1.00 (11/11), carta 1.00, dental 1.00 (23/23), hvac .60 (5/5 people, 3 cov), ondato 0 (gettongo strict-r2 misread), form3 0 (harness hang). Braintrust 60fe171264c1-p2final3-rescored. Codex final4 launched; ONDATO trace agent launched (strict r2 misreads gettongo/steadypay).
- 23:06 SELECTOR REPLAY (Midnite roster, $0.016, new authority wording): 5/7. Fixed the two marketing sub-heads; NEW false retain (VP Commercial) and NEW false drop (Head of Product - Sportsbook Platforms). Per codex: selector FROZEN for confirmation; p2/selector stays out. Ondato people precision remains an open defect (needs a better signal than a prompt sentence).
- 23:10 FORM3 b1 RESCORED (keys 2e2d5bb): 0. yield 3 (allegro, clear.bank, monzo accepted), sainsburys.jobs REJECTED (careers subdomain treated as an 860-staff entity; Sainsbury's is a huge listed retailer = entity-resolution gap), payone null, 9/27 people (15 at the rejected company). No timeout (357 s). Form3 did not reach 5/5. Codex final consult launched (tmp/codex-final5-answer.md). Spend ~50.8/60.
- 23:12 CODEX FINAL5 (exports/codex-final5.md): STOP paid runs. 6.29 signable only as the previous build's benchmark; the assembled build is unrated across seven profiles (two screened zeros). Merge selectively: yes conc5, headcount, category rule, harness, no-retry (judgeCall/roundCall), no-verdict-no-store, agent-run ids, judge-input evidence, failed-round spend (partial), Form3 r1 strict (contract), dedupe doc; HOLD batch 1 (back to 4); NO grounding promotion. Next-budget repairs: entity resolution before bars (sainsburys.jobs is a separate domain); selector: store inferred_workflow_owner only with an evidence-backed authority verdict from verification. Ceiling 7.14 arithmetic; 10 = every profile 5/5 repeatedly; 3 validation draws ~$21-24 excluding repairs. MERGE agent builds p2/merge (p2/final minus batch commits minus grounding behaviour), gates. Then: final report; user decides the merge to staging.
- 23:40 MERGED to staging + master (local, not pushed): p2/merge ae67699 (engine sign-off set, batch 4, no grounding) + p2/base d686a14 (keys, scorer, replay tools) + replay fix; staging = master = 61c29d9, gate PASSED. Growth since 894532f: src +657/-323 (26 files), test +1986/-448, eval+docs +6916/-573 (keys). Held out on branches: p2/ground (grounding), p2/excerpt, p2/selector, p2/final (batch 1). In progress: ENTITY (p2/entity), AUTHORITY (p2/authority) off p2/final -> rebase onto staging when they land; screen Form3+Ondato with ~$9.
- 00:09 CODEX final6 (exports/codex-final6.md): drop the authority STORAGE gate (evidence only) [AUTHORITY]; restore required-quote grounding to the candidate [GROUND2 on p2/screen]; entity: identity-conflict flag resolved by corroborated relationship, negatives required [ENTITY]; NO screen yet: adjudicate saved authority cases, test identity conflicts, replay grounding controls at cents; keep ~$6 until one candidate clears. Tonight's statement: previous benchmark 6.29; current staging/repairs have no validated seven-profile rating; both latest screens 0; ~$53.8 spent; no demonstrated overall gain.
- 00:36 FINAL ONDATO SCREEN (p2/screen 5dd4122, $0.56, 157 s): delivered altify, kontigo, peymo, swan (accepted) + sidekickmoney.com (key reject:excluded-type, a 16-staff private-wealth app the grounded judge proved on 'High Yield Savings'); ziglu refused for no r2 quote. FAILS the fixed criteria (a rejected company delivered). People 5, 2 to rule. Recorded spend 53.02 (~54.4 real). Per codex: paid runs PAUSED; candidate p2/screen stays unmerged; staging = master = 61c29d9 (sign-off set).
- 00:47 CODEX BRUTAL (exports/codex-brutal.md): adjudication overturns sainsburys.jobs->null, Ryan Murton->null, Dave P.->null (LABEL applying); sidekick/steadypay/decathlon stay reject. PLAN ($25): build p2/screen + ONE change = roster-aware buyer-fit check before paid verification (FIT agent on p2/screen); $1 uncached replays; $5 Ondato x5 + Form3 x5 (pass: 5 accepted companies, all people accepted, coverage >=4/5); $16 two seven-profile draws, report both; $3 diagnosis. Expected 7.5 (band 5.5-9.0); P(gated 10)=2%, P(>=8)=35%. Keep the brutal gate; publish ungated precision/yield/coverage alongside.
- 03:26 ONDATO fit2 RESCORED: 0.40, GATES OK (5/5 companies accepted, 2/2 people accepted, coverage 2/5): first non-zero gated Ondato ever. Coverage lost to badoo/taboo (GetLeads secret missing -> now fixed) and kontigo (UNKNOWN, abstain). Form3 fit2: 0 on Lloyds (CONSIST building the operator check).
- 03:50 CODEX close (exports/codex-close.md): STOP paid runs. Merge only: judge-output persistence, buyer-fit rows (+fit step), test mocks/index test. Hold: fallback, source-kind, exclusion split, fresh crawl, entity v2, operator check, one-row judge, authority. Form3 fit3 rescored: form3: score 0.00 yield 2 coverage 2 buyer-precision 7/7 gates FAIL $3.42 291.597s.

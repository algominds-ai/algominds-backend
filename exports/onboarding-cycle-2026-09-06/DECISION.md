# Onboarding decision and implementation route

Status: onboarding contract implemented on work/onboarding-contract. Full repository gate passed: 113 files / 611 tests, types, lint and Workers dry build. No production account records changed or deployment performed. Semantic extraction limitations below remain explicit; company and people quality must still be measured.

## Decision

Use **seller facts plus a scoped, editable ICP**. A domain identifies the account; it does not specify what that account wants to sell in this particular ICP. Accept a domain and optional free-text targeting instructions. Preserve those instructions exactly. The website supplies seller evidence; explicit instructions control product, audience, buyers, exclusions and signals. Do not add a campaign entity or preselect search angles.

For Form3, the account can describe the payments business while this ICP sells Trust Fabric to Kubernetes infrastructure owners. For Ondato, the ICP can sell conversion through identity verification to growth/product leaders even though the website discusses compliance. Aris can target MSP technical recruiting even though its current website advertises broader IT and sales recruitment. These are normal supported inputs, not exceptions implemented with account-name checks.

Instructions remain editable after onboarding. Show the resulting offer, company criteria, buyers and signals in plain language. An edit changes the relevant ICP and applies to new searches; completed runs retain the profile snapshot they used. A different query angle does not change eligibility. A materially different product/audience/buyer combination can be a separate ICP under the same account. Reuse the existing ICP record and run infrastructure.

With only a domain, seller research is useful, but inferred targeting is a **proposal**. An ambiguous broad account must not silently become a confirmed product, title list or company size band. Missing optional recency is not a blocking error; a missing buyer is unresolved for a people search, while company discovery can still proceed if the company intent is sufficiently specified.

## Smallest contract supported by the probes

The model output is in [account-profile.ts](account-profile.ts) and [account-profile.schema.json](account-profile.schema.json). Its fields are:

| Block | Contents | Purpose |
|---|---|---|
| Seller | Domain, description, explicitly evidenced customers, supplied source URLs | Account context, separate from targeting |
| ICP offer | Product/outcome being sold; explicit product exclusions | Prevent broad website positioning from replacing the chosen offer |
| ICP buyer | Purchase responsibility, eligible/excluded roles, explicit conditional eligibility and contact geography | Preserve who buys this particular purchase |
| ICP requirements | Required/preferred groups; alternatives containing jointly necessary conditions | Preserve eligibility and optional signals without flattening AND/OR |
| Each condition | Faithful text, optional time window, explicit source restriction | Preserve each condition's own evidence and date meaning |
| Unknowns | Unresolved choices or contradictions | Expose uncertainty rather than invent facts |

A time window retains amount, days/months/years, past/future, and whether it dates the event, publication or observation. Required groups all need to pass. Inside a group, any alternative can pass; inside an alternative, every condition must pass. Preferred groups rank eligible companies without disqualifying them. Missing evidence remains unknown. One failed alternative does not reject a company if another alternative passes.

The fixed inner AND list earned its place in the Deel test: `(hire within 90 days AND expansion within 180 days) OR replacement within 60 days`. This is fixed-depth grouping, not a recursive rule language. Numeric, geographic and industry conditions remain ordinary text; no bespoke finance or industry schema is proposed.

Persistence must also retain the exact user instructions and a deterministic contract version outside the model-generated fields. Do not pay the model to echo these. The structured output is an interpretation, not a replacement for the instruction source. Raw page extracts, input hashes and model receipts belong in run evidence. Do not introduce a new database table or another model pass just to translate the output back into an enforceable shape.

Delivery limits, such as Form3's requested maximum three people per company, are run settings rather than company-fit predicates. Preserve explicit values using existing run options where supported; do not silently discard an unsupported request or bake it into a global engine cap. Existing customer suppression likewise needs the real suppression list; a website customer logo alone does not establish whether it buys the particular product.

## Evidence and limitations

The initial six completed Ondato outputs compared the existing implementation, a simpler prompt using its existing shape, and a four-section text brief. The code's financial rewrite demonstrably joins funding and revenue with OR regardless of the supplied conjunction. The brief preserved more prose but required another interpretation before enforcement. Neither is sufficient unchanged.

Two grouped diagnostic outputs led to the fixed inner AND list. Six unrelated-domain/control outputs then exposed narrower geography, unsupported customer attribution, explanatory exclusions and event wording drift. One final bounded prompt/schema correction was frozen before eight final controls. No further prompt-tuning loop is proposed in this cycle.

| Final control | What held | Remaining issue or limit |
|---|---|---|
| Ondato saved growth ICP | Growth/product roles; Founder/CEO without invented fallback; financial OR; mandatory five-way signal OR; separate 12-month, 6-month and 120-day windows | Generic public-page proof obligation is absent on several signal branches; review dates classified as observation rather than explicitly publication. Not full fidelity |
| Opposite Ondato compliance control | CCO/MLRO, remote buyers, funding AND revenue, open funding upper bound, optional launch | Does not establish correctness on live companies or people |
| Cloudflare Access / remote startups | Product scope, 20–200 employees, manager-level ownership, no inferred headquarters, optional undated signals | Invents uncertainty about whether “CISO not required” excludes a CISO; lack of optional recency is needlessly listed as unresolved |
| Snyk domain only | Offer/buyer remain null; no invented company criteria; prior partner-as-customer mistake removed | Correctly unresolved; does not supply a ready ICP from a broad domain alone |
| Deel composite signal | Two conditions in one alternative; three separate windows; buyer remains null | Expands “Deel Payroll only” into an unrequested list of excluded products, risking scope distortion |
| Toast operations | Operations/finance/IT/owner roles, 3–50 locations, public-source optional signals | No live buyer validation performed |
| Ondato optional signal control | No maximum headcount, no invented financial band, founder equally eligible, signals optional | Ambiguous “within 12 months” becomes past; earlier output made it future. The ambiguity was not resolved by schema validity |
| Future-event control | Publication in past 30 days and scheduled event in next 90 days stay distinct; buyer location unrestricted | A single controlled example, not broad recency reliability |

These are case-specific findings, not an aggregate “10/10” score. A strict JSON schema constrains structure; it cannot prove that a paraphrase preserved intent. Some final cases still fail full semantic fidelity. The structural direction is selected; unattended extraction is not yet proven ready.

Independent review notes are preserved alongside this report. They were adjudicated rather than accepted automatically: public-source wording still present in a condition's text is not a complete loss merely because `sourceRule` is null; the original Ondato global page requirement is missing from several branches altogether. Also, privately held eligibility is explicit in that frozen ICP; routing public companies outside that motion does not make its private-company requirement an invented exclusion. No intended constraint absent from the literal test input is counted as an extraction failure.

## Real account source provenance

Form3's saved explicit onboarding payload and richer local brief both target Trust Fabric. The latter adds two-source Kubernetes proof, contact-country constraints, suppression, and richer signal windows. It internally attributes statements to a client form/call, but is an authored local brief, not an independently authenticated raw transcript. Its editorial reachability recommendations must not become an invented hard headcount ceiling.

Aris's saved historical onboarding payload was copied from a buyer rubric fixture. It is useful for testing preserved recruiting-purchase responsibility, but is not a complete original client ICP. It supplies no hard company headcount range, country gate or required recent signal. “Owner usually decides under ~150” must not become a 150-person company ceiling. The frozen Ondato arm-seed note is the comparison authority for this experiment, not proof of the provenance of every earlier client request. See [source-provenance-review.md](source-provenance-review.md).

Source acquisition itself has failure modes: a successful Form3 non-www fetch returned only a JavaScript redirect (103 characters); the canonical www page returned usable content. Fresh Gusto and Toast requests failed and needed an explicitly recorded cached fallback. Cloudflare extraction was thin. HTTP/provider success is not sufficient evidence quality. Reuse supplied product pages and cached research; fetch another relevant page only when the existing evidence lacks the needed seller facts. No mandatory 25-page deep crawl for every complete client brief.

## Implementation order: remove contradictions, then prove the path

1. **Repair the shared onboarding contract and all writers together.** `src/core/onboard.ts` explicitly forces closed size bounds, defaults to eight seniority bands, caps hard requirements, and declares dated signals always soft. Remove these rules. Remove `SizeBandSchema`/`applySizeBand` and their lossy financial rewrite. Capture the chosen offer separately from seller description. Preserve exact supplied instructions and explicit unknowns. Reuse existing structured generation and input validation.
2. **Update persistence and readers at one version boundary.** `src/core/db/icp.ts`, `src/core/synthesize.ts`, the onboarding/company/people workflows, HTTP input/output validators and eval readers all consume the existing shape. Change them coherently. Never silently reinterpret legacy prose as confirmed new requirements. Keep legacy data explicit and require source-backed rebuilding when needed. A failed extraction with the original note copied into `description` is not a completed, validated onboarding result.
3. **Make company search consume offer plus the same grouped requirements.** The normal synthesis prompt currently lists requirements without the chosen offer; its fallback alone uses profile description. Preserve grouping through retrieval and proof. Do not turn an OR of financial branches into joint provider filters, company service geography into headquarters, or several signal windows into one shortest page-age limit. Use provider facts first, and research missing mandatory evidence. Stop when an alternative is proved or the bounded search is exhausted; unknown is not pass. Prefer useful record search when it can enumerate the population, then adapt angles based on measured rejection reasons.
4. **Make people search consume the same offer and buyer instructions.** Remove the blanket selection instruction that applies countries in the profile description to a person's location. Apply contact location only when explicitly supplied, as in Form3's full brief. Derive provider title/seniority hints per search without storing them as buyer truth. Validate current employer, title and responsibility for this purchase; do not require extra invented proof of budget authority. Preserve managers and conditional founders where the ICP includes them.
5. **Use small regression checks and a bounded live comparison as the release gate.** Preserve the exact current inputs/outputs, including failures. Test omitted source obligations, open bounds, AND/OR, optional signals, ambiguous dates and conflicting product context. Missing optional information must not block an otherwise valid search. The offline check here covers structure and selected invariants only; implementation must additionally pass the repository gate and the changed end-to-end paths before deployment. Do not fix failures by rewriting the expected ICP to match the output.

The next company experiment must start from the produced onboarding profile, not a hand-built ideal fixture. Begin with five independently checked companies per real ICP. Report hard-criterion fit, required-signal evidence, duplicate rate, cost and latency separately. Scale to 25 only if the small comparison improves the specific failure without widening the ICP. After companies pass, do the employer/title/buyer checks on people. Reserve most of the $50 for those tests. Onboarding alone cannot repair closed companies, stale employment or poor retrieval.

Braintrust can retain run comparisons if useful. It does not supply independent ground truth: the current integration runs the task and scorers we provide. Keeping its dashboard green is not an acceptance criterion, and adding another judge layer is not the proposed repair.

## Verification and spend

**26 completed model outputs and one failed output; $1.457320 in recorded provider charges.** Reserve **$2.00** separately for unknown billing: the earlier interrupted request, the 166-second control potentially including an unreported timeout, and the two timed-out full-Form3 attempts. This reserve is an allowance, not a reconciled invoice. Agent-token costs are unavailable through this ledger. There is approximately **$46.54** of the $50 allowance left after the reserve.

All four matched Form3/Aris outputs completed. The full Form3 brief failed after two 90-second model timeouts; no output or correctness claim exists for that case, and its reported $0 is not evidence of free billing. No third attempt or timeout increase was made. The subsequent implementation removes silent nested model retries.

The eight final controls completed for $0.437312; median extraction latency was 27.285 seconds, with a 166.687-second outlier. These are observed model-call times, not a production onboarding SLA. No company/people discovery or production database mutation was performed by these probes. Implementation began only after their bounded conclusion.

Run the small offline check from the repository root with `rtk proxy bun exports/onboarding-cycle-2026-09-06/check.ts` after the real-account outputs complete. Raw inputs, output JSON, prompt/schema snapshots, source receipts and the [scratchpad](SCRATCHPAD.md) make both successes and failures inspectable.

The executed subset, `rtk proxy bun exports/onboarding-cycle-2026-09-06/check.ts final-controls`, passed for all eight candidate outputs. It checks structure, domain/source membership, selected signal operators/windows, null intent and Boolean truth examples. It does **not** assert full semantic fidelity, downstream compatibility or prospect quality. That offline check predates implementation. The completed implementation subsequently passed the full repository gate with 611 tests; this verifies code mechanics, not full extraction fidelity or live prospect quality.

## Sequence decision

Finish this bounded onboarding comparison, then edit onboarding and the necessary shared consumers before the next paid engine experiment. Do not finish every company/people experiment against the known-broken onboarding path. Do not replace the whole engine in one change.

The first implementation boundary includes extraction, persistence, explicit instruction edits, and preserving the same intent through company planning and buyer selection. Shipping only a new onboarding JSON shape while consumers still flatten it is not a complete change. Prove that boundary with existing saved cases and focused checks, then run the repository gate. The subsequent company probe uses those real generated profiles; the subsequent people probe uses the qualified companies. No additional paid prompt-tuning round without a specific unresolved question and a bounded test.

## Matched real-account comparison

| Account | Existing onboarding | Candidate | Decision |
|---|---|---|---|
| Form3 condensed note | Preserved Trust Fabric, but invented 501–50,000 employees; collapsed different signal dates into one 365-day field | Preserved Trust Fabric separately from payments seller facts, 501+ without ceiling, conditional CEO, three-person instruction in buyer prose and independent 30-day/12-month/90-day signal windows | Remove forced ceilings and single-window collapse. The richer brief's extra rules were not in this input and are not scored against it |
| Aris saved recruiting note | Invented 1–150 company size, US company geography and a 90-day hiring signal | Preserved recruiting buyer responsibilities and influencers, without hard size/geography/recency gates. Still invented a preferred under-150 company rule and put buyer employment into company requirements | Preserve exact notes and keep buyer guidance out of company filters. This output is improved but not fully faithful |
| Form3 full local brief | No matched baseline requested | Timed out twice; no candidate output | Long-brief behavior remains unproven. Fix retry/output handling in implementation before any justified follow-up |

The four real-account outputs cost $0.227816. Buyer text is deliberately a responsibility description; lack of separate structured contact-country or max-person fields is not omission when the instruction survives in that text. Per-run delivery limits still need to be applied by the relevant consumer. No claim of all-criteria accuracy is made for the failed long brief.

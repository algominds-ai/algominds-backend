# Held-out synthetic call-note ICP scopes

These are synthetic call-note inputs for a bounded account-facts plus ICP experiment, rather than canonical onboarding records. The seller/product URLs are public, primary pages used only to validate identity. Angles and campaigns are downstream derivatives and are out of this input set. Do not treat the companies below as real campaign targets or as evidence that a campaign was run. Evaluate the extracted account facts and ICP against the checks; do not tune the notes to prompt wording.

Schema anchor: `RequirementSchema` requires `{id,text,kind,proof,windowDays,strict?}` (`src/core/requirements.ts:8-15`). Onboarding allows at most five hard requirements, combines dated call-now signals into one soft requirement, and defines `windowDays` as proof-page age (`src/core/onboard.ts:95-122`). Buyer seniority is a closed Clay band set (`src/core/synthesize.ts:16-28`).

## C1 — Cloudflare Access: broad cybersecurity, one product, remote startups

**Seller/product URL:** https://www.cloudflare.com/products/access/ (Cloudflare Access is described as zero-trust network access for private applications and infrastructure.)

**Account fact anchor:** Cloudflare Access is the named offer; the official page describes identity-first access to private applications and infrastructure and replacing legacy VPN-style access.

**Synthetic note (input):**

> For Cloudflare Access, find US and Canadian remote-first B2B software startups with 20–200 employees; exclude cybersecurity, networking, and VPN vendors. The buyer is the person who owns security or IT infrastructure, including a Security Engineering Manager or IT Manager; a CISO is not required. Prioritize companies that publicly mention replacing a VPN, beginning a Zero Trust rollout, or hiring a security/IT owner, but this is an optional reason to call and no recency threshold is supplied.

**Expected checks:**

- Product scope is Cloudflare Access/zero-trust access; do not drift to Cloudflare Workers, CDN, or the whole Cloudflare portfolio.
- Hard requirements preserve US/Canada, remote-first B2B software, 20–200 employees, and the vendor-category exclusion. These are qualification gates.
- The three call-now ideas remain one advisory soft requirement with their OR relationship intact. `windowDays` must stay `null`; no 30/60/90-day age is invented.
- Buyer rubric includes security/IT infrastructure ownership and admits `manager`/`director`/`head` bands; it must not force a C-suite-only buyer.
- A missing trigger does not reject a hard ICP match.

## C2 — Snyk domain-only, no note: missing target choices remain unknown

**Seller/product URL:** https://snyk.io/platform/ (Snyk identifies an AI Security Platform and several security products.)

**Account fact anchor:** Snyk’s official platform page names the Snyk AI Security Platform and multiple product families; no single product or target segment is supplied by the call note.

**Synthetic note (input):** `null` (domain only: `snyk.io`)

**Expected checks:**

- Seller identity may be grounded in Snyk’s own page, but specific product, geography, remote-work requirement, company-size band, and campaign trigger remain unknown because no note supplies them.
- Do not select Snyk Code, Open Source, Container, or another single product from the portfolio; do not turn the broad platform page into a narrow ICP.
- Do not invent startup status, employee bounds, buyer seniority, reachability, or event/recency windows. `requirements` may be empty; any emitted requirement must be directly page-grounded and marked accordingly.
- Buyer may remain `null` or broad/page-grounded; a fabricated CISO/developer-only target is a failure.
- There is no optional trigger and no `windowDays` value in the oracle.

## C3 — Gusto Payroll: optional signals without an invented bound; nonexecutive buyer

**Seller/product URL:** https://gusto.com/product/payroll (Gusto describes payroll, tax filing, employee/contractor payments, HR, and related tools.)

**Account fact anchor:** Gusto’s official payroll page identifies payroll, tax filing, employee and contractor payment, and connected HR capabilities.

**Synthetic note (input):**

> For Gusto Payroll, target US startups and small businesses with 10–75 employees that employ US workers. The buyer can be the person who runs payroll: Payroll Manager, HR or People Operations Manager, Office Manager, or Finance/Accounting Manager; a founder or CEO is optional, not required. Companies with hiring activity, payroll-tax or compliance changes, or manual payroll are useful reasons to call, but no age threshold is provided and these signals must not disqualify a fit.

**Expected checks:**

- Product is Gusto Payroll; do not substitute benefits, hiring, or the full Gusto suite.
- Hard requirements preserve US, 10–75 employees, and employing US workers. They remain independent of optional signals.
- Hiring/compliance/manual-payroll ideas become one soft advisory requirement; `windowDays:null` is required because the note gives no age bound.
- Buyer rubric explicitly includes nonexecutive `manager`, `mid-level`, or `head` paths such as Payroll Manager, People Ops Manager, Office Manager, and Finance Manager. CEO/founder must not be the sole buyer path.
- Missing or undated optional signals remain unknown/advisory and cannot reject a hard match.

## C4 — Deel Payroll: mixed-date AND/OR trigger semantics

**Seller/product URL:** https://www.deel.com/payroll/ (Deel’s official page redirects to its Payroll solution page and describes payroll across countries.)

**Account fact anchor:** Deel’s official payroll solution describes a global payroll offering with country coverage, compliance, and payroll workflows.

**Synthetic note (input):**

> For Deel Payroll, target US-based remote software startups with 50–300 employees and staff in at least two countries. A buying trigger is optional: (A) a payroll, People Ops, or finance hire announced within 90 days AND expansion into a new country within 180 days, OR (B) a public payroll-provider replacement announced within 60 days. Preserve the AND/OR and each date; absence of a trigger must not reject a hard ICP match.

**Expected checks:**

- Hard requirements preserve US, remote software, 50–300 employees, and staff in at least two countries.
- The optional expression remains `(hire within 90d AND new-country expansion within 180d) OR provider replacement within 60d`; it must not be rewritten as three independent hard gates or as a single flattened “within 60/90/180 days” condition.
- The current scalar `windowDays` cannot represent three event windows safely. The expected onboarding result keeps the dates in requirement text and uses `windowDays:null`; any scalar proxy is a flagged loss of semantics, not a pass.
- Event dates must remain conceptually separate from source publication dates. A recent article about an old expansion is not a recent expansion event.
- Buyer candidates may include Payroll/People Operations/Finance managers or directors; absence of an executive title is not a failure.

## C5 — Toast Platform: vertical SaaS with broader buyer functions

**Seller/product URL:** https://pos.toasttab.com/toast-platform (Toast describes an all-in-one restaurant platform with operations, finance, team, and guest workflows.)

**Account fact anchor:** Toast’s official platform page names restaurant operations and exposes Operations, Finance, Team, Guests, and Vendors areas, supporting a multi-function buyer oracle.

**Synthetic note (input):**

> For Toast Platform, target independent restaurant groups in the United States with 3–50 locations and an in-house operations function. Buyers may sit in operations, finance, technology, or ownership: Restaurant General Manager, Director of Operations, Controller, IT Manager, or owner; do not collapse the buyer to founder or CEO. Prioritize groups opening locations or replacing point-of-sale or restaurant-management software when a public source supports it; this is optional and no recency bound is supplied.

**Expected checks:**

- Product is Toast Platform/restaurant management; do not silently broaden to every Toast product or narrow to payments only.
- Hard requirements preserve US, restaurant-group vertical, 3–50 locations, and the operations-function condition.
- Buyer rubric spans operations, finance, technology, and ownership. Nonexecutive General Manager, Controller, and IT Manager paths must survive; a C-suite-only result fails.
- Expansion/POS replacement remains one soft advisory signal with `windowDays:null`; no recency bound is invented.
- A company can pass hard ICP without a public expansion or replacement signal. Unknown trigger state must remain distinct from a negative finding.

## Scoring and holdout rules

- Label every fixture `synthetic=true`; do not use these notes as live quality evidence.
- Check structure and semantics, not exact model prose: account-fact identity, product scope, hard/soft kind, proof kind, preserved AND/OR, date retention, unknown handling, and buyer-band coverage.
- For every `windowDays`, distinguish an explicit page-freshness bound from an event-age bound. The mixed-date Deel case should fail a scalar-collapse check even if its prose sounds plausible.
- Score optional signals separately from hard ICP: signal precision, signal coverage, event-date correctness, proof-page freshness, and reachable/unknown status. Do not compress these into one PLI score.
- Do not run paid provider calls for this onboarding-only experiment; seller URLs are only identity references.

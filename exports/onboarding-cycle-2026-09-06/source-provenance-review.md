# Original onboarding-note provenance audit

Scope: read-only provenance check for Form3, Aris, and Ondato. No repository or database writes were made. Eval answer keys and arm seeds are treated as hand-tuned evaluation data, not original onboarding input.

## Provenance verdict

| Account | strongest local artifact | status |
|---|---|---|
| Form3 | `/private/tmp/claude-501/form3/icp-full.md` (189 lines, 14,346 bytes, created 2026-09-03 15:12) plus `/private/tmp/claude-501/form3/note.txt` (6 lines, 1,997 bytes, created 2026-09-03 14:45) | **strongest source evidence found** |
| Aris | `/private/tmp/claude-501/greenfield/note-aris.txt` and `aris-onboard-body.json` (created 2026-09-02) | **local test input, fixture-derived** |
| Ondato | `/private/tmp/claude-501/greenfield/note-ondato.txt` and `ondato-onboard-body.json` (created 2026-09-02) | **local test input, fixture-derived** |

No committed original onboarding-note file was found. The Aris/Ondato note files are exact buyer-rubric payloads with formatting changes relative to ignored local files `docs/solutions/people-probe/data/fixture/rubric-aris.md` and `rubric-ondato.md`. `git check-ignore` reports `.gitignore:19` for those files. Their use is documented by `/private/tmp/claude-501/-Users-lahfir-Documents-Projects-Algominds-algo-backend/2469c29f-2264-46dd-a659-cf2872b41f70/scratchpad/greenfield-dogfood-prompt.md:3,9`: the dogfood removed each H1 and used that rubric as the onboarding note. Therefore Aris/Ondato are fixture-derived test inputs, not independently archived customer briefs.

`eval/arm-seed/{aris,ondato,form3}.json`, `eval/keys/*`, generated profile JSON, `exports/HANDOFF.md`, and `exports/trace-false-accepts.md` are downstream eval/profile/evidence artifacts. They may describe expected behaviour but cannot establish what the original note said.

## Form3 source facts

The short explicit payload is `/private/tmp/claude-501/form3/note.txt:1-6`:

> This profile is for Trust Fabric only, not Form3's payments platform. Form3 (form3.tech) sells Trust Fabric, a product installed into a Kubernetes cluster to manage certificate trust and infrastructure risk across distributed services.

It then requires **all** of: production Kubernetes with a distributed architecture or many independent services; an in-house engineering team; 501+ employees; uptime-critical or regulated operations; and North America, the UK and Ireland, or Continental Europe (`note.txt:2`). It explicitly says “Do not gate on revenue” (`note.txt:2`), lists SaaS, online retail, fintech, automotive, energy, pharma, gaming, media, travel, telcos, and public sector (`note.txt:3`), and excludes consultants/agencies/non-profits/private equity/recruiters/freelancers/MSPs/SIs and certificate-lifecycle vendors AppViewX, Entrust, and CyberArk (`note.txt:4`).

The buyer is the platform, infrastructure, or security owner of the cluster and certificate estate, explicitly excluding payments/commercial functions: CTO/CIO/CISO and VP/Director/Head roles across engineering, platform, infrastructure, cloud, SRE, DevOps, security engineering, information security, or architecture; CEO only below roughly 1,000 people; no recruiters, HR, sales, marketing, individual engineers, or academics; at most three people per company (`note.txt:5`). Hot signals and windows are in `note.txt:6`: a qualifying platform/SRE/infra/PKI role in the last 30 days, public production-Kubernetes evidence, published SLA, DORA/PSD2/NIS2/PCI obligations, new platform/security leader in the last 12 months, post-quantum commitment, or public certificate/TLS incident in the last 90 days.

The fuller local brief is `/private/tmp/claude-501/form3/icp-full.md`. It adds the original-source qualifiers and operational details:

- `icp-full.md:9-17`: Kubernetes is the client's stated dealbreaker; the product physically installs into the cluster; verify from at least two public source types.
- `icp-full.md:18-27`: in-house operator, 501+ headcount, uptime/regulated requirement, and geography.
- `icp-full.md:29-50`: exclusions, including **existing Form3 payments customers** to suppress or split into a warm motion; the source says the form's $5M-$20M revenue answer conflicts with the 501+ and typical GBP 60k-120k deal shape, so revenue must not gate.
- `icp-full.md:52-77`: public sector is in scope but better as named-account; the call's negative finding is that the listener is platform, infrastructure, or security rather than payments/commercial, even inside an existing Form3 customer.
- `icp-full.md:81-121`: dream logos are 10,000+ and named-account; reachable anchors are Trainline, Skyscanner, Auto Trader UK, Ocado Technology, and Deliveroo, with a warning that UK-only anchors bias geography.
- `icp-full.md:125-155`: buyer geographies, seniority/title inclusions and exclusions, max three people, and the CEO-under-1,000 exception.
- `icp-full.md:158-189`: signal source and independent windows; internal certificate-expiry dates are unavailable/uninvited surveillance and must be replaced by public proxies.

The Form3 full brief is the source that should drive the final profile-preservation regression. It must not be replaced by payment-platform pages returned by onboarding discovery. Commit `39aa84f` (“scope the onboarding profile to the note's named product”, 2026-09-03) is a **repair**, not source provenance; its diff adds instruction to keep a named product's profile scoped to that product.

## Aris source facts and limits

`/private/tmp/claude-501/greenfield/note-aris.txt:1-4` says Aris Search places helpdesk, cloud, network, security, project-engineering, and service-delivery staff at managed service providers; the buyer owns the outside-recruiter decision or the headcount (`:1-4`). Positive roles are owner/founder/CEO/president/managing partner at an MSP under about 150 people, service/operations/managed-services/professional-services leadership, and People/HR/talent/recruiting owners (`:6-15`). Service desk/NOC/engineering managers and CTO/CIO are influencers (`:17-21`); CFO/finance, sales/marketing, delivered-service CISO, individual contributors, board/investor/advisor, and parent-PE roles are hard negatives (`:23-30`).

This preserves the buyer rubric, but does **not** establish a complete Aris company ICP: no geography, headcount floor, vertical list, or company-level signal rules occur in this input. Do not backfill those fields from `eval/arm-seed/aris.json` or generated profile output and call them original.

## Ondato source facts and limits

`/private/tmp/claude-501/greenfield/note-ondato.txt:1-5` says Ondato sells identity verification and onboarding (KYC/KYB) to fintech and consumer platforms with their own signup flow. The stated intent is specifically product/growth ownership of signup conversion, onboarding drop-off, activation, and pass rates, not compliance officers (`:1-5`). Positive roles are product/growth/onboarding/user-acquisition owners and explicit onboarding/KYC/KYB/identity/signup PMs, with a founder/CEO/COO/CPO carve-out below about 100 people (`:7-14`). CTO/engineering/platform and product-side risk/fraud are influencers (`:16-20`), while compliance/AML/financial-crime/regulatory, risk-function, legal/DPO, finance, sales, marketing, HR, support, board, investor, and advisor roles are hard negatives (`:22-29`).

Like Aris, this is a buyer/product sentence and rubric, not a complete original Ondato company ICP. Geography, company-shape bounds, signal alternatives, and the no-KYT campaign scope seen in generated profile/eval artifacts are not proven by this onboarding input and must be labelled derived unless a separate source note is recovered.

## Reproduction/provenance references

- Form3 onboarding recipe: `/private/tmp/claude-501/-Users-lahfir-Documents-Projects-Algominds-algo-backend/2469c29f-2264-46dd-a659-cf2872b41f70/scratchpad/form3-onboard-prompt.md:1-12`; line 9 says the exact contents of `form3/note.txt` were posted.
- Form3 progression: same task's `scratchpad/progress.md:65-69`; it records the initial payments-profile failure, Trust Fabric re-onboarding, and final ICP IDs. It is run history, not source-note text.
- Greenfield onboarding recipe: `.../scratchpad/greenfield-dogfood-prompt.md:3,9`; it says the Aris/Ondato rubric files were intentionally used as note payloads.
- Product-scope fix: git commit `39aa84ff53e97913c42555e5359db38ed230ce6d`.
- No commit contains `form3/note.txt`, `icp-full.md`, `note-aris.txt`, or `note-ondato.txt`; eval history is downstream labeling/seeding only.

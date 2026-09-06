# ICP & Targeting — Form3 (Trust Fabric)

---

## Hard ICP gates

Every company on a list must pass all of these. A miss on any one is a drop, not a judgement call.

- **Runs production Kubernetes with a distributed architecture, or multiple independent services.**
  This is the client's own stated dealbreaker, verbatim from the form: "Target must be using
  Kubernetes with a distributed architecture or multiple independent services where managing
  vulnerabilities and certificates are a challenge." Reinforced on the call: "we're looking for
  organizations that have distributed infrastructure, Kubernetes in particular, 'cause that's where
  it needs to be installed." **The product physically installs into a Kubernetes cluster. No
  cluster, no deal.** Verify from at least two of: engineering blog, conference talk, job
  description naming Kubernetes, public repo, CNCF or cloud-provider case study, tech-stack
  listing.
- **Has an in-house engineering team that operates that infrastructure.** Form field 102: "must
  have an engineering team managing it." A company that has outsourced its whole platform to an MSP
  or SI has no buyer for this — the MSP does, and that is a different motion.
- **Headcount 501+.** The form selected 501-1,000, 1,001-5,000, 5,001-10,000 and 10,000+. Below
  501 the estate is rarely distributed enough and the deal size (GBP 30k to 250k+ per installation
  per year) does not fit the budget.
- **Uptime-critical or regulated.** From the call: "regulated industry. You know, anybody who needs
  to be up, and it's really painful when they're not." The test is whether an hour of downtime is a
  board-level event.
- **Geography: North America, UK and Ireland, Continental Europe.**

**NOT-conditions (exclude, from the form's exclusion list plus the call):**

- Advisors, consultants, coaches
- Marketing agencies serving the ICP (adjacent, not buyers)
- Non-profits, charities, NGOs
- Private equity, holding companies, investment firms
- Architects, planners, designers
- Recruiters and staffing firms
- Freelancers and solo operators
- **Direct competitors and adjacent certificate-lifecycle vendors** — AppViewX, Entrust, CyberArk
  (which completed its Venafi acquisition in October 2024), and any vendor whose own product is
  certificate lifecycle management
- **Existing Form3 payments customers** — suppress or split into the client-led warm motion. See
  Suppression / DNC in `client-brief.md`. This is the single highest-risk list-hygiene item in the
  build.
- Managed service providers and systems integrators selling platform operations as a service
  (they are a channel conversation, not this campaign)

> **On revenue:** the form's minimum-revenue answer was $5M-$20M, which contradicts a 501+
> headcount gate and a GBP 60k-120k typical ARR. **Do not gate on revenue.** The headcount and
> Kubernetes gates do the work; a revenue filter here would only strip out large private companies
> that do not publish figures. Logged as Open question 2 in `client-brief.md`.

> **On public sector:** the form's own vertical list includes Public Sector, and the call named
> government departments directly (DWP, the Office for National Statistics, HM Land Registry) as
> live candidates. Public sector is **in scope**, with the caveat that procurement is slow and
> these are better run as a named-account motion than as cold volume. The non-profit / charity /
> NGO exclusion above is a separate thing and still applies.

---

## Sweet-spot niche

Cloud-native enterprises running business-critical digital platforms on Kubernetes, where downtime
is measured in money and the certificate estate has outgrown the process that manages it. In the
client's own words on the form: "CEO, CTO, Platform Engineering Leaders, Heads of Infrastructure at
cloud-native enterprises (running Kubernetes) for business critical digital platforms... They
currently depend on fragmented tools, specialist teams, and manual governance processes to manage
security, certificate trust, and infrastructure risk."

The sub-verticals named on the form: SaaS, online retail, finance, fintech, automotive, energy,
pharmaceuticals, gaming, media, retail, public sector, travel, telcos, and regulated companies
generally.

**Where they win fastest:** the client has no external customers yet, so there is no proven
fastest-closing segment. What the call gives us instead is a negative finding worth more than a
positive one — "it's not the payments people who listen to that conversation." The listener is the
platform, infrastructure and security function, not the payments or commercial function, even
inside a company that already buys from Form3. Build to that.

---

## Dream-company DNA to reachable anchors

**The dream list as submitted:** Travelport, Booking.com, Zalando, BBC, SAP, NatWest Group, ASOS,
ING Bank, Vodafone, Nokia.

**The DNA underneath it:** consumer-facing or transaction-facing at very large scale; revenue stops
the moment the platform stops; a public, engineering-led migration to Kubernetes and microservices;
a named platform or SRE function that talks publicly about how it runs; and either a regulator or a
customer base that treats an outage as a reportable event.

**Reachability verdict:** every name on that list is a 10,000+ headcount enterprise where cold
outbound reaches a gatekeeper and the buying centre is four layers deep. **Move all ten to a
named-account motion** — multi-threaded, executive-introduced, and paced over quarters, run
alongside the outbound rather than inside it. They are not month-1 pipeline. (The call's own
counter-example — breaking through to the CEO of Holland and Barrett on an InMail — shows it is
possible, not that it is repeatable enough to plan a month on.)

**Reachable mid-market anchors carrying the same DNA** (use these as the reference URLs in the
lead-search query, not the dream logos):

1. **Trainline** — UK, high-traffic consumer transaction platform, public engineering culture,
   heavy microservices footprint.
2. **Skyscanner** — UK, travel search at scale, long-running public record of its Kubernetes and
   microservices migration.
3. **Auto Trader UK** — UK, marketplace, unusually open engineering blog covering platform and
   cloud-native operations.
4. **Ocado Technology** — UK, robotics and retail platform, heavily containerised, regulated retail
   supply chain.
5. **Deliveroo** — UK and Continental Europe, real-time logistics platform where minutes of
   downtime are direct lost revenue.

> **Build-time note:** verify every anchor's LinkedIn slug and current Kubernetes evidence on the
> day the search is built. These are chosen for DNA match and public engineering visibility, not
> because anyone has confirmed they are in-market. They are reference points for a similarity
> search, nothing more.

> **Geographic balance flag:** all five anchors are UK-centred, which will bias a similarity search
> towards UK and Ireland. Since the ICP includes North America and Continental Europe, either add
> one North American and one Continental European anchor at build time, or run the company search
> in three geo-scoped passes so the US and EU lists are not crowded out. Logged as Open question 17
> in `client-brief.md`.

---

## People-criteria (paste-ready — single line each)

- **countries_include:** United States, Canada, United Kingdom, Ireland, Netherlands, Germany, France, Spain, Sweden, Denmark, Norway, Finland, Belgium, Switzerland, Austria, Italy, Poland, Portugal, Luxembourg

- **countries_exclude:** India, Philippines, Pakistan, Bangladesh, Sri Lanka, Vietnam, Indonesia, Malaysia, China, Brazil, Argentina, Colombia, Mexico, Egypt, Nigeria, Kenya, South Africa, United Arab Emirates, Australia, New Zealand, Japan, Singapore

- **seniority_levels:** C-suite, VP, Director, Head

- **titles_include:** Chief Technology Officer, CTO, Chief Information Officer, CIO, Chief Information Security Officer, CISO, Chief Technical Officer, Chief Executive Officer, CEO, VP of Engineering, Vice President of Engineering, VP of Platform Engineering, Vice President of Platform Engineering, VP of Infrastructure, Vice President of Infrastructure, VP of Technology, Vice President of Technology, VP of Cloud, Vice President of Cloud, VP of Security, Vice President of Security, VP of Information Security, Vice President of Information Security, VP of Site Reliability Engineering, Vice President of Site Reliability Engineering, Director of Engineering, Engineering Director, Director of Platform Engineering, Platform Engineering Director, Director of Infrastructure, Infrastructure Director, Director of Cloud Engineering, Cloud Engineering Director, Director of Site Reliability Engineering, Director of Information Security, Information Security Director, Director of Security Engineering, Director of Cyber Security, Head of Platform, Head of Platform Engineering, Head of Infrastructure, Head of Cloud, Head of Cloud Platforms, Head of Site Reliability Engineering, Head of SRE, Head of DevOps, Head of Security Engineering, Head of Information Security, Head of Cyber Security, Head of Technology, Head of Engineering, Chief Architect, Head of Architecture, Director of Technology, Technology Director

- **titles_exclude:** Recruiter, Technical Recruiter, Talent Acquisition, Head of Talent, HR Director, Human Resources, People Operations, Chief People Officer, Talent Partner, Account Executive, Account Manager, Sales Director, Sales Engineer, Solutions Engineer, Solution Architect Presales, Business Development, Partnerships Manager, Channel Manager, Customer Success Manager, Marketing Manager, Product Marketing Manager, Software Engineer, Senior Software Engineer, Staff Engineer, DevOps Engineer, Site Reliability Engineer, Platform Engineer, Security Engineer, Systems Administrator, Support Engineer, Intern, Graduate, Junior, Analyst, Consultant, Principal Consultant, Managing Consultant, Professor, Associate Professor, Lecturer, Senior Lecturer, Researcher, Research Fellow, PhD Student, Student

- **max_people_per_company:** 3

> **Note on `max_people_per_company`:** the template's default for enterprise (1,000+) is 10 to 20.
> We are deliberately overriding it to **3**, because the client specified the multi-threading
> depth themselves on form field 38: "Both — companies first, then multi-thread across 2-3 people
> per account." With a conservative 10 connection requests per seat per day across three seats, a
> deeper per-company cap would burn the whole daily allowance on a handful of accounts.

> **Note on including CEO:** the form lists CEO as a target title and the call reinforced it ("the
> more the better at the top of the organization"). Keep it, but **cap CEO to one per company and
> only where headcount is under roughly 1,000** — at a 5,000-person bank the CEO is noise, at an
> 800-person scale-up they are a real shortcut. Above that band, lead with CTO, CISO, VP
> Engineering and Head of Platform.

> **Note on the geo exclude list:** this is a safety net, not a statement about those markets. Its
> only job is to catch offshore engineering hubs and global-delivery centres where a person with a
> perfect title sits outside the buying centre for a European or North American parent. If the
> client later wants APAC or ANZ as real territory, that is a scope change, not a filter tweak.

---

## Signals to trace

Mapped to the angles in `angle-menu.md`. Each is observable from public data and dated.

| Signal to trace | Feeds angle | Where it is visible | Recency window |
|---|---|---|---|
| Platform / SRE / infra / PKI role posted, JD names Kubernetes, TLS, mTLS, cert-manager, PKI, HSM or service mesh | 1 | Company careers page, LinkedIn Jobs, job boards | 30 days |
| Public evidence of production Kubernetes at scale | 1, 2, 4, 5 | Engineering blog, conference talk, CNCF or cloud case study, public repo, job ads | 24 months |
| Uptime-criticality evidence (status page exists, SLA published, real-time or transactional service) | 1, 2, 5 | Status page, SLA or terms page, product pages | current |
| Regulatory or operational-resilience obligation (DORA, PSD2, NIS2, PCI DSS, FCA or PRA supervision, public-sector service standards) | 2, 4 | Annual report, regulatory filings, compliance and trust pages | 12 months |
| New platform, infrastructure or security leader in seat | 3 | LinkedIn profile start date, press release, company blog | 9 to 12 months |
| Published post-quantum or crypto-agility commitment | 4 | Corporate blog, roadmap page, regulatory response, working-group membership, PQC-related job req | 12 months |
| Public certificate, TLS or chain-of-trust incident admission | 5 | Status page history, engineering postmortem, RCA, regulatory incident notice | 90 days |
| Individual public statement about certificate or PKI operational pain | 6 | LinkedIn post, X thread, conference talk or abstract, engineering blog byline | 6 months |
| Language mining only (never person identification) | 6 | r/kubernetes, r/devops, r/sysadmin, Hacker News | ongoing |

**Two signals the client asked about that we cannot buy off the shelf:**

*Certificate expiry dates per company.* Raised on the call and correctly identified as the dream
signal. Publicly served leaf certificates do expose an expiry date, but the certificates that
matter here are the hidden internal ones, which are by definition not observable from outside. We
also should not scan a prospect's estate uninvited — that is exactly the surveillance framing that
gets an account blocklisted. **Treat this as unavailable and substitute the angle-1 and angle-2
proxies.** This is a settled finding rather than an open question - it is recorded in
`market-intel.md` under what we could not find.

*"Invent the job before it is posted."* Edward's pattern from the recruiting clients — infer the
hiring need from a raise or a revenue jump before the req goes live. It transfers here in a
weaker form: a company that has just announced a major platform migration, a new region, or a
cloud-provider partnership is about to staff platform engineering. Worth testing as a variant
inside angle 1, but it is a second-order inference and should not displace the actual job posts,
which the client called "much more positive signals."

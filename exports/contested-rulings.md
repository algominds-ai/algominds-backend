# Contested Rulings Packet

Raw texts only, for blind adjudication. No verdict given here.

---

## 1. sidekickmoney.com — Ondato — db `eval_p2ondato-last`

**Profile requirement (r2, strict):**
> "The company runs a high-volume consumer or SMB self-serve signup in fintech, neobanking, payments, lending, trading, crypto or an age-gated consumer platform. The company signs customers up through its own product. A company that reaches customers through partners, brokers, resellers or embedded platforms, or that serves only businesses through sales-led onboarding, or whose record shows no self-serve signup, does not qualify."

**Company record (`company.data->entity`):**
- name: Sidekick
- workforceTotal: 16
- fundingTotal: (empty)
- revenueAnnual: 1000000
- country: United Kingdom
- description: "Private Wealth, Unlocked.\nWe're on a mission to unlock the financial advantages of the ultra wealthy.\n\n1) Expertly managed portfolios managed by our in-house asset management team.\n2) High Yield Savings: Market leading rates to make the most of your cash\n3) Liquidity: Stay long term invested. We offer a line of credit if needed, subject to assessment, to help cover any costs without selling your portfolio (can't be used for investing)\n4) Across wider assets - We aim to offer diversified, risk-managed portfolios of public equities, alternative and private market investments, to help diversify and enhance risk-adjusted returns\n\nPlease remember, investing should be viewed as longer term. Your c[...]"

Evidence rows: `name`, `domain`, `evidenceUrl` (https://sidekickmoney.com/), and a matching `search-result` blob. No separate judge-input row.

**Key ruling (`eval/keys/ondato.json`):** label `reject:excluded-type`.
**Key note:** "the record's own fitReason describes a boutique, in-house-managed private wealth service reading as a low-volume relationship product rather than high-volume self-serve signup, which the profile's strict requirement explicitly excludes as sales-led/relationship-led"

---

## 2. konghq.com — Form3 — db `eval_p2form3-log`

**Profile requirement (r5):**
> "The company runs production Kubernetes at scale across a distributed, multi-service architecture, as evidenced by a public engineering blog post, conference talk, CNCF/cloud-provider case study, or public repository."

**Company record:**
- name: Kong
- workforceTotal: 756
- fundingTotal: 344101000
- revenueAnnual: 28472000
- country: United States
- description: "No AI without APIs.\n\nKong Inc., a leading developer of API and AI connectivity technologies, is building the connectivity layer for AI. Trusted by the Fortune 500 and AI-native startups alike, Kong's unified API and AI platform enables organizations to secure, manage, accelerate, govern, and monetize the flow of intelligence across APIs and AI traffic — on any model, any cloud."

**Judge-input evidence (`kind: signal`)** repeats requirement r5's text verbatim.

**Judge-input evidence (`kind: proving-page`):** https://konghq.com/blog/engineering/managing-konnect-entities-from-k8s-clusters, dated 2024-12-18. Excerpt: "How We Built It: Managing Konnect Entities from K8s Clusters with KGO | Kong Inc. ... We recently released Kong Gateway Operator 1.4 with support for managing Konnect entities from within the Kubernetes clusters. [...]"

**Key ruling:** label is `null` (no ruling recorded).
**Key note:** "undecidable: the only citation is Kong's own engineering blog about building the Kong Gateway Operator, a Kubernetes-native tool for managing Konnect entities; this demonstrates Kubernetes-tooling engineering work but does not confirm Kong itself runs production Kubernetes at scale for its own operations, [...]"
**Key `record.fitReason`:** "No evidence describing Kong's certificate lifecycle or PKI governance practices."

---

## 3. decathlon.net — Form3 — db `eval_p2form3-ent`

**Profile requirement (r3, entity/headcount):**
> "The company has between 501 and 10,000 employees and operates in North America, the UK & Ireland, or Continental Europe (Netherlands, Germany, France, Spain, the Nordics, Belgium, Switzerland, Austria, Italy, Poland, Portugal, Luxembourg)."

**Company record:**
- name: Decathlon Digital
- workforceTotal: 1213
- fundingTotal / revenueAnnual: (both empty)
- country: France
- description: "Decathlon Digital: Powering sports for tomorrow.\n\nGuided by our corporate North Star – to move people through the wonders of sport – our goal is to enable Decathlon to become the biggest digital sports platform and open ecosystem, empowering sports lovers and athletes everywhere.\n\nWe design innovative software, data, security, and robotics solutions to deliver a seamless and secure ecosystem of sports products and services to our 400 million customers and users worldwide while enabling our 101,000+ teammates to thrive.\n\nJoin us on this journey to build the future of sports technology."

**Judge-input evidence (`proving-page`):** https://opsmatters.com/videos/042-cloud-native-evolution-simplifying-k8s-developers-maxime-veroone-decathlon, dated 2025-04-30. Quote: "Live from KubeCon London, this episode of Kubernetes for Humans features Maxime Veroone, Staff Engineer at Decathlon's e-commerce division, sharing the company's cloud-native transformation story. [...]"

**Key ruling:** label `reject:unreachable`. No stored `note` beyond the fitReason below.
**Key `record.fitReason`:** "No evidence about certificate lifecycle or PKI governance practices is provided for the company."

---

## 4. sainsburys.jobs — Form3 — db `eval_p2form3-b1`

**Profile requirement r4** (r3 headcount/entity text is the same as row 3):
> "The company owns the direct relationship with the end customers whose transactions and sessions run on its cluster and keeps an in-house engineering team that operates that infrastructure day to day, rather than delegating platform operation to an MSP or SI."

**Company record:**
- name: Sainsbury's Digital, Tech and Data
- workforceTotal: 860
- fundingTotal / revenueAnnual: (both empty)
- country: United Kingdom
- description: "Our tech team plays a vital role in supporting Sainsbury's mission and strategy for the future. We power the UK's third-busiest retail site, and our innovations allow our customers to shop and connect with us whenever they want to, reliably and safely, and help our colleagues to do their jobs brilliantly."

**Judge-input evidence (`proving-page`):** https://jobsforwomen.co.uk/jobs/engineer-java-colleague-operations/, dated 2024-11-12. Quote: "You'll work with cloud and container technologies such as Kubernetes and Fargate on AWS [...]"

**Key ruling:** label `reject:unreachable`.
**Key `note`:** "ruling this as Sainsbury's itself rather than the scoped 'Digital, Tech and Data' careers-subdomain entity the record names, Sainsbury's is a large UK-wide retail group well above the 501-10,000 staff band this profile requires; the delivered workforceTotal of 860 reflects only the tech-division seed, not the parent company. [...]"
**Key `record.fitReason`:** "No evidence about certificate lifecycle or PKI management practices for Sainsbury's."

---

## 5. payone.com — Form3 — db `eval_p2form3-b1`

**Profile requirement r4** (same text as row 4).

**Company record:**
- name: PAYONE
- workforceTotal: 543
- fundingTotal / revenueAnnual: (both empty)
- country: Germany
- description: "With more than 260,000 customers and 6 billion processed transactions per year, PAYONE is the leading payment provider in Germany and Austria. In stationary shops, mobile or online - PAYONE helps merchants and service providers to address the challenges of cashless payments. PAYONE ensures quick, easy and reliable digital payment processes. PAYONE develops customised solutions for all industries and sizes of companies according to the highest security standards. PAYONE is a joint venture of Worldline and the DSV Group (Deutscher Sparkassenverlag)."

**Judge-input evidence (`proving-page`):** https://meiyu.eu/projekt/payone/, dated 2025-05-22 — a third-party agency's own case study, not Payone's site. Quote: "Im Backend sorgt eine Microservice-Architektur auf Kubernetes für Stabilität und Skalierbarkeit, abgesichert durch mutual TLS und modernste Messaging-Technologien. [...]"

**Key ruling:** label `null` (no ruling recorded).
**Key `note`:** "undecidable: the only citation is meiyu.eu's own portfolio case study describing a payment platform meiyu built for PAYONE as a client, not PAYONE's own engineering account; [...] a third-party dev shop's build case study does not establish whether PAYONE itself keeps in-house ownership per r4"
**Key `record.fitReason`:** "No evidence on in-house day-to-day operations or certificate/PKI lifecycle management practices."

---

## 6. Midnite people — Ondato — db `eval_p2screen-ondato`

**Buyer rubric (people profile):**
> "The buyer is the person accountable for signup conversion: Chief Revenue Officer, Chief Growth Officer, Chief Marketing Officer, Chief Product Officer, Head of Growth, Head of Product, Head of Marketing or Head of Business Development. A Founder or CEO qualifies only when the roster holds no such growth, product or marketing owner, or when the founder explicitly holds that operating responsibility; company size is context, not a cutoff. Compliance officers, MLROs, heads of risk, general counsel, CISOs, CTOs and engineering leaders are never the buyer."

**Full delivered roster for midnite.com (`person.title` in the database):**
1. Ryan Murton — Vice President, Commercial
2. Sam Talbot — VP Product
3. Jonathan Shaw — VP, Growth
4. Andrew Mook — Head of Brand Marketing
5. Dave P. — Head of Product - Sportsbook Platforms
6. Ryan Attfield — Head of Integrated Marketing Planning
7. Mike Laryea — Head of Product

(The key also has `reject:not-buyer` entries for two Founders, Daniel Qu and Nick Wright, absent from the `person` table.)

**Contested — key ruling `reject:not-buyer`:**

- **Andrew Mook, Head of Brand Marketing.** Note: "Head of Brand Marketing at Midnite; the delivered roster shows a VP, Growth (Jonathan Shaw, accepted) already accountable for growth/conversion, so this brand-specific marketing sub-function does not get elevated to the marketing-owner buyer role." Verify-poll evidence: verdict `CONFIRMED`, evidence_quote "Andrew Mook, Head of [...]".

- **Ryan Attfield, Head of Integrated Marketing Planning.** Note: "Head of Integrated Marketing Planning at Midnite; the delivered roster shows a VP, Growth (Jonathan Shaw, accepted) already accountable for growth/conversion, so this marketing-planning sub-function does not get elevated to the marketing-owner buyer role." Verify-poll evidence: verdict `CONFIRMED`.

- **Ryan Murton, Vice President, Commercial.** Note: "Vice President, Commercial at Midnite; a partnerships/commercial-deal function, not the Chief Revenue Officer or another rubric-named role accountable for signup conversion, and the roster already has a VP Growth and Heads/VP of Product filling that accountability." Verify-poll evidence: verdict `CONFIRMED`, evidence_quote "Vice President, Commercial at Midnite ...".

**Contrast — key ruling `accept`:**

- **Jonathan Shaw, VP, Growth.** Note: "VP, Growth at Midnite, a senior growth-ownership title matching the buyer rubric; based in London, UK." Verify-poll evidence: verdict `CONFIRMED`, evidence_quote "Midnite is a UK-b[...]".

- **Mike Laryea, Head of Product.** Note: "Head of Product at Midnite, an explicit buyer title; based in the UK." Verify-poll evidence: verdict `CONFIRMED`, evidence_quote "Head of Product (Current)".

---

## 7. steadypay.co — Ondato — db `eval_p2final2`

**Profile requirement r2** (strict, same text as row 1).

Also relevant, r3 (exclusion):
> "The company is not a verification vendor, a compliance consultancy, an agency or a non-profit."

**Company record:**
- name: SteadyPay
- workforceTotal: 14
- fundingTotal: 13397076
- revenueAnnual: 2000000
- country: United Kingdom
- description: "Unlock the power of embedded lending solutions to enhance your services. \n\nOur Lending as a Service (LaaS) platform integrates seamlessly, allowing you to offer tailored credit services to small businesses and individuals. \n\nImprove their creditworthiness, pre-assess eligibility, and provide access to credit with our advanced open banking risk engine. Battle-tested with high approval rates and low defaults, our white-label lending products are configurable, so you only plug in what you need. \n\nEmpower your customers' financial wellbeing and take your services to the next level.\n\nSteadyPay is authorised and regulated by the UK FCA."

Evidence rows: `name`, `domain`, `evidenceUrl` (https://steadypay.co/), and a matching `search-result` blob. No proving-page row.

**Key ruling:** label `reject:excluded-type`.
**Key `note`:** "the record's own description says SteadyPay is a white-label Lending as a Service platform that other businesses integrate to offer credit to their own customers, a B2B2C embedded-finance model, the same pattern as payitmonthly.uk and payl8r.com"
**Key `record.fitReason`:** "UK-based consumer lending app with self-serve app signup; revenue and funding both fall within required ranges."

---

*Word count: 1,801*

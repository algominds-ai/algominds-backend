# Final controls review

Scope: `exports/onboarding-cycle-2026-09-06/final-controls-inputs.json`, all eight final receipts in `final-controls-receipts.jsonl`, and the V2/final shape artifacts. This is a read-only review. No provider calls, tuning, code edits, or tests were run.

## Control contract checked

`shape-final.ts.txt:3-32` requires each window to preserve amount, unit, `appliesTo` (`event`, `publication`, or `observation`), and direction (`past` or `future`). It requires seller customers to have explicit customer evidence, `sourceUrls` to be supplied URLs, missing offer/buyer choices to be null, required groups to be ANDed, alternatives to be ORed, preferred groups to preserve their own Boolean logic, and `sourceRule` to contain only stated evidence restrictions. It also says not to replace an event with its announcement or future plan, and not to invent limits, roles, signals, sources, duplicate criteria, or whole-company exclusions.

The V2 shape (`shape-v2.ts.txt:3-32`) did not include window direction. The final shape adds it and strengthens the seller-customer/source and unknown handling instructions. The review below uses the final shape as the controlling contract.

## Coverage and failures

All eight receipts completed: `final-controls-receipts.jsonl` entries for `original-final`, `compliance-control-final`, `cloudflare-access-final`, `snyk-domain-only-final`, `deel-composite-final`, `toast-operations-final`, `ondato-optional-final`, and `future-event-final`.

### original-final — PASS

`original-final.json:30-31,167-230,237` preserves the KYC/age-assurance offer, growth buyer and explicit KYT exclusion. The five trigger alternatives stay in one preferred OR group. Funding and revenue are separate required alternatives (`:73-114`), and the event/observation subjects and past directions are correct: event windows for market entry/product launch/funding (`:167-230`) and observation for app-store/Trustpilot complaints (`:182-193`). The explicit review source rule and compliance/enforcement source rule are retained (`:193, :207-216`). The four emitted customers are tied to supplied case-study/customer pages in the input, with no observed partnership-only customer invention.

### compliance-control-final — PASS with a minor offer-wording risk

`compliance-control-final.json:42-43,44-119` preserves the compliance-only buyer, private payments + UK customer gates, and the required funding AND revenue group (`:74-89`). It keeps no upper funding bound, makes product launch preferred, and preserves the competitor definition. Customers are sourced from supplied case-study pages (`:8-24,26-38`); no partnership-only name was observed.

Minor risk: the offer says no other Ondato line is in scope (`:42`), although the note names identity verification as the offer without listing product exclusions. This is borderline because “identity verification ... only” supplies some scope; if the oracle requires explicit exclusions, treat it as an invented exclusion and tighten the input wording or output rule.

### cloudflare-access-final — PASS on ICP/Boolean structure; FAIL on unknown/source handling

The product, six required gates, geographic OR, and three-signal preferred OR are preserved (`cloudflare-access-final.json:15-128`). The missing recency bound is correctly recorded (`:130-131`).

Failures:

1. The note says “a CISO is not required.” The output adds an unknown claiming it is unclear whether CISOs are acceptable or excluded (`:132`). That invents ambiguity and can be read as an exclusion; the buyer text already preserves the intended “not required” meaning (`:16`).
2. Each signal explicitly says “publicly mentions,” but all three `sourceRule` values are null (`:103-124`). The final shape requires stated evidence restrictions to survive.

### snyk-domain-only-final — PASS

`snyk-domain-only-final.json:7-22` correctly keeps `offer:null`, `buyer:null`, no requirements, and one concise unknown explaining that no targeting note was supplied. It does not invent product, geography, size, buyer, trigger, or recency choices. `Yalo` is the only named customer and is supported by the supplied customer quote/page text; no partnership-only customer was inferred.

### deel-composite-final — PASS on Boolean/date/null-buyer checks; FAIL on scope/source provenance

`deel-composite-final.json:21-25,80-124` correctly leaves buyer null with an explicit unknown because the note names no decision-maker (`:21, :123-124`). The preferred group preserves `(hire within 90d AND expansion within 180d) OR replacement within 60d` (`:80-120`), with all three windows as past events and no flattening. Seller customer names correspond to explicit Deel customer-story headings in the supplied payroll page (`:8-16`), not merely integrations or partners.

Failures:

1. The offer invents exclusions for EOR, PEO, Contractor, Local Payroll, Payroll Connect, Expense Management, Benefits, and AI Agent (`:20`). The note identifies Deel Payroll but does not explicitly enumerate those exclusions. The final shape says excluded products must be explicit.
2. “Public payroll-provider replacement announced” is an explicit source restriction, but its `sourceRule` is null (`:107-117`). The other two alternatives have no stated source restriction and may remain null.

### toast-operations-final — PASS

`toast-operations-final.json:14-97` preserves the all-in-one Toast Platform scope, required US/independent-group/3–50/in-house-operations AND, and the broad operations/finance/technology/ownership buyer (`:14-15`). General Manager, Controller, and IT Manager survive in the buyer text. The optional opening/replacement OR retains the explicit public-source rule (`:74-94`). No date bound is invented, and the empty customer list is correct for the supplied page because it gives aggregate usage rather than named customer evidence.

### ondato-optional-final — FAIL on date subject/direction and likely public-page provenance; also scope expansion

The hard age-gated/private/UK-or-US/20+ and competitor exclusion are present (`ondato-optional-final.json:38-71`), and every signal is preferred in one OR group (`:73-118`). Buyer scope is preserved (`:36-37`).

Failures:

1. “User signup-verification complaints within 6 months” is an observation, but output marks it `appliesTo:"event"` (`:89-100`). This confuses the observed complaint with an event.
2. “Prefer a launch within 12 months” does not state past versus future. The final contract says direction must be null/unknown when ambiguous, but output chooses `direction:"past"` (`:78-85`) and leaves `unknowns:[]` (`:120`). Funding is clearly past because the note says “raised”; complaint timing is also past because users “have posted.”
3. The intended control requires optional signals to be supported by public pages, but all three `sourceRule` values are null (`:78-114`). Caveat: the literal note in `final-controls-inputs.json` does not contain “public” or “page,” so this is an oracle/input mismatch if that restriction is not meant to be implicit. Under the stated control intent, it is a failure; under the literal sourceRule instruction, the input is missing the restriction.
4. The offer adds a full exclusion list for other Ondato products (`:36`) that the note does not explicitly enumerate. This is the same “invented exclusions” issue as Deel.

Customer provenance is otherwise clean: the emitted names have corresponding supplied Ondato case-study pages (`:8-32`); no partner-only name was found.

### future-event-final — PASS on Boolean/date subject/direction; FAIL on source rule

`future-event-final.json:15-75` correctly preserves the required hard AND (`:19-45`) and one preferred allOf group for the two-part trigger (`:48-74`). The announcement publication window is past and applies to publication (`:53-60`); the office closure is a scheduled future event and applies to event (`:63-70`). It does not require that the closure already happened, and buyer location is preserved in the buyer text (`:16`).

Failure: “public announcement” is an explicit evidence restriction, but both preferred conditions have `sourceRule:null` (`:53-70`). The output preserves the public wording only in the condition text, not the source field.

## Exact checklist result

| Control | Boolean groups | Date subject/direction | Explicit source rules | Unknown/null buyer | Customer provenance | Result |
|---|---|---|---|---|---|---|
| original | pass | pass | pass | pass | pass | pass |
| compliance | pass | n/a | n/a | pass | pass | pass; offer wording risk |
| Cloudflare Access | pass | n/a | **fail: public dropped** | **fail: invented CISO ambiguity** | pass | partial |
| Snyk domain-only | n/a | n/a | n/a | **pass: offer/buyer null** | pass | pass |
| Deel Payroll | **pass: AND/OR** | **pass: 90/180/60 past events** | **fail: public dropped** | **pass: buyer null** | pass | partial |
| Toast Platform | pass | n/a | pass | pass | pass | pass |
| Ondato age assurance | pass | **fail: complaint event; launch past invented** | likely fail; input caveat | partial | pass | fail |
| Cloudflare future event | pass | **pass: past publication + future event** | **fail: public dropped** | pass | pass | partial |

## Main follow-up actions

1. Treat `sourceRule` as a first-class assertion: public/public-page/public-announcement restrictions must be present only where the input actually states them. Add the missing Ondato wording to the oracle if that restriction is intended.
2. Reject invented offer exclusions and invented unknowns. Deel and Ondato need scope wording fixes; Cloudflare should keep “CISO not required” without creating a new ambiguity.
3. Add a date-subject assertion for complaint/review observations and an ambiguity assertion for unqualified “within N” language. Keep future planned events distinct from past announcements.
4. Keep the Snyk domain-only and Deel null-buyer behavior as required controls. Keep customer extraction constrained to explicit customer stories/quotes; integrations, partners, aggregate logos, and merely mentioned organizations do not qualify.

# GATE — retrieval policy report

20/20 companies ran, 0 not run, cap $3.00. Planner `rejected` count: 0 for every plan and
every replan — no invented band, department, or basis value.

## Per company

| company | U | providers | new | apollo-only | round2 | marginal | $ | s |
|---|---|---|---|---|---|---|---|---|
| Airwallex | 275 | clay | 38 | 0 | no | – | 0.042 | 22.7 |
| Arq | 15 | clay | 1 | 0 | no | – | 0.018 | 21.3 |
| Discord | 157 | clay | 3 | 0 | no | – | 0.025 | 15.2 |
| Kraken | 170 | (none) | 0 | 0 | no | – | 0.032 | 23.5 |
| MoonPay | 80 | clay | 5 | 0 | no | – | 0.026 | 25.5 |
| Polymarket | 59 | clay | 1 | 0 | no | – | 0.023 | 26.4 |
| Poshmark | 235 | (none) | 0 | 0 | no | – | 0.034 | 20.1 |
| Ramp | 137 | clay | 29 | 0 | no | – | 0.028 | 23.1 |
| Relay | 21 | clay | 1 | 0 | no | – | 0.018 | 19.0 |
| Seccl | 26 | clay | 0 | 0 | yes | 0 | 0.025 | 35.3 |
| Centre Technologies | 21 | clay | 2 | 0 | no | – | 0.017 | 27.6 |
| Cyber Salus | 6 | clay+exaAgent | 0 | 0 | yes | 0 | 0.357 | 82.5 |
| CyberlinkASP | 8 | clay | 0 | 0 | yes | 0 | 0.023 | 31.6 |
| DAS Health | 27 | clay | 0 | 0 | yes | 0 | 0.024 | 38.6 |
| Evergreen Services Group | 14 | clay | 0 | 0 | yes | 0 | 0.023 | 31.3 |
| FRSecure | 10 | clay | 0 | 0 | yes | 0 | 0.024 | 29.0 |
| Harbor IT | 31 | clay | 3 | 0 | no | – | 0.020 | 20.5 |
| NewBold Technologies | 11 | clay | 0 | 0 | yes | 0 | 0.022 | 25.3 |
| Ntiva | 49 | (none) | 0 | 0 | no | – | 0.021 | 19.9 |
| eTrepid | 2 | (none) | 0 | 0 | no | – | 0.011 | 12.2 |

Apollo and Exa people-search never ran in round 1 — the planner only ever paid for Clay's
uncovered "manager" band, keyworded, on top of the free senior universe. Round-1 apollo-only
leads: 0 everywhere, since Apollo never ran there.

## Overlap (pooled, round 1)

Non-zero only for `clayU × clay` (15) and `clayU × exaAgent` (4, Cyber Salus). Every other
pair — clay×apollo, clay×exa, apollo×exaAgent, etc. — is 0: no company's plan doubled up two
paid providers on the same slice.

## Round 2: trigger and outcome

Ran at 7/20 (Cyber Salus, Seccl, CyberlinkASP, DAS Health, Evergreen, FRSecure, NewBold), all
on the same deterministic trigger: the round-1 manager-band Clay call, keyworded for
HR/recruiting/onboarding, returned 0 rows. That is a real signal — Clay's manager index is
thin at 8–31-person companies — not a planner artifact. Marginal was 0 at all 7. At 4
(Seccl, Evergreen, FRSecure, NewBold) the replanner correctly pivoted to Apollo by department,
which returned 12–25 rows each — but Apollo's obfuscated surnames and missing URLs make those
apollo-only leads, never new resolved people, unless another provider lands on the same name.
None did. The loop replanned the real gap correctly; the ceiling is Apollo's identity opacity.

## 3 most interesting new people

- **Lisa Ramirez**, Senior HR Manager, Centre Technologies — manager-band Clay only; selected
  under the Aris rubric's sole-HR-manager clause.
- **Micah Ralph**, Talent Acquisition & Recruiting Operations Manager, Harbor IT — same find,
  same basis.
- Airwallex's "growth"-keyworded manager-band Clay call returned ~20 sales/marketing titles
  ("Manager, GTM Partnerships and Growth", "Growth Content Marketing Manager") — not
  onboarding-product owners, none selected. A keyword-ambiguity finding: "growth" pulls
  sales/marketing noise as often as product buyers.

## Identity: Harbor IT and Evergreen

Both resolved in phase 0. Harbor IT's stored domain (harbormsp.com) returned 0 rows, so stage
1 fell back to the stored LinkedIn URL (11 rows), used as `identifierUsed`. Evergreen's stored
domain returned 4 rows matching the LinkedIn path with no conflict, so it resolved via domain
— the intentionally-wrong LinkedIn slug never got exercised. Neither produced a confident-wrong
or confident-empty roster.

## Cost

Cyber Salus cost $0.357 against $0.011–$0.042 elsewhere: one `exa-agent` call, effort low,
billed $0.225 (not the ~$0.03 the kit documents) for 4 candidates already in U. After this
call this agent added a budget guard (max 6 exaAgent calls, skip within $0.35 of cap) and a
cost note in its own prompt; no later plan requested exaAgent.

**Total ledger("GATE").spent(): $0.8232.**

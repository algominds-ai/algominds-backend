# AGENTVERIFY — Exa agent as a verification replacement

30 cases, 36 calls, $0.5700 total. Test set: 18 from `vexp-results.json` (12 real, 3 left,
2 wrong-employer, 1 invented) plus 12 weak-hook "verified" cases from `ref/reference.json`.

## Controls: no wrong CONFIRM (first line, as required)

All 6 controls were safe. The invented person, Jonathan Pemberton-Fyfe, was CONTRADICTED
(high). Both wrong-employer cases were CONTRADICTED: Mitul Sudra@Harbor IT (medium), Eric
Regnier@Seccl (high). Of the 3 departed employees, Gregory Griem was CONTRADICTED (medium);
Nicholas Hearne and Denise Monette landed UNKNOWN. Zero wrong CONFIRMs, including the two
hardest cases (invented person, wrong employer).

## Real people: 20/24 agree with the current two-source verdict

Vexp's 12 real cases: 10/12 CONFIRMED, matching the old "verified" status. Lorin Fisher and
Autumn Coffee both landed UNKNOWN, same as two-source. Two disagreements, both the agent
MORE confident than two-source: Alex Henderson and Mitul Sudra (real, @Seccl) — two-source
said unknown (index had no matching row), agent said CONFIRMED high, citing
`https://seccl.tech/about/`, a first-party page the index does not hold.

Ref's 12 weak-hook "verified" cases: 10/12 CONFIRMED (agrees). 2/12 UNKNOWN: Yaroslav
Kravchenko (evidence only places a colleague "alongside" him, not his title) and Hannah
Fornero (a third-party post lists her without confirming her current title) — `evidence_url`
for both is a single third-party post, not a page that actually states the claim.

Total: 20/24 agree; all 4 disagreements look like defensible caution or a genuine first-party
find, not fabrication.

## Hook quality (12 weak-hook cases, one batched MODEL_FAST label)

4/12 specific_event where the free hook never exceeded role_statement/generic: Shannon Scott,
Lu Zhang, Belinda Reynolds, Joel Hagy. 5/12 role_statement (no better, no worse). 3/12 none —
the agent found no usable quote where the free read at least had something: Rama Poola,
Yaroslav Kravchenko, Hannah Fornero — the same three cases it was least sure of above.

## Cost and time

Minimal effort: $0.0120/call avg, 19.9s avg (30 calls, 0 errors). Low effort: $0.0350/call
avg, 18.4s avg (6 calls, same 6/6 verdicts as minimal — low bought nothing here). Today's
two-source rule: $0.014/call, ~3s. Minimal effort lands at cost parity; it is roughly 6–7x
slower per call.

## Failure modes

No timeouts, no schema violations across all 36 calls. `evidence_url` twice pointed away
from the actual source: Rama Poola's CONFIRMED cited MoonPay's help center in
`evidence_quote` but gave a `village.ai` page for an unrelated name as `evidence_url`; Lorin
Fisher's UNKNOWN carried a SignalHire url for "eric-regnier," not for Lorin Fisher. Craig
Harmsen's sole citation was Exa's own library page, not a third-party source. No case
returned a bare LinkedIn profile as its only evidence.

## Verdict

Replacement for both sources, at minimal effort — with one guard. Controls are clean and
dollar cost matches today's rule ($0.012 vs $0.014 per person); real-case agreement is 20/24,
and every disagreement is defensible rather than wrong. The guard: check that `evidence_url`
matches `evidence_quote` before either reaches a person — it failed to in 2 of 30 calls.
Budget for 6–7x the wall time of the current two-source read. Not merely a top-up: it
disagreed with "verified" only on the two weakest old confirmations, where its caution looks
right, not wrong.

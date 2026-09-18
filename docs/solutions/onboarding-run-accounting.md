# Onboarding contract and accounting

An account has seller facts and a scoped ICP in the existing `icp.doc` JSON column. `src/core/icp.ts` is the shared runtime schema for HTTP, workflows and evaluations. No new table or campaign object is needed.

The exact targeting note is stored outside model output as `instructions`. It controls product, audience and buyer intent; seller pages provide facts, not inferred targeting restrictions. A requirement is required or preferred, with OR alternatives containing AND conditions. Each condition carries its own optional time window and source rule. Provider filters and search angles are derived at run time, never stored as account facts.

`extracted: false` marks a free-text request awaiting extraction. It cannot complete onboarding. Company discovery extracts such a request once per durable run and persists the whole profile before searching. An extracted profile without company criteria cannot launch broad discovery. Legacy documents are rejected explicitly; rebuild from original instructions rather than guessing a translation.

## Paid work

Open the run before buying anything. Read seller pages, bank their reported cost, extract the profile, bank its reported cost, then save the profile. The shared `purchase` helper returns plain serializable value, cost and error fields. A failed paid callback resolves this receipt so the workflow can bank partial spend and throw outside the paid step. Model schema failures do not silently trigger another paid attempt.

`recordRunSpend` writes a cumulative total. A restarted run seeds that total from `openRun`, preserving previously banked spend. A failure closes the run as errored. Missing provider billing is unknown, not evidence that a request was free.

`saveOnboardedIcp` locks the onboarding run in a transaction, checks organization ownership, and inserts the extracted profile while closing the run. Replaying a committed save returns its existing ICP ID instead of inserting another profile.

## Reading and revising

`GET /icp/:icpId` returns the owned canonical profile and exact instructions. Submit the complete revised note to `POST /icp/onboard` to produce another profile. The existing request scope includes organization, domain and note, so different targeting does not reuse an earlier onboarding result. Existing runs continue to reference their original profile.

Checks live in `test/onboard/spend.spec.ts`, `test/companies/workflow-errored.spec.ts` and `test/http/icp.spec.ts`. They cover banked failure spend, extraction persistence, replay-safe profile saving, ownership and revised targeting scope. These checks verify mechanics; live extraction fidelity and prospect quality are measured separately in the experiment artifacts.

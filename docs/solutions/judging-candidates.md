# Evaluating company judgments

The company judge assesses requirement conditions against candidate records and
source pages. Numeric bounds alone cannot distinguish a suitable customer from
a vendor, competitor or agency described by the same industry label.

Use `bun run eval company --stage judging` to compare the production judge on
fixed candidates and evidence. Use the company engine stage to measure whether
those decisions improve delivered results. See [Engine evals](eval.md).

Compare against independently reviewed evidence, not agreement with another
model. Repeat identical inputs to expose inconsistent decisions. Preserve the
distinction between a fact contradicted by evidence and one that remains unknown.
Track quality, cost and time separately; old model prices and probe timings are
not current performance guarantees.

The condition and evidence contracts are covered by `test/companies/judge*.spec.ts`.

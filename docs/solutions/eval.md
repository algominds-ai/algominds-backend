# Engine evals

Three independent Braintrust datasets: `onboarding-discovery`,
`company-discovery`, and `people-discovery`, in the `algo-backend` project.
Cases and scorer definitions live in the matching `eval/` folder.

| Suite | Default engine stage | Focused `--stage` |
| --- | --- | --- |
| onboarding | Website and note to ICP | `extraction`: fixed pages and note to ICP |
| company | Fixed ICP to companies | `synthesis`: ICP to plans; `judging`: fixed companies and pages to verdicts |
| people | Fixed ICP and domains to people | `prefilter`: fixed roster to shortlist; `verification`: fixed candidate to live employer evidence |

```bash
bun run eval:datasets
bun run eval onboarding --profile ondato --trials 2
bun run eval company --stage synthesis --profile ondato --trials 2
bun run eval company --stage judging --trials 2
bun run eval people --stage prefilter --trials 2
bun run eval people --stage verification --trials 2
```

Use `--case` with an exact ID from `cases.json`. Engine runs create fresh local
`eval_<suite>_<timestamp>` databases and an account per trial; they never use
`algo`. Components need no database. The runner stops its Worker and trashes its
configuration afterward. Engine databases remain for diagnosis until dropped.

`--local` uses checked-in cases without Braintrust logging or semantic scoring.
It still calls paid providers. `--code-only` uploads mechanical scores without
claiming semantic quality. Neither proves discovery quality.

Compare using `--version <dataset-version>` and `--baseline <experiment-name>`
with the same suite, stage, cases and trial count. Runs record dataset/scorer
versions, commit and working-source hash. Only an explicit baseline enables CLI score comparisons; Braintrust may suggest an
automatic dashboard baseline, which must be checked for matching suite and stage.
Repeat draws because models and
retrieval vary. Old combined experiments are historical diagnostics, not directly
comparable baselines.

`--max-spend 8` stops starting cases once accounted engine/source-read spending
reaches $8. A running case can exceed it; hosted judge charges are additional.
Errors or unknown spend prevent subsequent cases. `--timeout 1200` bounds each
case wait. Failed output never becomes a successful zero-cost run.

Quality, completion, cost and elapsed time are separate. Semantic scorers inspect
evidence and return a rationale. Companies are already qualified for the people
suite; its scorer checks identity, current employer, role and buyer fit.
Onboarding checks seller grounding and targeting fidelity. Company synthesis
checks executable filter logic, including OR conditions; judging checks verdicts
against fixed pages. Scorers are fallible: inspect disagreements and independently
review samples before claiming an improvement. There is no aggregate 10/10 score.

Dated reference people are incomplete public examples. Reference match rate
includes unlabelled output in its denominator; coverage is separate. Recall is
emitted only for explicit closed-world cases. Engine runs reread up to 30 source
URLs; missing decisive evidence must not pass. Components use recorded inputs;
verification deliberately makes a fresh provider call.

Add cases for real failures and production decisions. Keep parsing, database and
transport assertions in ordinary tests. Compare prompts, models or providers on
the same cases, then confirm improvements on held-out engine runs.

# Concurrency 5 throttling check (final run, no paid calls)
HTTP 429: 0 in both runs. Retry-After / RetryableProviderError / rate / verification failed / unreachable: 0 in both. errors, llm_errors, tool_errors: 0.
Evidence rows exa 602 vs 525, clay 386 vs 341, getleads 6 vs 5 (concurrency 5 vs 3). Persons saved 85 vs 70.
People-stage seconds: concurrency 5 mean 91 s (38-169, 7/7 complete); concurrency 3 mean 169 s (46-584, 6 complete, hvac people stage failed to connect).
verifyConcurrency batches Select-mode picks per company into chunks of that width (src/workflows/find-people-verify.ts), one Exa agent call per person; not a global fan-out.
Verdict: no throttling evidence.

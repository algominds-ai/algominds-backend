1. **No—as a truth verifier; yes—as a quotation-presence check.** A company name or irrelevant “partner lending” passage can pass. The screen must inspect requirement → quote → surrounding evidence, not merely the resulting status: SteadyPay and Gettongo must fail strict self-serve proof, while genuinely direct-and-partner businesses remain eligible. This prevents invented quotations; it does **not** prevent misinterpretation.

2. **Yes; acceptable for this screen, explicitly measured.** A supporting fact beyond the description limit disappears, potentially making a good company unproven. Truncation already existed, but this change makes its consequences stricter. Keep identical inputs between comparisons and inspect rejected known-good rows for truncation; do not let the verifier search text the judge never saw.

3. **Yes—require small corrections before spending.**

   - Mark each applicable requirement **“quote required”** in the prompt. Currently `judgePrompt` uses `requirementLine`, which emits only ID and text: the model cannot reliably know which requirements are strict/page.
   - Delete **“only the quoted passage, never the surrounding page, decides.”** That explicitly licenses cherry-picking around negation, attribution and qualifications; require support interpreted in context.
   - Match within individual evidence passages, not their concatenation: whitespace normalization otherwise permits a “verbatim” quote assembled across unrelated sources.

   Add focused checks for prompt markers, missing quotes and cross-passage matching. No second judge or new framework.

4. **$3 maximum: Ondato × 5 and Form3 × 5, companies then people.** First replay saved judge inputs against the controls below; include replay costs within that ceiling.

   - **Reject:** `steadypay.co`, `gettongo.com`, `hioscar.com`, `sennder.com`.
   - **Retain on their saved supporting evidence:** Ondato’s `algbra.com`, `kontigo.lat`, `paymiq.com`, `ziglu.io`, `peymo.com`; Form3’s `skyscanner.net`, `dexcom.com`.

   Anchor retention belongs in fixed-input replay—fresh discovery need not rediscover those domains. For the live screen, require five independently accepted companies per profile, genuinely supporting quotes for every grounded requirement, and existing cost/time gates; report buyer coverage separately. Form3’s non-strict vertical rejection still depends on the earlier category rule, not this verifier.



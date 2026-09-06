**The biggest mistake now would be buying more retrieval before fixing selection.** Six profiles found five accepted companies; several then spoiled otherwise useful output with avoidable people errors. Also, $6.03 exceeded the baseline envelope, and HVAC remains unresolved despite being fully adjudicated.

**1. Three changes, ranked by likely return per implementation effort**

These are conditional gains on this sample, not forecasts.

| Rank | Change | Exact action |
|---|---|---|
| **1** | **PROFILE: clarify buyer exclusions** | Add the Carta and Dental wording below; finish the existing Form3 probe. Removing Carta’s three false positives while preserving its four buyers would recover **1.14 rating points**. Dental’s clinical fix **plus dedupe** could recover **1.43**. |
| **2** | **ENGINE: suppress duplicate person delivery** | In `verifiedPersonRows()` in [find-people-verify.ts](/Users/lahfir/Documents/Projects/Algominds/algo-backend/.claude/worktrees/p2-base/src/workflows/find-people-verify.ts), deliver one representative per established person identity within the company; preserve all source URLs and verification evidence. Dedupe alone does **not** recover Dental’s gated score while the clinical VP remains. |
| **3** | **ENGINE: give selection the facts its conditional rules require** | Carry stored company headcount through `loadTargetCompanies()` → `runSelect()` → `selectBuyers()`. Today the selector receives the ICP description and roster titles/locations, **not actual company headcount**. Apply only conditions explicitly present in that profile; do not restore a universal founder-size cutoff. |

**Carta wording:**

> Accept the internal finance owner: CFO, VP/Head of Finance, or Controller. “Head of Accounts” qualifies only when the role demonstrably owns finance/accounting, not customer accounts. Founder/CEO qualifies only with evidenced headcount below 50 and no identified finance owner. Missing headcount or a sparse roster does not establish this exception.

**Dental wording:**

> Accept the owner or administrative/operations leader responsible for practice-management software purchasing. Clinical leadership—including VP Clinical, Chief Clinical Officer and Clinical Director—does not qualify through seniority alone; require explicit administrative software-budget responsibility.

Do not change the frozen labels to accommodate either wording. **EVAL changes improve steering, not the engine’s earned rating.**

**2. Name+domain+title dedupe: acceptable as suppression, insufficient as identity proof**

The domain rule concerns **which organisation employs someone**; it does not prohibit detecting duplicate people within that verified organisation.

First reuse `canonicalPersonUrl()`: it already removes query strings, fragments and host variants. Different remaining slugs require more evidence.

For this **adjudicated same person**, collapse the aliases. Generally, exact full-name + exact title + verified company domain can flag a collision; two employees can still share those fields. Prefer a shared provider identity or verified profile equivalence before merging. A conservative delivery suppression may keep one and mark the others unresolved, preserving evidence. **Do not use existing `nameKey()` as sufficient proof—it reduces names to first/last and discards distinguishing information.**

**3. Yes—the brutal gate is too discontinuous for steering**

One wrong row among 35 and three wrong rows among seven both become zero. Keep that as the clean-output certification bar.

For **provisional promotion**, predeclare:

- Hard failures remain: wrong employer, prohibited company, invalid required evidence, or incomplete accounting/adjudication.
- Buyer-role mistakes and duplicate deliveries remain penalties in `Q = (B/5) × (T/P)`.
- On affected profiles: **A, B and distinct T must not decrease; buyer precision must not decrease**. Quality changes must improve Q; speed changes may preserve Q while reducing time/cost.
- A regression from one draw is unresolved pending a targeted repeat; an improved mean cannot erase it.

HVAC’s undecidable company remains uncredited. Don’t call the seven-profile result clean while that uncertainty remains.

**4. Form3: test search-first retrieval, retaining the existing proving pipeline**

My single candidate is **one search-first round before agent fallback**, through `routeFor()` in [synthesize.ts](/Users/lahfir/Documents/Projects/Algominds/algo-backend/.claude/worktrees/p2-base/src/core/synthesize.ts). Search candidates already pass through `proveCandidates()` and the same requirements judge; preserve that contract.

**I cannot honestly promise halving 916 seconds from a full-chain total.** The agent fan-out is already concurrent. Search-first only halves the total if it removes enough retrieval time without creating expensive failed proving rounds. Use existing stage timings to establish that; don’t fund another speculative arm now.

**5. Allocate the remaining $9**

| Use | Maximum |
|---|---:|
| Carta + Dental: one paired selector replay per profile on the **saved companies and rosters**, with frozen labels | **$1.00** |
| Combined seven-profile full-chain confirmation | **$7.00** |
| Adjudication or one targeted repeat | **$1.00** |

Include dedupe in confirmation only after replaying the captured collision and a distinct-person counterexample.

**Cut additional provider/coverage experiments, a fresh route experiment, and full-chain Carta/Dental probes.** If words or speed disappoint, omit those changes from the combination. If nothing earns inclusion, save the confirmation money; another unchanged baseline is not progress.

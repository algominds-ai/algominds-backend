import { readFileSync, writeFileSync } from "node:fs";
import { ledger } from "../providers.mjs";

const HERE = new URL(".", import.meta.url).pathname;
const ROOT = new URL("../", import.meta.url).pathname;

const progress = readFileSync(`${HERE}progress.ndjson`, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const reference = JSON.parse(readFileSync(`${ROOT}ref/reference.json`, "utf8"));
const refByCompany = new Map(reference.companies.map((c) => [c.company, c]));

function scoreArm(picks, judgedMap, company) {
  const n = picks.length;
  const labels = picks.map((p) => judgedMap.get(p.id) ?? null);
  const positiveCount = labels.filter((l) => l?.label === "POSITIVE").length;
  const hardNegCount = labels.filter((l) => l?.label === "NEGATIVE" && l?.basis === "function_contradicts_intent").length;
  const basisMix = { explicit_persona_match: 0, inferred_workflow_owner: 0 };
  for (const p of picks) if (basisMix[p.basis] !== undefined) basisMix[p.basis]++;
  const ref = refByCompany.get(company);
  const R = ref?.R ?? [];
  const recall = R.length ? picks.filter((p) => R.includes(p.id)).length / R.length : null;
  return {
    n, precision: n ? positiveCount / n : null, hardNegRate: n ? hardNegCount / n : null,
    recall, basisMix, positiveCount, hardNegCount, unjudged: labels.filter((l) => l === null).length,
  };
}

function withLabels(picks, judgedMap) {
  return picks.map((p) => ({ ...p, label: judgedMap.get(p.id)?.label ?? "UNJUDGED", judgeBasis: judgedMap.get(p.id)?.basis ?? null }));
}

const results = [];
for (const row of progress) {
  const ref = refByCompany.get(row.company);
  const judgedMap = new Map((ref?.judged ?? []).map((j) => [j.id, j]));
  const a = scoreArm(row.arms.a.picks, judgedMap, row.company);
  const b = scoreArm(row.arms.b.picks, judgedMap, row.company);
  results.push({
    seller: row.seller, company: row.company,
    arms: {
      a: { picks: withLabels(row.arms.a.picks, judgedMap), ...a },
      b: { picks: withLabels(row.arms.b.picks, judgedMap), ...b },
    },
  });
}
writeFileSync(`${HERE}results.json`, JSON.stringify(results, null, 2));

function choose(n, k) {
  let r = 1;
  for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
  return r;
}
/** Two-sided exact sign-test p-value for k successes out of n discordant trials, p=0.5. */
function signTestP(k, n) {
  if (n === 0) return 1;
  const tail = Math.min(k, n - k);
  let p = 0;
  for (let i = 0; i <= tail; i++) p += choose(n, i) * 0.5 ** n;
  return Math.min(1, 2 * p);
}

function pairedCount(metricOf) {
  let bWins = 0, aWins = 0, ties = 0, undecidable = 0;
  for (const r of results) {
    const va = metricOf(r.arms.a), vb = metricOf(r.arms.b);
    if (va == null || vb == null) { undecidable++; continue; }
    if (vb > va) bWins++; else if (va > vb) aWins++; else ties++;
  }
  const n = bWins + aWins;
  const k = Math.max(bWins, aWins);
  return { bWins, aWins, ties, undecidable, discordant: n, p: signTestP(k, n),
    separable: n > 0 && ((bWins >= 6 && aWins === 0) || (aWins >= 6 && bWins === 0)) };
}

const precisionPaired = pairedCount((x) => x.precision);
const recallPaired = pairedCount((x) => x.recall);

const pooled = (arm) => {
  const withN = results.filter((r) => r.arms[arm].n > 0);
  const avg = (f) => withN.length ? withN.reduce((s, r) => s + f(r.arms[arm]), 0) / withN.length : null;
  const withRecall = results.filter((r) => r.arms[arm].recall != null);
  return {
    companiesWithPicks: withN.length,
    avgPrecision: avg((x) => x.precision),
    avgHardNegRate: avg((x) => x.hardNegRate),
    avgRecall: withRecall.length ? withRecall.reduce((s, r) => s + r.arms[arm].recall, 0) / withRecall.length : null,
    recallN: withRecall.length,
    basisMix: withN.reduce((acc, r) => {
      acc.explicit_persona_match += r.arms[arm].basisMix.explicit_persona_match;
      acc.inferred_workflow_owner += r.arms[arm].basisMix.inferred_workflow_owner;
      return acc;
    }, { explicit_persona_match: 0, inferred_workflow_owner: 0 }),
  };
};

console.log("POOLED a:", JSON.stringify(pooled("a")));
console.log("POOLED b:", JSON.stringify(pooled("b")));
console.log(`PAIRED precision: b beats a in ${precisionPaired.bWins}/20, a beats b in ${precisionPaired.aWins}/20, ties ${precisionPaired.ties}, p=${precisionPaired.p.toFixed(4)}, ${precisionPaired.separable ? "SEPARABLE" : "NOT SEPARABLE at n=20"}`);
console.log(`PAIRED recall vs R: b beats a in ${recallPaired.bWins}/20, a beats b in ${recallPaired.aWins}/20, ties ${recallPaired.ties}, p=${recallPaired.p.toFixed(4)}, ${recallPaired.separable ? "SEPARABLE" : "NOT SEPARABLE at n=20"}`);
console.log(`ledger ABL spent: $${ledger("ABL").spent().toFixed(4)}`);

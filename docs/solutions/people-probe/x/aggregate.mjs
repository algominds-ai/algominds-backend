import { readFileSync, existsSync } from "node:fs";
import { sizeBand } from "./common.mjs";
const HERE = new URL(".", import.meta.url).pathname;
const J = (p) => (existsSync(`${HERE}${p}`) ? JSON.parse(readFileSync(`${HERE}${p}`, "utf8")) : null);

const universe = J("ref/universe.json");
const reference = J("ref/reference.json");
const newJudged = J("ref/new-judged.json");
const gate = J("GATE/results.json");
const abl = J("ABL/results.json");
const byName = (arr) => Object.fromEntries((arr ?? []).map((c) => [c.company, c]));
const U = byName(universe?.companies), R = byName(reference?.companies), G = byName(gate), A = byName(abl?.companies ?? abl);
const spent = (agent) => { const f = `${HERE}ledger/${agent}.jsonl`; return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).reduce((s, l) => s + (JSON.parse(l).dollars ?? 0), 0) : 0; };

/** Labels for every candidate id at a company, from the reference. */
function labelsFor(company) {
  const m = new Map();
  for (const j of R[company]?.judged ?? []) m.set(j.id, j);
  return m;
}
const isPos = (l) => l?.label === "POSITIVE";
const isHardNeg = (l) => l?.label === "NEGATIVE" && l?.basis === "function_contradicts_intent";

/** Scores one pick list against the reference for a company. */
function score(company, picks) {
  const L = labelsFor(company), Rset = new Set(R[company]?.R ?? []);
  const labelled = picks.filter((p) => L.has(p.id));
  const pos = labelled.filter((p) => isPos(L.get(p.id))).length;
  const hard = labelled.filter((p) => isHardNeg(L.get(p.id))).length;
  const hit = picks.filter((p) => Rset.has(p.id)).length;
  return { picks: picks.length, labelled: labelled.length, precision: labelled.length ? pos / labelled.length : null,
    hardNegRate: labelled.length ? hard / labelled.length : null, recallR: Rset.size ? hit / Rset.size : null, Rsize: Rset.size };
}

const rows = [];
for (const c of universe?.companies ?? []) {
  const hc = c.headcount?.brightdata || c.headcount?.apollo || null;
  const r = R[c.company], g = G[c.company], a = A[c.company];
  const ver = r?.verified ?? [];
  rows.push({
    seller: c.seller, company: c.company, band: sizeBand(hc), headcount: hc, U: c.candidates.length,
    judgedPos: (r?.judged ?? []).filter(isPos).length, R: (r?.R ?? []).length,
    verified: ver.filter((v) => v.status === "verified").length, contradicted: ver.filter((v) => v.status === "contradicted").length,
    unknown: ver.filter((v) => v.status === "unknown").length, hooks: ver.filter((v) => v.status === "verified" && v.hook?.quote).length,
    ablA: a ? score(c.company, a.arms?.a?.picks ?? a.a?.picks ?? []) : null,
    ablB: a ? score(c.company, a.arms?.b?.picks ?? a.b?.picks ?? []) : null,
    gate: g ? { ...score(c.company, (g.selected ?? []).filter((p) => p.id != null)), new: g.round1?.new ?? g.new ?? 0, r2: g.round2?.ran ?? false, marginal: g.round2?.marginal ?? 0, dollars: g.dollars ?? 0 } : null,
  });
}

const fmt = (x, d = 0) => (x == null ? "  -  " : typeof x === "number" && !Number.isInteger(x) ? x.toFixed(d || 2) : String(x));
console.log("company                   band    hc     U   judgPos   R  verif contra unk hooks | ABL-a prec  recR | ABL-b prec  recR | GATE prec recR new r2/marg  $");
for (const r of rows) console.log(
  `${r.company.slice(0, 24).padEnd(25)} ${r.band.padEnd(7)} ${fmt(r.headcount).padStart(5)} ${String(r.U).padStart(5)} ${String(r.judgedPos).padStart(8)} ${String(r.R).padStart(4)} ${String(r.verified).padStart(5)} ${String(r.contradicted).padStart(6)} ${String(r.unknown).padStart(4)} ${String(r.hooks).padStart(5)} | ` +
  `${fmt(r.ablA?.precision).padStart(10)} ${fmt(r.ablA?.recallR).padStart(5)} | ${fmt(r.ablB?.precision).padStart(10)} ${fmt(r.ablB?.recallR).padStart(5)} | ` +
  `${fmt(r.gate?.precision).padStart(9)} ${fmt(r.gate?.recallR).padStart(5)} ${String(r.gate?.new ?? "-").padStart(3)} ${r.gate ? `${r.gate.r2 ? "y" : "n"}/${r.gate.marginal}` : "-"} ${fmt(r.gate?.dollars, 3)}`);

/** Paired sign test on a per-company metric: counts companies where b > a, a > b, ties. */
function paired(metricA, metricB, label) {
  let bWins = 0, aWins = 0, ties = 0;
  for (const r of rows) { const a = metricA(r), b = metricB(r); if (a == null || b == null) continue; if (b > a + 1e-9) bWins++; else if (a > b + 1e-9) aWins++; else ties++; }
  const n = bWins + aWins; const p = n ? 2 * Math.min(...[bWins, aWins].map((k) => { let s = 0; for (let i = 0; i <= k; i++) s += choose(n, i); return s / 2 ** n; })) : 1;
  console.log(`${label}: b>a ${bWins}, a>b ${aWins}, ties ${ties}  discordant n=${n}  two-sided sign p=${Math.min(1, p).toFixed(3)}  ${bWins >= 6 && aWins === 0 ? "SEPARATED (>=6-0)" : "not separable at n=20"}`);
}
const choose = (n, k) => { let r = 1; for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i; return r; };
console.log("\n=== PAIRED (pre-registered rule: >=6-0 discordant wins) ===");
paired((r) => r.ablA?.precision, (r) => r.ablB?.precision, "ABL precision  (a=raw ICP, b=ICP+rubric)");
paired((r) => r.ablA?.recallR, (r) => r.ablB?.recallR, "ABL recall vs R");
paired((r) => r.ablB?.recallR, (r) => r.gate?.recallR, "GATE vs ABL-b recall vs R (same selector, retrieval differs)");
paired((r) => r.ablB?.precision, (r) => r.gate?.precision, "GATE vs ABL-b precision");

const pool = (f) => { const v = rows.map(f).filter((x) => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
console.log("\n=== POOLED ===");
console.log(`ABL-a precision ${fmt(pool((r) => r.ablA?.precision))}  hardNeg ${fmt(pool((r) => r.ablA?.hardNegRate))}  recallR ${fmt(pool((r) => r.ablA?.recallR))}`);
console.log(`ABL-b precision ${fmt(pool((r) => r.ablB?.precision))}  hardNeg ${fmt(pool((r) => r.ablB?.hardNegRate))}  recallR ${fmt(pool((r) => r.ablB?.recallR))}`);
console.log(`GATE  precision ${fmt(pool((r) => r.gate?.precision))}  hardNeg ${fmt(pool((r) => r.gate?.hardNegRate))}  recallR ${fmt(pool((r) => r.gate?.recallR))}  new ${rows.reduce((s, r) => s + (r.gate?.new ?? 0), 0)}  round2 marginal ${rows.reduce((s, r) => s + (r.gate?.marginal ?? 0), 0)}`);
for (const b of ["<50", "50-499", "500+"]) { const rs = rows.filter((r) => r.band === b); const p = (f) => { const v = rs.map(f).filter((x) => x != null); return v.length ? (v.reduce((a, c) => a + c, 0) / v.length) : null; };
  console.log(`  band ${b.padEnd(7)} n=${rs.length}  R/company ${fmt(p((r) => r.R))}  verified/company ${fmt(p((r) => r.verified))}  ABL-a prec ${fmt(p((r) => r.ablA?.precision))}  ABL-b prec ${fmt(p((r) => r.ablB?.precision))}  GATE recR ${fmt(p((r) => r.gate?.recallR))}`); }
const verTot = rows.reduce((s, r) => s + r.verified, 0), hookTot = rows.reduce((s, r) => s + r.hooks, 0);
console.log(`\nverified buyers ${verTot}  with free web hook ${hookTot} (${verTot ? Math.round(100 * hookTot / verTot) : 0}%)  contradicted ${rows.reduce((s, r) => s + r.contradicted, 0)}  unknown ${rows.reduce((s, r) => s + r.unknown, 0)}`);
if (newJudged) { const nj = (newJudged.companies ?? newJudged).flatMap((c) => c.judged ?? []); console.log(`GATE new candidates judged: ${nj.length}, POSITIVE ${nj.filter(isPos).length}, verified ${(newJudged.companies ?? newJudged).flatMap((c) => c.verified ?? []).filter((v) => v.status === "verified").length}`); }
console.log("\n=== SPEND ==="); for (const a of ["REF", "JUDGE", "GATE", "ABL", "HOOK", "smoke"]) console.log(`${a.padEnd(6)} $${spent(a).toFixed(4)}`);
console.log(`TOTAL  $${["REF", "JUDGE", "GATE", "ABL", "HOOK", "smoke"].reduce((s, a) => s + spent(a), 0).toFixed(4)}`);

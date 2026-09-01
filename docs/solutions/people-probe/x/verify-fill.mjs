import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { ledger, MODEL_FAST } from "./providers.mjs";
import { verify } from "./verify.mjs";

const AGENT = "JUDGE2", CAP = 1.5, PER_COMPANY = 6;
const HERE = new URL(".", import.meta.url).pathname;
const L = ledger(AGENT);
const log = (s) => { console.log(s); appendFileSync(`${HERE}ref/fill.log`, `${new Date().toISOString().slice(11, 19)} ${s}\n`); };

const universe = JSON.parse(readFileSync(`${HERE}ref/universe.json`, "utf8"));
const refPath = `${HERE}ref/reference.json`;
const reference = JSON.parse(readFileSync(refPath, "utf8"));
const cand = Object.fromEntries(universe.companies.map((c) => [c.company, Object.fromEntries(c.candidates.map((x) => [x.id, x]))]));
const BAND_RANK = { founder: 0, owner: 0, "c-suite": 1, partner: 1, "board-member": 5, vp: 2, head: 3, director: 4, manager: 6 };
const rank = (c, id) => { const b = cand[c]?.[id]?.band ?? cand[c]?.[id]?.seniorityBand; return BAND_RANK[b] ?? 7; };

for (const co of reference.companies) {
  const positives = co.judged.filter((j) => j.label === "POSITIVE").map((j) => j.id);
  const done = new Set((co.verified ?? []).map((v) => v.id));
  const want = Math.min(PER_COMPANY, positives.length) - done.size;
  if (want <= 0) { log(`skip ${co.company}: ${done.size} verified already`); continue; }
  const todo = positives.filter((id) => !done.has(id)).sort((a, b) => rank(co.company, a) - rank(co.company, b)).slice(0, want);
  for (const id of todo) {
    if (L.spent() >= CAP) { log(`CAP reached at $${L.spent().toFixed(3)} before ${co.company} id ${id}`); break; }
    const p = cand[co.company]?.[id];
    if (!p || !p.name || !p.title) { log(`  ${co.company} id ${id}: no candidate record, skipped`); continue; }
    const v = await verify(AGENT, { name: p.name, title: p.title, company: co.company, url: p.url }, { model: MODEL_FAST });
    co.verified = [...(co.verified ?? []), { id, name: p.name, title: p.title, url: p.url ?? v.url, status: v.status, web: { v: v.web.v, why: v.web.why, empty: v.web.empty ?? false }, index: { v: v.index.v, why: v.index.why }, hook: v.hook ?? null, by: AGENT }];
    log(`  ${co.company.padEnd(24)} ${v.status.padEnd(12)} ${String(p.title).slice(0, 40).padEnd(42)} ${p.name}`);
  }
  co.R = (co.verified ?? []).filter((v) => v.status === "verified").map((v) => v.id);
  writeFileSync(refPath, JSON.stringify(reference, null, 1));
  log(`done ${co.company}: verified ${co.R.length}/${(co.verified ?? []).length}  spent $${L.spent().toFixed(3)}`);
  if (L.spent() >= CAP) break;
}
log(`FILL COMPLETE spent $${L.spent().toFixed(4)}`);

import { readFileSync, writeFileSync } from "node:fs";
import { identity, retrieve, select, verifyFirstParty, meter } from "./harness.mjs";

const icp = JSON.parse(readFileSync(process.argv[2] ?? "prof-aris.json","utf8"));
const icpText = (icp.doc?.description ?? icp.description ?? JSON.stringify(icp)).slice(0,2500);
const targets = JSON.parse(process.argv[3] ?? '[["Harbor IT","harborit.com"],["Cyber Salus","cybersalus.com"],["Ntiva","ntiva.com"],["Harbor IT WRONG DOMAIN","harbormsp.com"]]');

const out = [];
for (const [name, domain] of targets) {
  const t0 = Date.now();
  console.log(`\n=== ${name}  (${domain})`);

  const id = await identity(domain);
  if (!id.ok) { console.log(`   STAGE1 identity FAILED -> ${id.reason}`); out.push({name,domain,stopped:"identity",reason:id.reason}); continue; }
  console.log(`   STAGE1 identity ok    senior sample ${id.seniorSample}, employers seen: ${id.employers.join(" / ")}`);

  const { people, perBand } = await retrieve(domain);
  const bands = Object.entries(perBand).map(([b,v])=>`${b}:${v.error?"ERR":v.count}${v.capped?"*":""}`).join(" ");
  console.log(`   STAGE2 retrieve       ${people.length} distinct senior people   [${bands}]`);

  const { picked, observedTitles, chosenTitles } = await select(icpText, people);
  console.log(`   STAGE3 select         ${picked.length} buyers from ${observedTitles} observed titles`);
  console.log(`          titles chosen: ${chosenTitles.slice(0,6).join(" | ")}`);

  const checked = [];
  for (const p of picked.slice(0,8)) checked.push({ ...p, ...(await verifyFirstParty(p, domain)) });
  const v = checked.filter(c=>c.axis==="confirmed").length;
  console.log(`   STAGE4 verify         ${v}/${checked.length} confirmed on the company's own site`);
  for (const c of checked) console.log(`          [${c.axis.padEnd(8)}] ${String(c.title).slice(0,42).padEnd(44)} ${c.name}`);

  out.push({ name, domain, senior:people.length, observedTitles, buyers:picked.length, verified:v, checked:checked.length, seconds:((Date.now()-t0)/1000).toFixed(1), perBand });
}

console.log(`\n================ SUMMARY`);
console.log("company                buyers  verified  senior  titles  secs");
for (const r of out) {
  if (r.stopped) { console.log(`${r.name.padEnd(24)} STOPPED at ${r.stopped}: ${r.reason.slice(0,50)}`); continue; }
  console.log(`${r.name.padEnd(24)}${String(r.buyers).padStart(5)}${String(r.verified+"/"+r.checked).padStart(10)}${String(r.senior).padStart(8)}${String(r.observedTitles).padStart(8)}${String(r.seconds).padStart(7)}`);
}
console.log(`\nMETER  clay ${meter.clayRecords} records | exa $${meter.exaDollars.toFixed(4)} | llm $${meter.llmDollars.toFixed(4)}`);
writeFileSync("harness-run.json", JSON.stringify({ out, meter }, null, 1));

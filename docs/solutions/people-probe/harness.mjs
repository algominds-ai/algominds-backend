import { readFileSync } from "node:fs";
const env = Object.fromEntries(readFileSync("/Users/lahfir/Documents/Projects/Algominds/algo-backend/.env","utf8")
  .split("\n").filter(l=>l.includes("=")).map(l=>[l.slice(0,l.indexOf("=")), l.slice(l.indexOf("=")+1).trim()]));

export const meter = { clayRecords:0, exaDollars:0, llmDollars:0, calls:[] };
const note = (stage, what, n) => meter.calls.push({ stage, what, n });

const SENIOR_BANDS = ["founder","owner","board-member","partner","c-suite","vp","head","director"];

const CLAY = "https://api.clay.com/public/v0";
const CH = () => ({ "Content-Type":"application/json", "clay-api-key": env.CLAY_API_KEY });

async function clay(domain, bands) {
  const mk = await fetch(`${CLAY}/search/filters-mode`, { method:"POST", headers:CH(),
    body: JSON.stringify({ source_type:"people", filters:{ company_identifier:[domain],
      ...(bands ? { job_title_seniority_levels_v2: bands } : {}) } }) });
  const made = await mk.json();
  if (!mk.ok || !made.search_id) return { rows:[], error:`create ${mk.status}: ${JSON.stringify(made).slice(0,140)}` };
  let rows = [], hasMore = false;
  for (let page = 0; page < 6; page++) {
    const r = await fetch(`${CLAY}/search/filters-mode/${made.search_id}/run`, { method:"POST",
      headers:CH(), body: JSON.stringify({ limit: 500 }) });
    const b = await r.json();
    if (!r.ok) return { rows, error:`run ${r.status}: ${JSON.stringify(b).slice(0,140)}` };
    rows = rows.concat(b.data ?? []);
    hasMore = b.has_more ?? false;
    if (!hasMore) break;
  }
  meter.clayRecords += rows.length;
  return { rows, hasMore };
}

/** Stage 1. Confirms the domain names a real company with people, so a wrong domain fails loudly instead of returning nobody. */
export async function identity(domain) {
  const probe = await clay(domain, ["c-suite","vp","director"]);
  if (probe.error) return { ok:false, reason:`provider error: ${probe.error}` };
  note("identity", domain, probe.rows.length);
  if (probe.rows.length === 0) return { ok:false, reason:"no senior people at this domain: wrong domain, or the provider does not cover it" };
  const employers = [...new Set(probe.rows.map(p=>p.latest_experience_company).filter(Boolean))];
  return { ok:true, seniorSample: probe.rows.length, employers: employers.slice(0,3) };
}

/** Stage 2. Enumerates candidates one seniority band at a time, because a single unfiltered query silently caps at 499. */
export async function retrieve(domain, bands = SENIOR_BANDS) {
  const seen = new Map();
  const perBand = {};
  for (const b of bands) {
    const { rows, error } = await clay(domain, [b]);
    if (error) { perBand[b] = { error }; continue; }
    perBand[b] = { count: rows.length, capped: rows.length >= 500 };
    for (const p of rows) {
      const url = String(p.url ?? p.linkedin_url ?? "").toLowerCase()
        .replace(/^https?:\/\/([a-z]{2}\.)?/,"https://").replace(/[?#].*$/,"").replace(/\/$/,"");
      if (url && !seen.has(url)) seen.set(url, { name:p.name ?? p.full_name, title:p.latest_experience_title,
        company:p.latest_experience_company, url, band:b, location:p.location });
    }
  }
  note("retrieve", domain, seen.size);
  return { people:[...seen.values()], perBand };
}

/** Stage 3. The model returns candidate ids only, and code copies the title from the record, so no title can be invented or reworded. */
export async function select(icpText, people, model="openai/gpt-5.6-sol") {
  const roster = people.map((p, i) => ({ id: i, title: p.title, band: p.band }));
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method:"POST", headers:{ Authorization:`Bearer ${env.OPENROUTER_API_KEY}`, "content-type":"application/json" },
    body: JSON.stringify({ model, usage:{include:true}, messages:[{ role:"user", content:
`Ideal customer profile of the seller:
${icpText}

These are the people employed at one target company, each with an id and their real job title.
${roster.map(c=>`${c.id}\t${c.title}`).join("\n")}

Return the people who would own the budget or the decision for this purchase.
Mere involvement is not enough. Judge the role as it functions in this company, not by
keywords in the title. If nobody qualifies, return nothing.

Output one JSON object per line and nothing else:
{"id":<number>,"basis":"explicit_persona_match"}   the profile names this persona directly
{"id":<number>,"basis":"inferred_workflow_owner"}  the profile describes a workflow and this
                                                   person owns it, without naming the role` }] }),
  });
  const j = await r.json();
  meter.llmDollars += j?.usage?.cost ?? 0;
  const BASIS = ["explicit_persona_match", "inferred_workflow_owner"];
  const chosen = new Map();
  let unknownIds = 0;
  for (const line of (j?.choices?.[0]?.message?.content ?? "").split("\n")) {
    let row;
    try { row = JSON.parse(line.trim()); } catch { continue; }
    if (!Number.isInteger(row.id) || row.id < 0 || row.id >= people.length) { unknownIds++; continue; }
    chosen.set(row.id, BASIS.includes(row.basis) ? row.basis : "unrecognised");
  }
  const picked = people.map((p, i) => ({ ...p, basis: chosen.get(i) })).filter((_, i) => chosen.has(i));
  note("select", `${roster.length} candidates`, picked.length);
  return { picked, observedTitles:new Set(people.map(p=>p.title)).size, unknownIds };
}

/** Stage 4. Fetches the company's own pages, then asks the model to read them, because deciding whether a page confirms employment is comprehension rather than string matching. */
export async function verifyFirstParty(person, domain, model="openai/gpt-5.6-sol") {
  const r = await fetch("https://api.exa.ai/search", {
    method:"POST", headers:{ "x-api-key": env.EXA_API_KEY, "content-type":"application/json" },
    body: JSON.stringify({ query:`${person.name} ${person.title}`, includeDomains:[domain],
      numResults:3, type:"fast", contents:{ text:{ maxCharacters:3000 } } }),
  });
  if (!r.ok) return { axis:"unknown", why:`provider unavailable: exa ${r.status}` };
  const j = await r.json();
  meter.exaDollars += j?.costDollars?.total ?? 0;
  const pages = (j.results ?? []).filter(x => String(x.url).includes(domain));
  if (pages.length === 0) return { axis:"unknown", why:"no page found on the company's own domain" };
  const m = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method:"POST", headers:{ Authorization:`Bearer ${env.OPENROUTER_API_KEY}`, "content-type":"application/json" },
    body: JSON.stringify({ model, usage:{include:true}, messages:[{ role:"user", content:
`Pages published by ${domain}, the company's own website:

${pages.map(p=>`--- ${p.url}\n${(p.text ?? "").slice(0,2500)}`).join("\n\n")}

Claim to check: ${person.name} currently works at this company as ${person.title}.

Answer with exactly one word.
CONFIRMED    the pages state this person holds this or an equivalent role here now
CONTRADICTED the pages state something that conflicts with the claim
UNKNOWN      the pages do not settle it. Silence is UNKNOWN, never CONTRADICTED.` }] }),
  });
  const mj = await m.json();
  meter.llmDollars += mj?.usage?.cost ?? 0;
  const word = (mj?.choices?.[0]?.message?.content ?? "").trim().toUpperCase();
  const axis = ["CONFIRMED","CONTRADICTED"].includes(word) ? word.toLowerCase() : "unknown";
  return { axis, why:`${pages.length} first-party page(s) read`, pagesFound:pages.length };
}

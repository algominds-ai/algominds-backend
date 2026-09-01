import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";

const ENV = Object.fromEntries(
  readFileSync("/Users/lahfir/Documents/Projects/Algominds/algo-backend/.env", "utf8")
    .split("\n").filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).trim()]; }),
);
const HERE = new URL(".", import.meta.url).pathname;
mkdirSync(`${HERE}ledger`, { recursive: true });

/** Every paid or metered call banks here. One file per agent. Read x/ledger/<agent>.jsonl to audit. */
export function ledger(agent) {
  const file = `${HERE}ledger/${agent}.jsonl`;
  const bank = (row) => appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...row })}\n`);
  const spent = () => !existsSync(file) ? 0 : readFileSync(file, "utf8").split("\n").filter(Boolean)
    .reduce((s, l) => s + (JSON.parse(l).dollars ?? 0), 0);
  return { bank, spent, file };
}

const nap = (ms) => new Promise((r) => setTimeout(r, ms));
async function http(url, init, ms = 30000) {
  try {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { ok: r.ok, status: r.status, json, text };
  } catch (e) { return { ok: false, status: 0, json: null, text: String(e?.message ?? e) }; }
}

/** Canonical LinkedIn person URL: https://linkedin.com/in/<id>, lowercase, no query, no country subdomain. */
export function canonUrl(u) {
  const m = String(u ?? "").toLowerCase().match(/linkedin\.com\/in\/([^/?#]+)/);
  return m ? `https://linkedin.com/in/${m[1]}` : null;
}
export const linkedinId = (u) => canonUrl(u)?.split("/in/")[1] ?? null;

// ---------------------------------------------------------------- CLAY (annual quota; free)
const CLAY = "https://api.clay.com/public/v0";
const clayH = () => ({ "Content-Type": "application/json", "clay-api-key": ENV.CLAY_API_KEY });
export const CLAY_SENIOR_BANDS = ["founder", "owner", "board-member", "partner", "c-suite", "vp", "head", "director"];
export const CLAY_ALL_BANDS = [...CLAY_SENIOR_BANDS, "manager", "senior", "mid-level", "entry", "intern", "unknown"];

/**
 * Clay people search, two steps, paged. `identifier` is a domain or a LinkedIn company URL.
 * Returns { rows, quotaUsed, error }. One unfiltered query silently caps near 499, so callers
 * partition by seniority band. has_more is meaningless and is not exposed.
 */
export async function clay(agent, identifier, { bands = null, keywords = null, maxPages = 5 } = {}) {
  const L = ledger(agent);
  const filters = { company_identifier: [identifier] };
  if (bands) filters.job_title_seniority_levels_v2 = bands;
  if (keywords) filters.job_title_keywords = keywords;
  const mk = await http(`${CLAY}/search/filters-mode`, { method: "POST", headers: clayH(), body: JSON.stringify({ source_type: "people", filters }) });
  if (!mk.ok || !mk.json?.search_id) return { rows: [], quotaUsed: 0, error: `clay create ${mk.status}: ${mk.text.slice(0, 160)}` };
  let rows = [], q0 = null, q1 = null;
  for (let p = 0; p < maxPages; p++) {
    const r = await http(`${CLAY}/search/filters-mode/${mk.json.search_id}/run`, { method: "POST", headers: clayH(), body: JSON.stringify({ limit: 500 }) }, 60000);
    if (!r.ok) return { rows, quotaUsed: 0, error: `clay run ${r.status}: ${r.text.slice(0, 160)}` };
    rows = rows.concat(r.json?.data ?? []);
    q0 ??= r.json?.period_quota?.used; q1 = r.json?.period_quota?.used;
    if (!r.json?.has_more) break;
  }
  const quotaUsed = q0 != null && q1 != null ? Math.max(q1 - q0, rows.length) : rows.length;
  L.bank({ provider: "clay", dollars: 0, records: rows.length, quotaUsed, note: `${identifier} ${bands?.join("+") ?? "all"} ${keywords?.join("|") ?? ""}` });
  return { rows: rows.map(clayRow), quotaUsed, error: null };
}
function clayRow(p) {
  return { name: p.name ?? null, title: p.latest_experience_title ?? null, company: p.latest_experience_company ?? null,
    url: canonUrl(p.url), location: p.location ?? null, since: p.latest_experience_start_date ?? null, src: "clay" };
}

// -------------------------------------------------------------- APOLLO (free tier; obfuscated surnames)
export const APOLLO_SENIORITIES = ["owner", "founder", "c_suite", "partner", "vp", "head", "director", "manager", "senior", "entry", "intern"];
/** Apollo people search by domain plus seniority and department filters. Never pass named titles. total_entries is top-level. */
export async function apollo(agent, domain, { seniorities = null, departments = null, perPage = 25, page = 1 } = {}) {
  const L = ledger(agent);
  const body = { q_organization_domains_list: [domain], per_page: perPage, page };
  if (seniorities) body.person_seniorities = seniorities;
  if (departments) body.person_departments = departments;
  const r = await http("https://api.apollo.io/api/v1/mixed_people/api_search", { method: "POST",
    headers: { "x-api-key": ENV.APOLLO_API_KEY, "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) return { total: null, rows: [], error: `apollo ${r.status}: ${r.text.slice(0, 120)}` };
  L.bank({ provider: "apollo", dollars: 0, records: (r.json.people ?? []).length, note: `${domain} ${seniorities?.join("+") ?? ""} ${departments?.join("+") ?? ""}` });
  return { total: r.json.total_entries ?? null, error: null,
    rows: (r.json.people ?? []).map((p) => ({ name: [p.first_name, p.last_name].filter(Boolean).join(" ") || null, firstName: p.first_name ?? null,
      lastNameObfuscated: p.last_name_obfuscated ?? null, title: p.title ?? null, company: p.organization?.name ?? null,
      url: canonUrl(p.linkedin_url), seniority: p.seniority ?? null, departments: p.departments ?? null, src: "apollo" })) };
}

// -------------------------------------------------------------------- EXA (metered; cost read from response)
const exaH = () => ({ "x-api-key": ENV.EXA_API_KEY, "content-type": "application/json" });
/** Exa people index. Structured workHistory with dates; an open-ended row (dates.to === null) is the current role. */
export async function exaPeople(agent, query, { numResults = 10 } = {}) {
  const L = ledger(agent);
  const r = await http("https://api.exa.ai/search", { method: "POST", headers: exaH(), body: JSON.stringify({ query, category: "people", type: "fast", numResults }) });
  if (!r.ok) return { rows: [], error: `exa ${r.status}: ${r.text.slice(0, 120)}` };
  const dollars = r.json?.costDollars?.total ?? 0.007;
  L.bank({ provider: "exa-people", dollars, records: (r.json.results ?? []).length, note: query.slice(0, 80) });
  const rows = (r.json.results ?? []).flatMap((res) => (res.entities ?? []).filter((e) => e.type === "person").map((e) => {
    const p = e.properties ?? {}; const cur = (p.workHistory ?? []).find((w) => w.dates && w.dates.to === null);
    return { name: p.name ?? res.title ?? null, title: cur?.title ?? null, company: cur?.company?.name ?? null, companyId: cur?.company?.id ?? null,
      url: canonUrl(res.url), location: p.location ?? null, since: cur?.dates?.from ?? null, workHistory: p.workHistory ?? [], src: "exa" };
  }));
  return { rows, error: null, dollars };
}
/** Exa web search. includeDomains restricts which PAGES may answer; it does not filter employment. */
export async function exaWeb(agent, query, { includeDomains = null, numResults = 5, maxCharacters = 2000 } = {}) {
  const L = ledger(agent);
  const body = { query, type: "fast", numResults, contents: { text: { maxCharacters } } };
  if (includeDomains) body.includeDomains = includeDomains;
  const r = await http("https://api.exa.ai/search", { method: "POST", headers: exaH(), body: JSON.stringify(body) });
  if (!r.ok) return { pages: [], error: `exa ${r.status}: ${r.text.slice(0, 120)}` };
  const dollars = r.json?.costDollars?.total ?? 0.007;
  L.bank({ provider: "exa-web", dollars, records: (r.json.results ?? []).length, note: query.slice(0, 80) });
  return { pages: (r.json.results ?? []).map((x) => ({ url: x.url, title: x.title ?? null, publishedDate: x.publishedDate ?? null, text: x.text ?? "" })), error: null, dollars };
}
/**
 * Exa agent run: multi-step web research with a JSON output schema. Starts, then polls until
 * completed. effort "low" measured ~$0.025. Returns { structured, dollars, error }.
 */
export async function exaAgent(agent, query, outputSchema, { effort = "low", systemPrompt = null, timeoutMs = 240000 } = {}) {
  const L = ledger(agent);
  const body = { query, outputSchema, effort, dataSources: [{ provider: "fiber" }] };
  if (systemPrompt) body.systemPrompt = systemPrompt;
  const s = await http("https://api.exa.ai/agent/runs", { method: "POST", headers: exaH(), body: JSON.stringify(body) });
  if (!s.ok || !s.json?.id) return { structured: null, dollars: 0, error: `exa agent start ${s.status}: ${s.text.slice(0, 160)}` };
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await nap(5000);
    const g = await http(`https://api.exa.ai/agent/runs/${s.json.id}`, { headers: exaH() });
    const run = g.json;
    if (!run) continue;
    if (["failed", "cancelled", "canceled", "error"].includes(run.status)) return { structured: null, dollars: run.costDollars?.total ?? 0, error: `exa agent ${run.status}` };
    if (run.status === "completed" && run.output?.structured != null && run.costDollars) {
      const dollars = run.costDollars.total ?? 0;
      L.bank({ provider: "exa-agent", dollars, records: 1, note: `${effort} ${query.slice(0, 60)}` });
      return { structured: run.output.structured, dollars, error: null, runId: s.json.id };
    }
  }
  return { structured: null, dollars: 0, error: "exa agent timeout: UNKNOWN, not empty" };
}

// ----------------------------------------------------------- BRIGHTDATA (collected LinkedIn dataset; $2.50 CPM)
const BD = "https://api.brightdata.com/datasets/search/gd_l1viktl72bvl7bjuj0";
const bdH = () => ({ Authorization: `Bearer ${ENV.BRIGHTDATA_API_TOKEN}`, "Content-Type": "application/json" });
/** One person's collected LinkedIn row by profile URL: activity (posts), experience, row timestamp. Serialise calls; a hang is UNKNOWN. */
export async function brightdataByUrl(agent, linkedinUrl) {
  const L = ledger(agent);
  const id = linkedinId(linkedinUrl);
  if (!id) return { row: null, error: "no linkedin id" };
  for (const filter of [{ name: "linkedin_id", operator: "=", value: id }, { name: "url", operator: "includes", value: `/in/${id}` }]) {
    const r = await http(BD, { method: "POST", headers: bdH(), body: JSON.stringify({ size: 1, filter }) }, 25000);
    if (r.status === 0) return { row: null, error: "brightdata timeout: UNKNOWN" };
    if (!r.ok) return { row: null, error: `brightdata ${r.status}: ${r.text.slice(0, 100)}` };
    const hit = r.json?.hits?.[0];
    if (hit) { L.bank({ provider: "brightdata", dollars: 0.0025, records: 1, note: id }); return { row: hit, error: null, totalHits: r.json.total_hits }; }
  }
  return { row: null, error: null, totalHits: 0 };
}
/** Headcount signal: total_hits for a company slug. size 1 so it costs one record. */
export async function brightdataCount(agent, companySlug) {
  const L = ledger(agent);
  const r = await http(BD, { method: "POST", headers: bdH(), body: JSON.stringify({ size: 1, filter: { name: "current_company_company_id", operator: "=", value: companySlug } }) }, 25000);
  if (r.status === 0) return { total: null, error: "brightdata timeout: UNKNOWN" };
  if (!r.ok) return { total: null, error: `brightdata ${r.status}` };
  if ((r.json?.total_hits ?? 0) > 0) L.bank({ provider: "brightdata", dollars: 0.0025, records: 1, note: `count ${companySlug}` });
  return { total: r.json?.total_hits ?? 0, error: null };
}

// ----------------------------------------------------------------- LLM via OpenRouter (usage.cost banked)
export const MODEL_STRONG = "openai/gpt-5.6-sol";
export const MODEL_FAST = "openai/gpt-4o-mini";
/** Chat completion. Pass json:true to request a JSON object response. Returns { text, dollars, error }. */
export async function llm(agent, messages, { model = MODEL_STRONG, json = false, maxTokens = 4000 } = {}) {
  const L = ledger(agent);
  const body = { model, messages, usage: { include: true }, max_tokens: maxTokens };
  if (json) body.response_format = { type: "json_object" };
  const r = await http("https://openrouter.ai/api/v1/chat/completions", { method: "POST",
    headers: { Authorization: `Bearer ${ENV.OPENROUTER_API_KEY}`, "content-type": "application/json" }, body: JSON.stringify(body) }, 120000);
  if (!r.ok) return { text: "", dollars: 0, error: `openrouter ${r.status}: ${r.text.slice(0, 120)}` };
  const dollars = r.json?.usage?.cost ?? 0;
  L.bank({ provider: `llm:${model}`, dollars, records: 1, note: String(messages.at(-1)?.content ?? "").slice(0, 60) });
  return { text: r.json?.choices?.[0]?.message?.content ?? "", dollars, error: null };
}

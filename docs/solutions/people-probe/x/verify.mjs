import { exaPeople, exaWeb, llm, MODEL_STRONG } from "./providers.mjs";
import { nameKey } from "./common.mjs";

const RULE = `Return ONLY a JSON object: {"verdict":"CONFIRMED"|"CONTRADICTED"|"UNKNOWN","hook_quote":string|null,"hook_url":string|null,"hook_date":string|null}
verdict: CONFIRMED the evidence shows this person holds this or an equivalent senior role at this company now;
CONTRADICTED the evidence shows they do not, or hold a different employer now;
UNKNOWN the evidence does not settle it. Silence is UNKNOWN, never CONTRADICTED.
hook_quote: the ONE sentence from the pages, copied verbatim, most useful for opening an outreach message to this
person (something they said, did, launched, hired for, or were quoted on). null if nothing usable. hook_url is the
page it came from, hook_date its published date if shown.`;
const parse = (t) => { try { const j = JSON.parse(String(t).replace(/^```json|```$/g, "").trim()); const v = String(j.verdict ?? "").toUpperCase();
  return { v: ["CONFIRMED", "CONTRADICTED"].includes(v) ? v : "UNKNOWN", hook: j.hook_quote ? { quote: String(j.hook_quote).slice(0, 300), url: j.hook_url ?? null, date: j.hook_date ?? null } : null }; }
  catch { return { v: "UNKNOWN", hook: null }; } };

/** B: open web read by the model. Press, funding news, podcasts and conference pages all count. */
export async function verifyWeb(agent, p, { model = MODEL_STRONG } = {}) {
  const w = await exaWeb(agent, `"${p.name}" ${p.title} ${p.company}`, { numResults: 6, maxCharacters: 1500 });
  if (w.error) return { v: "UNKNOWN", why: w.error };
  if (!w.pages.length) return { v: "UNKNOWN", why: "no web results" };
  const prompt = `Web pages about this person:\n\n${w.pages.map((x) => `--- ${x.url} (${x.publishedDate ?? "no date"})\n${x.text.slice(0, 1200)}`).join("\n\n")}\n\nClaim: ${p.name} currently works at ${p.company} as ${p.title}.\n\n${RULE}`;
  const a = await llm(agent, [{ role: "user", content: prompt }], { model, json: true, maxTokens: 1500 });
  const r = a.error || !a.text.trim() ? { v: "UNKNOWN", hook: null, empty: !a.error } : parse(a.text);
  return { v: r.v, hook: r.hook, pages: w.pages.map((x) => ({ url: x.url, date: x.publishedDate })), why: a.error ?? `${w.pages.length} web pages read` };
}

/** C: Exa's structured people index. Deterministic: an open-ended workHistory row whose employer matches. */
export async function verifyIndex(agent, p, { numResults = 10 } = {}) {
  const r = await exaPeople(agent, `${p.title} at "${p.company}"`, { numResults });
  if (r.error) return { v: "UNKNOWN", why: r.error };
  const me = r.rows.find((x) => nameKey(x.name) === nameKey(p.name));
  if (!me) return { v: "UNKNOWN", why: `not among ${r.rows.length} indexed people` };
  if (!me.company) return { v: "UNKNOWN", why: "no open-ended role" };
  const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 2);
  const same = norm(me.company).some((w) => norm(p.company).includes(w));
  return { v: same ? "CONFIRMED" : "CONTRADICTED", why: `index says current employer ${me.company}`, indexedTitle: me.title, indexedUrl: me.url };
}

/**
 * Two independent sources must agree. Measured: 8/12 real confirmed, 0/6 controls wrongly
 * confirmed, and it caught a departed employee that the web alone confirmed. Cost ~ $0.03.
 */
export async function verify(agent, p, opts = {}) {
  const [b, c] = await Promise.all([verifyWeb(agent, p, opts), verifyIndex(agent, p, opts)]);
  const status = b.v === "CONFIRMED" && c.v === "CONFIRMED" ? "verified"
    : b.v === "CONTRADICTED" || c.v === "CONTRADICTED" ? "contradicted" : "unknown";
  return { status, web: b, index: c, url: p.url ?? c.indexedUrl ?? null, hook: b.hook ?? null };
}

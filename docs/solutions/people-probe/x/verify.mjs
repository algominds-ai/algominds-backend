import { exaPeople, exaWeb, llm, MODEL_STRONG } from "./providers.mjs";
import { nameKey } from "./common.mjs";

const RULE = `Answer with exactly one word.
CONFIRMED    the evidence shows this person holds this or an equivalent senior role at this company now
CONTRADICTED the evidence shows they do not, or hold a different employer now
UNKNOWN      the evidence does not settle it. Silence is UNKNOWN, never CONTRADICTED.`;
const verdict = (t) => { const w = String(t).toUpperCase(); return ["CONFIRMED", "CONTRADICTED"].find((v) => w.includes(v)) ?? "UNKNOWN"; };

/** B: open web read by the model. Press, funding news, podcasts and conference pages all count. */
export async function verifyWeb(agent, p, { model = MODEL_STRONG } = {}) {
  const w = await exaWeb(agent, `"${p.name}" ${p.title} ${p.company}`, { numResults: 6, maxCharacters: 1500 });
  if (w.error) return { v: "UNKNOWN", why: w.error };
  if (!w.pages.length) return { v: "UNKNOWN", why: "no web results" };
  const prompt = `Web pages about this person:\n\n${w.pages.map((x) => `--- ${x.url} (${x.publishedDate ?? "no date"})\n${x.text.slice(0, 1200)}`).join("\n\n")}\n\nClaim: ${p.name} currently works at ${p.company} as ${p.title}.\n\n${RULE}`;
  const a = await llm(agent, [{ role: "user", content: prompt }], { model, maxTokens: 10 });
  return { v: a.error ? "UNKNOWN" : verdict(a.text), why: a.error ?? `${w.pages.length} web pages read` };
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
  return { status, web: b, index: c, url: p.url ?? c.indexedUrl ?? null };
}

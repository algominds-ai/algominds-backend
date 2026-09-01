import { canonUrl } from "./providers.mjs";

const CREDENTIAL = new Set(["mba", "pmp", "cissp", "cpa", "phd", "mha", "cptm", "cfa", "jd", "md", "cism", "cisa", "ccie", "cpp", "shrm", "sphr", "phr"]);
/** first|last name key with credential tokens and punctuation removed, so "Mary Hart, MHA" and "MHA Mary Hart" match. Exact-match identity only; ambiguity is the model's job. */
export function nameKey(name) {
  const t = String(name ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .split(",")[0].replace(/[^a-z ]/g, " ").split(/\s+/).filter((w) => w && !CREDENTIAL.has(w) && w.length > 1);
  return t.length ? `${t[0]}|${t[t.length - 1]}` : null;
}

/** Merges candidate rows from any providers. Canonical LinkedIn URL wins; a row without a URL merges by name key. Records every provider that saw each person. */
export function dedupe(rows) {
  const byUrl = new Map(), byName = new Map();
  for (const r of rows) {
    const u = canonUrl(r.url), k = nameKey(r.name);
    const existing = (u && byUrl.get(u)) || (k && byName.get(k));
    if (existing) {
      existing.seenBy = [...new Set([...existing.seenBy, r.src])];
      existing.title ??= r.title; existing.url ??= u; existing.company ??= r.company;
      if (!existing.name || (r.name && r.name.length > existing.name.length && !r.lastNameObfuscated)) existing.name = r.name;
      continue;
    }
    const row = { ...r, url: u, seenBy: [r.src] };
    if (u) byUrl.set(u, row);
    if (k) byName.set(k, row);
  }
  return [...new Set([...byUrl.values(), ...byName.values()])].map((r, i) => ({ id: i, ...r }));
}

/** Size band used for reporting. */
export const sizeBand = (n) => n == null ? "unknown" : n < 50 ? "<50" : n < 500 ? "50-499" : "500+";

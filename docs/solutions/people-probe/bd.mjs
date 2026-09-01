import { readFileSync, writeFileSync } from "node:fs";
const T = readFileSync("/Users/lahfir/Documents/Projects/Algominds/algo-backend/.env","utf8")
  .split("\n").find(l=>l.startsWith("BRIGHTDATA_API_TOKEN=")).split("=")[1].trim();
const H = { Authorization:`Bearer ${T}`, "Content-Type":"application/json" };
const DS = "gd_l1viktl72bvl7bjuj0";
const nap = ms => new Promise(r=>setTimeout(r,ms));

const LOCK = "/tmp/bd-slots";
function slots() {
  try { return require("node:fs").readdirSync(LOCK).length; } catch { return 0; }
}

/**
 * Runs one dataset filter to completion and returns its rows. Retries the
 * account-wide `too_many_parallel_jobs` refusal with backoff and jitter, because
 * the vendor caps how many filter snapshots may build at once.
 */
export async function bdFilter(filter, limit = 1000) {
  const t0 = Date.now();
  let snapshot_id = null;
  for (let a = 0; a < 40 && !snapshot_id; a++) {
    const r = await fetch("https://api.brightdata.com/datasets/filter", {
      method: "POST", headers: H,
      body: JSON.stringify({ dataset_id: DS, records_limit: limit, filter }),
    });
    const body = await r.text();
    if (body.includes("too_many_parallel_jobs")) { await nap(15000 + Math.random() * 20000); continue; }
    try { snapshot_id = JSON.parse(body).snapshot_id ?? null; } catch { }
    if (!snapshot_id) { await nap(8000); }
  }
  if (!snapshot_id) return { rows: [], cost: 0, error: "no snapshot after retries", ms: Date.now() - t0 };
  let meta;
  for (let i = 0; i < 200; i++) {
    meta = await (await fetch(`https://api.brightdata.com/datasets/snapshot/${snapshot_id}`, { headers: H })).json();
    if (meta.status === "ready") break;
    if (meta.status === "failed") return { rows: [], cost: 0, error: "failed", ms: Date.now() - t0, snapshot_id };
    await nap(5000);
  }
  if (meta.status !== "ready") return { rows: [], cost: 0, error: `stuck:${meta.status}`, ms: Date.now() - t0, snapshot_id };
  const dl = await fetch(`https://api.brightdata.com/datasets/snapshot/${snapshot_id}/download?format=json`, { headers: H });
  const body = await dl.text();
  let rows = [];
  try { const j = JSON.parse(body); rows = Array.isArray(j) ? j : [j]; } catch { }
  return { rows, cost: meta.cost ?? 0, size: meta.dataset_size, ms: Date.now() - t0, snapshot_id };
}

const PRESENT = (v) => v === "Present" || v === "present";
const MASKED = (t) => !t || /^[*\s]+$/.test(t) || t.length < 2;

/**
 * Current job title at the given company slug, or null. Handles both shapes the
 * dataset uses: a single-role entry whose end_date is the string "Present" and whose
 * title is the job, and a multi-role entry whose title is the company name and whose
 * positions[] each carry their own end_date.
 */
export function currentTitleAt(person, slugs) {
  const want = new Set(Array.isArray(slugs) ? slugs : [slugs]);
  for (const e of person.experience ?? []) {
    if (!want.has(e.company_id)) continue;
    const positions = e.positions ?? [];
    if (positions.length > 0) {
      const cur = positions.find((p) => PRESENT(p.end_date));
      if (cur && !MASKED(cur.title)) return { title: cur.title, meta: cur.meta ?? null, start: cur.start_date ?? null, via: "positions" };
      continue;
    }
    if (PRESENT(e.end_date) && !MASKED(e.title)) return { title: e.title, meta: e.duration ?? null, start: e.start_date ?? null, via: "entry" };
  }
  return null;
}

/** Every company_id the person's experience mentions, so sibling and acquired brands can be discovered rather than guessed. */
export function slugsSeen(rows) {
  const c = new Map();
  for (const p of rows) for (const e of p.experience ?? []) if (e.company_id) c.set(e.company_id, (c.get(e.company_id) ?? 0) + 1);
  return [...c.entries()].sort((a, b) => b[1] - a[1]);
}

/**
 * Real-time Elasticsearch query against the collected dataset. Returns every
 * matching row by following the search_after cursor, plus total_hits, which is
 * the true match count and is free to read without paging.
 */
export async function bdSearch(filter, max = 1000, size = 100) {
  const rows = [];
  let after = null, total = null, calls = 0;
  const t0 = Date.now();
  while (rows.length < max) {
    const body = { size, sort: "default", filter, ...(after ? { search_after: after } : {}) };
    const r = await fetch(`https://api.brightdata.com/datasets/search/${DS}`, {
      method: "POST", headers: H, body: JSON.stringify(body),
    });
    const text = await r.text();
    if (!r.ok) {
      if (r.status === 429) { await nap(20000); continue; }
      return { rows, total, calls, ms: Date.now() - t0, error: text.slice(0, 200) };
    }
    let j; try { j = JSON.parse(text); } catch { return { rows, total, calls, ms: Date.now() - t0, error: "bad json" }; }
    calls++;
    total ??= j.total_hits;
    rows.push(...(j.hits ?? []));
    after = j.search_after;
    if (!after || (j.hits ?? []).length === 0) break;
  }
  return { rows, total, calls, ms: Date.now() - t0, cost: 0 };
}

/** total_hits for a filter without paging any rows. One call, no data transferred. */
export async function bdCount(filter) {
  const r = await fetch(`https://api.brightdata.com/datasets/search/${DS}`, {
    method: "POST", headers: H, body: JSON.stringify({ size: 1, filter }),
  });
  if (!r.ok) return null;
  return (await r.json()).total_hits ?? null;
}

import { CLAY_SENIOR_BANDS, CLAY_ALL_BANDS, APOLLO_SENIORITIES } from "./providers.mjs";

export const APOLLO_DEPARTMENTS = ["c_suite", "product_management", "engineering_technical", "operations", "human_resources",
  "finance", "sales", "marketing", "legal", "consulting", "information_technology", "data_science", "education", "master_engineering_technical"];
export const PERSONA_BASIS = ["explicit_persona_match", "inferred_workflow_owner"];

/**
 * Validates a front-gate plan against closed sets. Anything outside a set is dropped and
 * counted in `rejected`, so an invented band or department fails closed instead of
 * becoming a provider call that returns nobody.
 */
export function validatePlan(raw) {
  const rejected = [];
  const keep = (arr, set, what) => (Array.isArray(arr) ? arr : []).filter((v) => {
    const ok = set.includes(v); if (!ok) rejected.push(`${what}:${v}`); return ok;
  });
  const personas = (Array.isArray(raw?.personas) ? raw.personas : []).map((p) => ({
    name: String(p?.name ?? "").slice(0, 80),
    basis: PERSONA_BASIS.includes(p?.basis) ? p.basis : (rejected.push(`basis:${p?.basis}`), "explicit_persona_match"),
  })).filter((p) => p.name);
  const clayBands = keep(raw?.clay?.bands, CLAY_ALL_BANDS, "clay.band");
  const clayKeywords = (Array.isArray(raw?.clay?.keywords) ? raw.clay.keywords : []).map((k) => String(k).slice(0, 40)).slice(0, 8);
  const apolloSeniorities = keep(raw?.apollo?.seniorities, APOLLO_SENIORITIES, "apollo.seniority");
  const apolloDepartments = keep(raw?.apollo?.departments, APOLLO_DEPARTMENTS, "apollo.department");
  const exaQueries = (Array.isArray(raw?.exa?.queries) ? raw.exa.queries : []).map((q) => String(q).slice(0, 200)).filter(Boolean).slice(0, 4);
  const exaAgent = raw?.exaAgent === true;
  const why = typeof raw?.why === "string" ? raw.why.slice(0, 400) : "";
  return {
    personas, why,
    clay: clayBands.length ? { bands: clayBands, keywords: clayKeywords.length ? clayKeywords : null } : null,
    apollo: apolloSeniorities.length ? { seniorities: apolloSeniorities, departments: apolloDepartments.length ? apolloDepartments : null } : null,
    exa: exaQueries.length ? { queries: exaQueries } : null,
    exaAgent, rejected,
  };
}

export const PLAN_INSTRUCTIONS = `Return ONLY a JSON object with this exact shape. Every value must come from the allowed sets.
{
  "personas": [ { "name": "<who buys, e.g. owner of the onboarding funnel>", "basis": "explicit_persona_match" | "inferred_workflow_owner" } ],
  "why": "<one or two sentences: which providers you call and why, and which you skip to avoid paying twice for the same slice>",
  "clay":   { "bands": [ subset of ${JSON.stringify(CLAY_SENIOR_BANDS)} plus optionally "manager" ], "keywords": [ up to 8 title words ] } | null,
  "apollo": { "seniorities": [ subset of ${JSON.stringify(APOLLO_SENIORITIES)} ], "departments": [ subset of ${JSON.stringify(APOLLO_DEPARTMENTS)} ] } | null,
  "exa":    { "queries": [ up to 4 people-search strings such as "head of onboarding at \\"Company\\"" ] } | null,
  "exaAgent": true | false   (true only when you expect the structured indexes to be thin: small or obscure company; costs ~$0.03)
}
Do not ask two providers for the same slice. Clay already covers senior bands completely and is free; use Apollo for departments Clay's bands cannot express, Exa for a persona whose title vocabulary is unusual, and the agent only for thin companies.`;

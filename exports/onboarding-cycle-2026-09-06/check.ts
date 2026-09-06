import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AccountProfile } from "./account-profile";

const read = (name: string) => JSON.parse(readFileSync(new URL(name, import.meta.url), "utf8"));
const selected = process.argv.slice(2);
const batches = selected.length ? selected : ["final-controls", "real-accounts"];
assert.ok(batches.every(name => ["final-controls", "real-accounts"].includes(name)));
const inputs = batches.flatMap(name => read(`${name}-inputs.json`));
const profiles = new Map<string, ReturnType<typeof AccountProfile.parse>>();
for (const input of inputs) {
  const row = read(`${input.id}.json`);
  assert.equal(row.status, "complete", input.id);
  if (input.arm === "baseline") continue;
  const profile = AccountProfile.parse(row.output);
  assert.deepEqual(profile, row.output, `${input.id}: unexpected fields stripped`);
  assert.equal(profile.seller.domain, input.domain);
  assert.ok(profile.seller.sourceUrls.every(url => input.pages.some((page: {url: string}) => page.url === url)));
  profiles.set(input.id, profile);
}

if (batches.includes("final-controls")) {
const original = profiles.get("original-final")!.icp;
const signals = original.requirements.find(group => group.anyOf.length === 5)!;
assert.equal(signals.kind, "required", "Ondato requires at least one signal");
assert.deepEqual(signals.anyOf.flatMap(alt => alt.allOf.map(c => c.window?.amount ?? null)), [12, 6, 12, null, 120]);
const compliance = profiles.get("compliance-control-final")!.icp;
assert.ok(compliance.requirements.some(group => group.kind === "required" && group.anyOf.length === 1 && group.anyOf[0].allOf.length === 2), "Funding AND revenue must survive");
const composite = profiles.get("deel-composite-final")!.icp;
assert.equal(composite.buyer, null, "A hiring signal does not specify the buyer");
const alternatives = composite.requirements.find(group => group.kind === "preferred")!.anyOf;
assert.deepEqual(alternatives.map(alt => alt.allOf.map(c => c.window?.amount)), [[90, 180], [60]]);
const domainOnly = profiles.get("snyk-domain-only-final")!.icp;
assert.equal(domainOnly.offer, null);
assert.equal(domainOnly.buyer, null);
assert.equal(domainOnly.requirements.length, 0);
assert.ok(domainOnly.unknowns.length > 0);
}
if (batches.includes("real-accounts")) {
assert.match(profiles.get("form3-candidate-final")!.icp.offer!, /Trust Fabric/);
assert.match(profiles.get("aris-candidate-final")!.icp.buyer!, /recruit/i);
}

// Prototype semantics only; not an implementation of production company validation.
type Truth = "pass" | "fail" | "unknown";
const and = (values: Truth[]): Truth => values.includes("fail") ? "fail" : values.includes("unknown") ? "unknown" : "pass";
const or = (values: Truth[]): Truth => values.includes("pass") ? "pass" : values.includes("unknown") ? "unknown" : "fail";
const group = (values: Truth[][]) => or(values.map(and));
assert.equal(group([["pass", "fail"], ["fail"]]), "fail");
assert.equal(group([["pass", "unknown"], ["fail"]]), "unknown");
assert.equal(group([["pass", "pass"], ["unknown"]]), "pass");
assert.equal(group([["unknown", "unknown"], ["pass"]]), "pass");
console.log(JSON.stringify({batches, candidateProfiles: profiles.size, completedOutputs: inputs.length, result: "pass", scope: "schema, source membership, selected semantic regressions, Boolean truth examples; not full fidelity or prospect quality"}, null, 2));

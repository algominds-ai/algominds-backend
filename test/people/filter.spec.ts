import { describe, expect, it } from "vitest";
import { resolveBuyer } from "@/core/people/buyer";
import {
	coverage,
	filterCandidates,
	groupCandidates,
} from "@/core/people/filter";
import { researchRequest, researchSubjects } from "@/core/people/research";
import { bareCompany, verifyCandidate } from "./support";

const candidates = [0, 1, 2].map((id) =>
	verifyCandidate(
		id,
		`Person ${id}`,
		"CTO & Co-founder",
		`https://linkedin.com/in/person-${id}`,
	),
);
const person = {
	id: 0,
	decision: "unresolved",
	identityStatus: "unresolved",
	currentEmployerStatus: "unresolved",
	currentRoleStatus: "unresolved",
	buyerFit: "unresolved",
	reason: "Owner",
	name: "Person",
	title: "Co-founder",
	linkedinUrl: "https://linkedin.com/in/person",
	roleEvidence: null,
};

describe("people batch coverage", () => {
	it("keeps missing and duplicate preliminary decisions for research", () => {
		const result = filterCandidates(candidates, {
			decisions: [
				{ id: 0, keep: false, reason: "Clear exclusion", band: "other" },
				{ id: 1, keep: false, reason: "Uncertain", band: "other" },
				{ id: 1, keep: true, reason: "Owner", band: "owner" },
			],
		});
		expect(result.candidates.map((row) => row.id)).toEqual([1, 2]);
		expect(result.completeness.missing).toEqual([2]);
		expect(result.completeness.duplicated).toEqual([1]);
	});
	it("does not apply a preliminary rejection from a foreign batch", () => {
		const result = filterCandidates(candidates, {
			decisions: [
				{ id: 0, keep: false, reason: "No", band: "other" },
				{ id: 9, keep: false, reason: "Foreign", band: "other" },
			],
		});
		expect(result.candidates).toHaveLength(3);
		expect(result.assignments.map((row) => row.id)).toEqual([0]);
		expect(filterCandidates(candidates, null).candidates).toHaveLength(3);
	});
	it("does not carry a foreign band into another slice's missing assignment", () => {
		const first = filterCandidates(candidates.slice(0, 1), {
			decisions: [
				{ id: 0, keep: true, reason: "Owner", band: "owners" },
				{ id: 1, keep: true, reason: "Foreign", band: "heads" },
			],
		});
		const second = filterCandidates(candidates.slice(1), null);
		const groups = groupCandidates(candidates, [
			...first.assignments,
			...second.assignments,
		]);
		expect(groups.map((group) => group.map((row) => row.id))).toEqual([
			[0],
			[1, 2],
		]);
	});
	it("keeps missing and ambiguous band assignments without admitting foreign candidates", () => {
		const groups = groupCandidates(candidates, [
			{ id: 0, keep: true, reason: "Owner", band: " Owners " },
			{ id: 1, keep: true, reason: "Conflicting", band: "owners" },
			{ id: 1, keep: true, reason: "Conflicting", band: "heads" },
			{ id: 9, keep: true, reason: "Foreign", band: "owners" },
		]);
		expect(groups.map((group) => group.map((row) => row.id))).toEqual([
			[0],
			[1, 2],
		]);
		expect(groupCandidates(candidates, []).flat()).toEqual(candidates);
	});
	it("never accepts duplicate or foreign research IDs and reports missing subjects", () => {
		const result = researchSubjects(candidates, {
			people: [person, person, { ...person, id: 9 }, { ...person, id: 1 }],
		});
		expect(result.people.map((row) => row.id)).toEqual([1]);
		expect(result.completeness).toEqual(
			coverage(candidates, [{ id: 0 }, { id: 0 }, { id: 9 }, { id: 1 }]),
		);
		expect(result.completeness.missing).toEqual([2]);
	});
	it("retains every subject and the buyer context in a medium request", () => {
		const request = researchRequest({
			company: bareCompany("example.com"),
			buyer: resolveBuyer({ target: "Founder/CEO", profile: null }),
			candidates,
		});
		expect(request.effort).toBe("medium");
		expect(request.input?.data).toHaveLength(3);
		expect(request.systemPrompt).toContain("founder OR CEO");
	});
});

import { expect, it } from "vitest";
import { resolveBuyer } from "@/core/people/buyer";
import {
	type ResearchPerson,
	researchRequest,
	researchSubjects,
} from "@/core/people/research";
import { bareCompany, verifyCandidate } from "./support";

const candidate = verifyCandidate(
	0,
	"Alex Doe",
	"Founder",
	"https://linkedin.com/in/old-alex",
);
const verified: ResearchPerson = {
	id: 0,
	decision: "verified",
	identityStatus: "supported",
	currentEmployerStatus: "supported",
	currentRoleStatus: "supported",
	buyerFit: "direct",
	reason:
		"Current profile and employer evidence establish this person and qualifying responsibilities",
	name: "Alex Doe",
	title: "Founder and CTO",
	linkedinUrl: "https://linkedin.com/in/alex",
	roleEvidence: {
		url: "https://example.com/team",
		quote: "Alex Doe leads our engineering team as Founder and CTO.",
	},
};

it("asks the medium agent for a final decision under the complete buyer context", () => {
	const buyer = resolveBuyer({
		target:
			"Founder OR CTO with engineering ownership; exclude advisory-only roles",
		profile: null,
	});
	const request = researchRequest({
		company: bareCompany("example.com"),
		buyer,
		candidates: [candidate],
	});
	expect(request.effort).toBe("medium");
	expect(request.input?.data).toEqual([candidate]);
	expect(request.query).toContain(JSON.stringify(buyer));
	expect(request.query).toContain("direct or adjacent fit");
	expect(request.systemPrompt).toContain("Otherwise return unresolved");
	expect(request.systemPrompt).toContain("naming THIS person");
	expect(JSON.stringify(request.outputSchema)).toContain(
		'"enum":["verified","rejected","unresolved"]',
	);
	expect(JSON.stringify(request.outputSchema)).toContain('"roleEvidence"');
});

it("keeps an agent-verified correction and normalizes the returned profile URL", () => {
	const result = researchSubjects([candidate], {
		people: [
			{
				...verified,
				linkedinUrl: "https://www.linkedin.com/in/alex/?trk=search",
			},
		],
	});
	expect(result.people).toEqual([verified]);
	expect(result.malformed).toBe(0);
});

it("retains completed rejections and unresolved decisions without inventing verified fields", () => {
	for (const decision of ["rejected", "unresolved"]) {
		const result = researchSubjects([candidate], {
			people: [
				{
					...verified,
					decision,
					currentEmployerStatus:
						decision === "rejected" ? "contradicted" : "unresolved",
					name: null,
					title: null,
					linkedinUrl: null,
					roleEvidence: null,
				},
			],
		});
		expect(result.people[0]?.decision).toBe(decision);
		expect(result.malformed).toBe(0);
	}
});

it("leaves malformed final decisions unprocessed while retaining valid batch siblings", () => {
	const other = { ...candidate, id: 1 };
	const malformed = {
		...verified,
		id: 1,
		roleEvidence: { url: "file:///tmp/proof", quote: "Local text" },
	};
	const result = researchSubjects([candidate, other], {
		people: [verified, malformed],
	});
	expect(result.people.map((person) => person.id)).toEqual([0]);
	expect(result.malformed).toBe(1);
});

it("requires verified person fields and populated role evidence", () => {
	for (const fields of [
		{ name: null },
		{ title: null },
		{ linkedinUrl: null },
		{ roleEvidence: null },
		{ linkedinUrl: "https://linkedin.com.evil.test/in/alex" },
		{ roleEvidence: { url: "https://example.com/team", quote: "   " } },
		{
			roleEvidence: {
				url: "https://user:password@example.com/team",
				quote: "Role evidence",
			},
		},
	]) {
		const result = researchSubjects([candidate], {
			people: [{ ...verified, ...fields }],
		});
		expect(result.people).toEqual([]);
		expect(result.malformed).toBe(1);
	}
});

it("accepts a current professional profile as role evidence without requiring a second publisher", () => {
	for (const url of [
		"https://www.linkedin.com/in/alex/?trk=search",
		"https://linkedin.com/in/alex/details/experience/",
	]) {
		const result = researchSubjects([candidate], {
			people: [
				{
					...verified,
					roleEvidence: { url, quote: "Alex Doe, Founder and CTO at Example." },
				},
			],
		});
		expect(result.people).toHaveLength(1);
		expect(result.malformed).toBe(0);
	}
});

it("rejects duplicate and foreign IDs even when the attached final decision is verified", () => {
	const result = researchSubjects([candidate, { ...candidate, id: 1 }], {
		people: [verified, verified, { ...verified, id: 99 }],
	});
	expect(result.people).toEqual([]);
	expect(result.completeness).toMatchObject({
		missing: [1],
		duplicated: [0],
		foreign: [99],
	});
});
